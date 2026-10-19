"""与 Live 一致的滚动 K 线窗口（默认 500 根）。"""
from __future__ import annotations

import pandas as pd

from oi_mornitor.trendline_config import TRENDLINE_KLINE_LIMIT


def rolling_window_df(df: pd.DataFrame, end_idx: int) -> tuple[pd.DataFrame, int]:
    """截取 [end_idx+1-limit, end_idx] 窗口，返回 (子表, 子表内 end 索引)。"""
    if df.empty or end_idx < 0:
        return df.iloc[0:0], -1
    end_idx = min(end_idx, len(df) - 1)
    start = max(0, end_idx + 1 - TRENDLINE_KLINE_LIMIT)
    window = df.iloc[start : end_idx + 1]
    return window, len(window) - 1
