"""Card-level OHLC replay: MFE, MAE, drawdown before peak MFE, TP/SL outcome."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Protocol, Sequence

from post_card.config import BACKTEST_MAX_HORIZON_SEC
from post_card.schema import TradeCard


class OhlcBar(Protocol):
    ts: int
    open: float
    high: float
    low: float
    close: float


@dataclass
class BacktestResult:
    outcome: str
    entry_price: float | None
    max_favorable_pct: float | None
    max_adverse_pct: float | None
    drawdown_before_max_favorable_pct: float | None
    max_favorable_at_ms: int | None
    max_adverse_at_ms: int | None
    hit_tp_at_ms: int | None
    hit_sl_at_ms: int | None
    completed_at_ms: int | None
    bars_used: int
    extra: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "outcome": self.outcome,
            "entryPrice": self.entry_price,
            "maxFavorablePct": self.max_favorable_pct,
            "maxAdversePct": self.max_adverse_pct,
            "drawdownBeforeMaxFavorablePct": self.drawdown_before_max_favorable_pct,
            "maxFavorableAtMs": self.max_favorable_at_ms,
            "maxAdverseAtMs": self.max_adverse_at_ms,
            "hitTpAtMs": self.hit_tp_at_ms,
            "hitSlAtMs": self.hit_sl_at_ms,
            "completedAtMs": self.completed_at_ms,
            "barsUsed": self.bars_used,
            **self.extra,
        }


PriceProvider = Callable[[str, int, int], Sequence[dict[str, Any]]]


def _parse_price(raw: str | float | None) -> float | None:
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw) if raw > 0 else None
    import re

    s = str(raw).strip()
    if not s or re.search(r"市[价價]|market", s, re.I):
        return None
    m = re.search(r"([\d.]+)", s)
    if not m:
        return None
    try:
        n = float(m.group(1))
        return n if n > 0 else None
    except ValueError:
        return None


def _first_tp_price(card: TradeCard) -> float | None:
    raw = card.take_profit or ""
    for part in raw.replace("—", "-").replace("，", ",").split(","):
        for sub in part.split("/"):
            p = _parse_price(sub.strip())
            if p:
                return p
    return _parse_price(raw)


def _favorable_pct(is_long: bool, entry: float, high: float, low: float) -> float:
    if is_long:
        return (high - entry) / entry * 100.0
    return (entry - low) / entry * 100.0


def _adverse_pct(is_long: bool, entry: float, high: float, low: float) -> float:
    if is_long:
        return (entry - low) / entry * 100.0
    return (high - entry) / entry * 100.0


def run_backtest(
    card: TradeCard,
    bars: Sequence[dict[str, Any]],
    *,
    horizon_sec: int = BACKTEST_MAX_HORIZON_SEC,
    entry_override: float | None = None,
) -> BacktestResult:
    if card.direction not in ("long", "short"):
        return BacktestResult(
            "invalid_direction",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            0,
            {},
        )

    sorted_bars = sorted(bars, key=lambda b: int(b.get("ts") or 0))
    if not sorted_bars:
        return BacktestResult("no_bars", None, None, None, None, None, None, None, None, None, 0, {})

    is_long = card.direction == "long"
    entry = entry_override or _parse_price(card.entry)
    if entry is None:
        entry = float(sorted_bars[0].get("open") or sorted_bars[0].get("close") or 0)
    if entry <= 0:
        return BacktestResult("missing_entry", None, None, None, None, None, None, None, None, None, 0, {})

    start_ms = int(card.opened_at.timestamp() * 1000) if card.opened_at else int(sorted_bars[0]["ts"])
    end_ms = start_ms + horizon_sec * 1000

    sl = _parse_price(card.stop_loss)
    tp = _first_tp_price(card)

    window = [b for b in sorted_bars if start_ms <= int(b.get("ts") or 0) <= end_ms]
    if not window:
        window = list(sorted_bars)

    max_fav = -1.0
    max_adv = -1.0
    max_fav_ms: int | None = None
    max_adv_ms: int | None = None
    fav_series: list[float] = []
    adv_series: list[float] = []

    hit_tp_ms: int | None = None
    hit_sl_ms: int | None = None

    for b in window:
        ts = int(b.get("ts") or 0)
        high = float(b.get("high") or b.get("close") or 0)
        low = float(b.get("low") or b.get("close") or 0)
        fav = _favorable_pct(is_long, entry, high, low)
        adv = _adverse_pct(is_long, entry, high, low)
        fav_series.append(fav)
        adv_series.append(adv)
        if fav > max_fav:
            max_fav = fav
            max_fav_ms = ts
        if adv > max_adv:
            max_adv = adv
            max_adv_ms = ts

        if sl is not None and hit_sl_ms is None:
            sl_hit = (not is_long and high >= sl) or (is_long and low <= sl)
            if sl_hit:
                hit_sl_ms = ts
        if tp is not None and hit_tp_ms is None:
            tp_hit = (not is_long and low <= tp) or (is_long and high >= tp)
            if tp_hit:
                hit_tp_ms = ts

    peak_idx = 0
    for i, fav in enumerate(fav_series):
        if fav >= max_fav:
            peak_idx = i
            break

    dd_before_peak = max(adv_series[: peak_idx + 1]) if adv_series else 0.0

    outcome = "timeout"
    completed_ms: int | None = int(window[-1]["ts"]) if window else None
    if hit_tp_ms is not None and hit_sl_ms is not None:
        if hit_tp_ms == hit_sl_ms:
            outcome = "both_ambiguous"
        elif hit_tp_ms < hit_sl_ms:
            outcome = "hit_tp"
            completed_ms = hit_tp_ms
        else:
            outcome = "hit_sl"
            completed_ms = hit_sl_ms
    elif hit_tp_ms is not None:
        outcome = "hit_tp"
        completed_ms = hit_tp_ms
    elif hit_sl_ms is not None:
        outcome = "hit_sl"
        completed_ms = hit_sl_ms

    return BacktestResult(
        outcome=outcome,
        entry_price=entry,
        max_favorable_pct=round(max_fav, 6) if max_fav >= 0 else None,
        max_adverse_pct=round(max_adv, 6) if max_adv >= 0 else None,
        drawdown_before_max_favorable_pct=round(dd_before_peak, 6),
        max_favorable_at_ms=max_fav_ms,
        max_adverse_at_ms=max_adv_ms,
        hit_tp_at_ms=hit_tp_ms,
        hit_sl_at_ms=hit_sl_ms,
        completed_at_ms=completed_ms,
        bars_used=len(window),
        extra={},
    )


def fetch_bars_binance(symbol: str, start_ms: int, end_ms: int) -> list[dict[str, Any]]:
    """Optional live provider; may fail with HTTP 451 in some regions."""
    import json
    import urllib.parse
    import urllib.request

    sym = symbol.upper()
    if not sym.endswith("USDT"):
        sym += "USDT"
    params = urllib.parse.urlencode(
        {
            "symbol": sym,
            "interval": "1m",
            "startTime": start_ms,
            "endTime": end_ms,
            "limit": 1000,
        }
    )
    url = f"https://api.binance.com/api/v3/klines?{params}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        raw = json.loads(resp.read().decode())
    out: list[dict[str, Any]] = []
    for row in raw:
        out.append(
            {
                "ts": int(row[0]),
                "open": float(row[1]),
                "high": float(row[2]),
                "low": float(row[3]),
                "close": float(row[4]),
            }
        )
    return out
