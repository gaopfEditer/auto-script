"""量价信号 → 形态 ticker alert（仅 ticker，不进 TG / 胜率库）。"""
from __future__ import annotations

import time
from typing import Any

import pandas as pd

from oi_mornitor.strategy.candle_signals import closed_bar_index
from oi_mornitor.volume_price.signals import VolumePriceSignal, generate_signals

MIN_SCORE = 0.75
SIGNAL_TF = "15m"

_VP_TYPE_LABELS: dict[tuple[str, str, str], tuple[str, str]] = {
    ("continuation", "thrust", "long"): ("vp_cont_thrust", "量价推进·多"),
    ("continuation", "thrust", "short"): ("vp_cont_thrust", "量价推进·空"),
    ("continuation", "confirm", "long"): ("vp_cont_confirm", "量价确认·多"),
    ("continuation", "confirm", "short"): ("vp_cont_confirm", "量价确认·空"),
    ("reversal", "climax", "long"): ("vp_rev_climax", "高潮反转·多"),
    ("reversal", "climax", "short"): ("vp_rev_climax", "高潮反转·空"),
    ("reversal", "effort_no_result", "long"): ("vp_rev_effort", "努力无果反转·多"),
    ("reversal", "effort_no_result", "short"): ("vp_rev_effort", "努力无果反转·空"),
}


def _klines_to_rows(
    klines_map: dict[str, list[list[Any]]],
    *,
    tf: str,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for sym, klines in (klines_map or {}).items():
        symbol = str(sym or "").strip().upper()
        if not symbol:
            continue
        for k in klines or []:
            if not isinstance(k, (list, tuple)) or len(k) < 7:
                continue
            try:
                rows.append(
                    {
                        "ts": int(k[0]),
                        "close_time": int(k[6]),
                        "symbol": symbol,
                        "tf": tf,
                        "open": float(k[1]),
                        "high": float(k[2]),
                        "low": float(k[3]),
                        "close": float(k[4]),
                        "volume": float(k[5]),
                    }
                )
            except (TypeError, ValueError):
                continue
    return rows


def klines_map_to_vp_df(
    klines_map_15m: dict[str, list[list[Any]]],
    *,
    klines_map_1h: dict[str, list[list[Any]]] | None = None,
) -> pd.DataFrame:
    """Binance K 线 batch → 量价模块 DataFrame（15m 信号 + 1h 趋势过滤）。"""
    rows = _klines_to_rows(klines_map_15m, tf=SIGNAL_TF)
    if klines_map_1h:
        rows.extend(_klines_to_rows(klines_map_1h, tf="1h"))
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    return df.sort_values(["symbol", "tf", "ts"]).reset_index(drop=True)


def _resolve_vp_type(sig: VolumePriceSignal) -> tuple[str, str] | None:
    side = str(sig.side or "").lower()
    if sig.kind == "continuation":
        key = (sig.kind, str(sig.bar_class or ""), side)
    elif sig.kind == "reversal":
        reason = str(sig.reason or "")
        setup = None
        if "climax" in reason:
            setup = "climax"
        elif "effort_no_result" in reason:
            setup = "effort_no_result"
        if not setup:
            return None
        key = (sig.kind, setup, side)
    else:
        return None
    return _VP_TYPE_LABELS.get(key)


def volume_price_signal_to_alert(
    sig: VolumePriceSignal,
    *,
    kline_close_time: int,
    scan_ts: float,
) -> dict[str, Any] | None:
    resolved = _resolve_vp_type(sig)
    if not resolved:
        return None
    typ, type_label = resolved
    if sig.observation_only:
        type_label = f"{type_label}（观察）"
    side = "long" if str(sig.side).lower() == "long" else "short"
    return {
        "symbol": sig.symbol,
        "type": typ,
        "type_label": type_label,
        "side": side,
        "interval": sig.tf,
        "kind": sig.bar_class,
        "score": float(sig.score),
        "observation_only": bool(sig.observation_only),
        "entry_hint": float(sig.entry_hint),
        "invalid_level": float(sig.invalid_level),
        "price": float(sig.entry_hint),
        "close": float(sig.entry_hint),
        "message": sig.reason,
        "status_label": type_label,
        "kline_close_time": int(kline_close_time),
        "kline_open_time": int(sig.ts),
        "scan_ts": scan_ts,
    }


def scan_volume_price_ticker_alerts(
    klines_map_15m: dict[str, list[list[Any]]],
    *,
    klines_map_1h: dict[str, list[list[Any]]] | None = None,
    scan_ts: float | None = None,
    now_ms: int | None = None,
) -> list[dict[str, Any]]:
    """watchlist 15m K 线上扫描量价信号，仅返回最后一根已收盘柱、score≥0.75。"""
    if not klines_map_15m:
        return []

    df = klines_map_to_vp_df(klines_map_15m, klines_map_1h=klines_map_1h)
    if df.empty:
        return []

    signals, _enriched = generate_signals(df, signal_tfs=(SIGNAL_TF,))
    if not signals:
        return []

    now = int(now_ms if now_ms is not None else time.time() * 1000)
    ts_val = scan_ts if scan_ts is not None else time.time()

    close_time_by_index: dict[tuple[str, str, int], int] = {}
    closed_index_by_sym: dict[str, int] = {}
    for sym, chunk in df[df["tf"] == SIGNAL_TF].groupby("symbol", sort=False):
        chunk = chunk.reset_index(drop=True)
        closed_idx = closed_bar_index(chunk, now_ms=now)
        closed_index_by_sym[str(sym)] = closed_idx
        for i, row in chunk.iterrows():
            close_time_by_index[(str(sym), SIGNAL_TF, int(i))] = int(
                row.get("close_time") or row["ts"]
            )

    picked: dict[str, VolumePriceSignal] = {}
    for sig in signals:
        if sig.tf != SIGNAL_TF or float(sig.score) < MIN_SCORE:
            continue
        sym = str(sig.symbol)
        closed_idx = closed_index_by_sym.get(sym, -1)
        if closed_idx < 0 or int(sig.signal_bar_index) != closed_idx:
            continue
        prev = picked.get(sym)
        if prev is None or float(sig.score) > float(prev.score):
            picked[sym] = sig

    alerts: list[dict[str, Any]] = []
    for sym, sig in picked.items():
        closed_idx = closed_index_by_sym.get(sym, -1)
        kline_close_time = close_time_by_index.get((sym, SIGNAL_TF, closed_idx), int(sig.ts))
        alert = volume_price_signal_to_alert(
            sig,
            kline_close_time=kline_close_time,
            scan_ts=ts_val,
        )
        if alert:
            alerts.append(alert)
    return alerts
