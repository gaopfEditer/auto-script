"""维加斯通道价位（144/169 内轨，可选 576/676 外轨）。"""
from __future__ import annotations

import pandas as pd

from oi_mornitor.vegas_trend_config import VEGAS_TREND_USE_OUTER_TUNNEL


def _col(row: pd.Series, name: str) -> float | None:
    if name not in row.index or pd.isna(row[name]):
        return None
    try:
        v = float(row[name])
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def inner_channel(row: pd.Series) -> tuple[float, float] | None:
    e144 = _col(row, "vegas_e1")
    e169 = _col(row, "vegas_e2")
    if e144 is None or e169 is None:
        return None
    return min(e144, e169), max(e144, e169)


def outer_channel(row: pd.Series) -> tuple[float, float] | None:
    if not VEGAS_TREND_USE_OUTER_TUNNEL:
        return None
    e576 = _col(row, "vegas_e3")
    e676 = _col(row, "vegas_e4")
    if e576 is None or e676 is None:
        return None
    return min(e576, e676), max(e576, e676)


def channel_far_edge(row: pd.Series, *, side: str) -> float | None:
    """多单：通道下沿（更远的支撑）；空单：通道上沿。"""
    inner = inner_channel(row)
    if inner is None:
        return None
    lo, hi = inner
    outer = outer_channel(row)
    if side == "long":
        if outer:
            return min(lo, outer[0])
        return lo
    if outer:
        return max(hi, outer[1])
    return hi
