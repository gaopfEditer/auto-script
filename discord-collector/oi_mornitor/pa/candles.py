"""Kline / DataFrame → closed-candle dicts for PA chain."""

from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.pa.params import PA_LOOKBACK, TIMEFRAME_SECONDS


def klines_rows_to_candles(rows: list[list[Any]] | list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows or []:
        if isinstance(row, dict):
            out.append(
                {
                    "open_time": int(row.get("open_time") or 0),
                    "open": float(row.get("open") or 0),
                    "high": float(row.get("high") or 0),
                    "low": float(row.get("low") or 0),
                    "close": float(row.get("close") or 0),
                    "volume": float(row.get("volume") or 0),
                }
            )
            continue
        if not row or len(row) < 6:
            continue
        out.append(
            {
                "open_time": int(row[0]) // 1000 if int(row[0]) > 10_000_000_000 else int(row[0]),
                "open": float(row[1]),
                "high": float(row[2]),
                "low": float(row[3]),
                "close": float(row[4]),
                "volume": float(row[5]),
            }
        )
    return out


def df_to_candles(df: pd.DataFrame, *, max_bars: int = PA_LOOKBACK) -> list[dict[str, Any]]:
    if df is None or df.empty:
        return []
    tail = df.tail(max_bars)
    out: list[dict[str, Any]] = []
    for _, row in tail.iterrows():
        ot = row.get("open_time")
        if ot is None:
            continue
        ot_i = int(ot)
        if ot_i > 10_000_000_000:
            ot_i //= 1000
        out.append(
            {
                "open_time": ot_i,
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row.get("volume") or 0),
            }
        )
    return out


def drop_forming_bar(candles: list[dict[str, Any]], timeframe: str, now_s: float | None = None) -> list[dict[str, Any]]:
    """Exclude the still-forming last bar (closed-candle rule)."""
    if not candles:
        return candles
    period = TIMEFRAME_SECONDS.get(str(timeframe or "").strip().lower())
    if not period:
        return candles[:-1] if len(candles) > 1 else candles
    import time as _time

    now = now_s if now_s is not None else _time.time()
    latest_closed = int(now // period) * period - period
    return [c for c in candles if int(c.get("open_time") or 0) <= latest_closed]
