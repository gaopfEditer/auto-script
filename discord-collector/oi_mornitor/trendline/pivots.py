"""Swing pivot 高低点（可配置左右窗口）。"""
from __future__ import annotations

import pandas as pd


def mark_swing_pivots(
    df: pd.DataFrame,
    *,
    left: int,
    right: int,
) -> pd.DataFrame:
    """在 df 上标注 is_swing_high / is_swing_low。"""
    out = df.copy()
    n = len(out)
    if n == 0:
        out["is_swing_high"] = False
        out["is_swing_low"] = False
        return out

    highs = out["high"].astype(float).tolist()
    lows = out["low"].astype(float).tolist()
    is_hi = [False] * n
    is_lo = [False] * n
    for i in range(n):
        if i < left or i + right >= n:
            continue
        window_hi = highs[i - left : i + right + 1]
        window_lo = lows[i - left : i + right + 1]
        if highs[i] >= max(window_hi):
            is_hi[i] = True
        if lows[i] <= min(window_lo):
            is_lo[i] = True
    out["is_swing_high"] = is_hi
    out["is_swing_low"] = is_lo
    return out


def swing_low_indices(df: pd.DataFrame) -> list[int]:
    if "is_swing_low" not in df.columns:
        return []
    return [i for i in range(len(df)) if bool(df.iloc[i]["is_swing_low"])]


def swing_high_indices(df: pd.DataFrame) -> list[int]:
    if "is_swing_high" not in df.columns:
        return []
    return [i for i in range(len(df)) if bool(df.iloc[i]["is_swing_high"])]
