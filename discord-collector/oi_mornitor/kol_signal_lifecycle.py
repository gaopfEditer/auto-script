"""KOL 二次预警信号有效期：TTL 内未入场作废；入场后 SL/TP 命中作废。"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from oi_mornitor.backtest_trade_config import OI_BT_SLIPPAGE_PCT
from oi_mornitor.env_parse import env_float
from oi_mornitor.oi_entry_filter import bars_from_ohlcv_rows
from oi_mornitor.pattern_entry import resolve_backtest_entry_price
from oi_mornitor.pattern_settle_profile import build_settle_plan

_INTERVAL_MS: dict[str, int] = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
}

_TERMINAL = frozenset({"ignored_expired", "ignored_sl", "ignored_tp"})


def signal_ttl_hours() -> float:
    h = env_float("KOL_SIGNAL_TTL_HOURS", 4.0, min_val=4.0, max_val=168.0)
    return max(4.0, float(h))


def entry_slippage_pct() -> float:
    return env_float("KOL_ENTRY_SLIPPAGE_PCT", OI_BT_SLIPPAGE_PCT, min_val=0.0, max_val=5.0)


def normalize_trade_side(side: str) -> str:
    s = str(side or "").lower()
    if s in ("short", "bear"):
        return "short"
    return "long"


def _ms_to_iso(ms: int | float) -> str:
    return datetime.fromtimestamp(float(ms) / 1000.0, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def expires_at_ms(fired_at_ms: int | float, *, ttl_hours: float | None = None) -> int:
    ttl = signal_ttl_hours() if ttl_hours is None else max(4.0, float(ttl_hours))
    return int(float(fired_at_ms) + ttl * 3600_000)


def find_bar_index_by_open_time(bars: Sequence[Mapping[str, Any]], open_ts: int | float) -> int | None:
    target = int(open_ts)
    for i, b in enumerate(bars):
        if int(float(b.get("open_time") or 0)) == target:
            return i
    return None


def _invalid_level(signal_bar: Mapping[str, Any], side: str) -> float:
    if side == "short":
        return float(signal_bar["high"])
    return float(signal_bar["low"])


def _plan_prices(
    *,
    symbol: str,
    side: str,
    entry: float,
    signal_bar: Mapping[str, Any],
    interval: str,
    signal_at_ms: int,
) -> dict[str, float | None]:
    stub: dict[str, Any] = {
        "side": side,
        "entry": entry,
        "tradeSymbol": symbol,
        "symbol": symbol,
        "signalAt": signal_at_ms,
        "interval": interval,
        "typeLabel": "KOL二次预警",
        "invalid_level": _invalid_level(signal_bar, side),
    }
    try:
        plan = build_settle_plan(stub)
        return {"sl_price": plan.sl_price, "tp1_price": plan.tp1_price, "tp2_price": plan.tp2_price}
    except ValueError:
        return {"sl_price": None, "tp1_price": None, "tp2_price": None}


def _sl_tp_on_bar(
    *,
    side: str,
    sl: float,
    tp1: float,
    bar: Mapping[str, Any],
) -> str | None:
    """单根 K 线内先判 SL 再 TP1（对齐 pattern_settle 顺序）。"""
    h = float(bar["high"])
    l = float(bar["low"])
    is_short = side == "short"
    if is_short:
        if h >= sl:
            return "ignored_sl"
        if l <= tp1:
            return "ignored_tp"
    else:
        if l <= sl:
            return "ignored_sl"
        if h >= tp1:
            return "ignored_tp"
    return None


def enrich_alert_lifecycle(alert: Mapping[str, Any], *, fired_at_ms: int | float | None = None) -> dict[str, Any]:
    """为初次 webhook 附加 TTL / 入场计划字段。"""
    out = dict(alert)
    fired = int(fired_at_ms if fired_at_ms is not None else datetime.now(timezone.utc).timestamp() * 1000)
    ttl = signal_ttl_hours()
    exp_ms = expires_at_ms(fired, ttl_hours=ttl)
    tf = str(out.get("tf") or "15m").lower()
    bar_ts = int(float(out.get("bar_ts") or 0))
    iv_ms = _INTERVAL_MS.get(tf, 900_000)
    side = normalize_trade_side(str(out.get("side") or "long"))
    out["lifecycle"] = {
        "status": "active_waiting_entry",
        "entry_mode": "next_bar_open",
        "alert_fired_at": _ms_to_iso(fired),
        "expires_at": _ms_to_iso(exp_ms),
        "ttl_hours": ttl,
        "entry_bar_open_ms": bar_ts + iv_ms if bar_ts else None,
        "side": side,
    }
    out["expires_at"] = out["lifecycle"]["expires_at"]
    out["ttl_hours"] = ttl
    return out


def new_lifecycle_record(alert: Mapping[str, Any], *, fired_at_ms: int | float | None = None) -> dict[str, Any]:
    enriched = enrich_alert_lifecycle(alert, fired_at_ms=fired_at_ms)
    lc = enriched["lifecycle"]
    return {
        "dedupe_key": str(enriched.get("dedupe_key") or alert_key_from_alert(enriched)),
        "symbol": enriched.get("symbol"),
        "tf": enriched.get("tf"),
        "pattern": enriched.get("pattern"),
        "bar_ts": enriched.get("bar_ts"),
        "side": lc["side"],
        "abnormal_volume": dict(enriched.get("abnormal_volume") or {}),
        "ema144": dict(enriched.get("ema144") or {}),
        "status": "active_waiting_entry",
        "entry_mode": "next_bar_open",
        "alert_fired_at_ms": int(
            datetime.fromisoformat(lc["alert_fired_at"].replace("Z", "+00:00")).timestamp() * 1000
        ),
        "expires_at_ms": int(
            datetime.fromisoformat(lc["expires_at"].replace("Z", "+00:00")).timestamp() * 1000
        ),
        "ttl_hours": lc["ttl_hours"],
        "entry_bar_open_ms": lc.get("entry_bar_open_ms"),
        "entry_price": None,
        "sl_price": None,
        "tp1_price": None,
        "entered_at_ms": None,
        "ignored_at_ms": None,
    }


def alert_key_from_alert(alert: Mapping[str, Any]) -> str:
    from oi_mornitor.kol_secondary_alert import alert_key

    return alert_key(
        str(alert["symbol"]),
        str(alert.get("tf") or "15m"),
        str(alert.get("pattern") or ""),
        int(float(alert.get("bar_ts") or 0)),
    )


def is_terminal_status(status: str) -> bool:
    return str(status) in _TERMINAL


def advance_lifecycle_record(
    record: dict[str, Any],
    bars: Sequence[Mapping[str, Any]],
    *,
    now_ms: int | float | None = None,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """推进一步生命周期；若刚进入终态则返回 status 事件（供本地日志，默认不 webhook）。"""
    rec = dict(record)
    status = str(rec.get("status") or "")
    if is_terminal_status(status):
        return rec, None

    now = int(now_ms if now_ms is not None else datetime.now(timezone.utc).timestamp() * 1000)
    exp = int(rec.get("expires_at_ms") or 0)
    bar_ts = int(float(rec.get("bar_ts") or 0))
    side = normalize_trade_side(str(rec.get("side") or "long"))
    symbol = str(rec.get("symbol") or "")
    tf = str(rec.get("tf") or "15m")

    if status == "active_waiting_entry" and now >= exp:
        return _mark_terminal(rec, "ignored_expired", now), _status_event(rec, "ignored_expired", now)

    sig_idx = find_bar_index_by_open_time(bars, bar_ts)
    if sig_idx is None:
        return rec, None

    signal_bar = bars[sig_idx]
    entry_idx = sig_idx + 1

    if len(bars) <= entry_idx:
        return rec, None

    entry_bar = bars[entry_idx]
    entry_open_ms = int(float(entry_bar.get("open_time") or 0))
    rec["entry_bar_open_ms"] = entry_open_ms

    if status == "active_waiting_entry":
        if entry_open_ms > exp:
            return _mark_terminal(rec, "ignored_expired", now), _status_event(rec, "ignored_expired", now)
        if now < entry_open_ms:
            return rec, None

        entry = resolve_backtest_entry_price(
            side=side,
            signal_bar_close=float(signal_bar["close"]),
            next_bar_open=float(entry_bar["open"]),
            slippage_pct=entry_slippage_pct(),
        )
        signal_at_ms = int(float(signal_bar.get("close_time") or entry_open_ms - 1))
        prices = _plan_prices(
            symbol=symbol,
            side=side,
            entry=entry,
            signal_bar=signal_bar,
            interval=tf,
            signal_at_ms=signal_at_ms,
        )
        rec.update(
            {
                "status": "active_entered",
                "entry_price": entry,
                "sl_price": prices["sl_price"],
                "tp1_price": prices["tp1_price"],
                "entered_at_ms": entry_open_ms,
            }
        )
        status = "active_entered"

    if status == "active_entered":
        sl = rec.get("sl_price")
        tp1 = rec.get("tp1_price")
        if sl is None or tp1 is None:
            return rec, None
        sl_f = float(sl)
        tp1_f = float(tp1)
        for i in range(entry_idx + 1, len(bars)):
            bar = bars[i]
            bar_open = int(float(bar.get("open_time") or 0))
            if bar_open > now:
                break
            hit = _sl_tp_on_bar(side=side, sl=sl_f, tp1=tp1_f, bar=bar)
            if hit:
                return _mark_terminal(rec, hit, now), _status_event(rec, hit, now)

    return rec, None


def _mark_terminal(rec: dict[str, Any], status: str, now_ms: int) -> dict[str, Any]:
    out = dict(rec)
    out["status"] = status
    out["ignored_at_ms"] = now_ms
    return out


def _status_event(rec: dict[str, Any], status: str, now_ms: int) -> dict[str, Any]:
    return {
        "type": "kol_secondary_lifecycle",
        "dedupe_key": rec.get("dedupe_key"),
        "symbol": rec.get("symbol"),
        "tf": rec.get("tf"),
        "pattern": rec.get("pattern"),
        "lifecycle_status": status,
        "ignored_at": _ms_to_iso(now_ms),
        "entry_price": rec.get("entry_price"),
        "sl_price": rec.get("sl_price"),
        "tp1_price": rec.get("tp1_price"),
    }


def bars_for_lifecycle(kline_rows: Sequence[Sequence[Any]]) -> list[dict[str, float]]:
    return bars_from_ohlcv_rows(kline_rows)


__all__ = [
    "advance_lifecycle_record",
    "bars_for_lifecycle",
    "enrich_alert_lifecycle",
    "expires_at_ms",
    "find_bar_index_by_open_time",
    "is_terminal_status",
    "new_lifecycle_record",
    "normalize_trade_side",
    "signal_ttl_hours",
]
