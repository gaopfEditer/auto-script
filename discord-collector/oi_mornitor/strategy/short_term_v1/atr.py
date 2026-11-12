"""15 分钟 ATR（平均真实波幅），不是「15 百万」。"""
from __future__ import annotations

import pandas as pd

from oi_mornitor.strategy.short_term_v1.params import ATR_PERIOD


def atr_at(df: pd.DataFrame, idx: int, period: int = ATR_PERIOD) -> float:
    if df is None or idx < 1 or idx >= len(df):
        return 0.0
    start = max(1, idx - period + 1)
    trs: list[float] = []
    for i in range(start, idx + 1):
        row, prev = df.iloc[i], df.iloc[i - 1]
        h, l, pc = float(row["high"]), float(row["low"]), float(prev["close"])
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return sum(trs) / len(trs) if trs else 0.0
