"""信号发生后窗口内的最大盈利 / 最大回撤（方向感知）。"""
from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.breakout_detector import klines_to_df


def _entry_close(df: pd.DataFrame, signal_time_ms: int) -> float | None:
    if df.empty or "open_time" not in df.columns:
        return None
    match = df[df["open_time"] == int(signal_time_ms)]
    if match.empty:
        # 取 signal 之后第一根
        later = df[df["open_time"] >= int(signal_time_ms)]
        if later.empty:
            return None
        row = later.iloc[0]
    else:
        row = match.iloc[0]
    try:
        return float(row["close"])
    except (TypeError, ValueError):
        return None


def compute_window_excursions(
    klines: list[Any],
    *,
    signal_time_ms: int,
    window_end_ms: int,
    direction: str,
    entry_price: float | None = None,
) -> dict[str, Any]:
    """
    在 [signal_time_ms, window_end_ms) 内统计极值。
    返回 max_profit_pct / max_drawdown_pct（均为正数百分比，便于展示）。
    """
    df = klines_to_df(klines)
    if df.empty:
        return {"ok": False, "error": "empty_klines"}

    end_ms = int(window_end_ms)
    start_ms = int(signal_time_ms)
    if end_ms <= start_ms:
        return {"ok": False, "error": "bad_window"}

    seg = df[(df["open_time"] >= start_ms) & (df["open_time"] < end_ms)]
    if seg.empty:
        return {"ok": False, "error": "no_bars_in_window"}

    entry = entry_price if entry_price and entry_price > 0 else _entry_close(df, start_ms)
    if entry is None or entry <= 0:
        return {"ok": False, "error": "no_entry"}

    hi = float(seg["high"].max())
    lo = float(seg["low"].min())
    d = str(direction or "long").lower()

    if d == "short":
        max_profit_pct = (entry - lo) / entry * 100.0
        max_drawdown_pct = (hi - entry) / entry * 100.0
    elif d == "neutral":
        up = (hi - entry) / entry * 100.0
        down = (entry - lo) / entry * 100.0
        max_profit_pct = max(up, down)
        max_drawdown_pct = max(up, down)
    else:
        max_profit_pct = (hi - entry) / entry * 100.0
        max_drawdown_pct = (entry - lo) / entry * 100.0

    last_close = float(seg.iloc[-1]["close"])
    if d == "short":
        end_pnl_pct = (entry - last_close) / entry * 100.0
    elif d == "neutral":
        end_pnl_pct = (last_close - entry) / entry * 100.0
    else:
        end_pnl_pct = (last_close - entry) / entry * 100.0

    return {
        "ok": True,
        "entry_price": round(entry, 8),
        "max_profit_pct": round(max(0.0, max_profit_pct), 3),
        "max_drawdown_pct": round(max(0.0, max_drawdown_pct), 3),
        "end_pnl_pct": round(end_pnl_pct, 3),
        "bars": int(len(seg)),
    }
