"""行情状态：路径 ER + 布林带宽（各周期自算）。"""
from __future__ import annotations

from typing import Literal

import numpy as np
import pandas as pd

from oi_mornitor.volume_price.vp_config import BB_WIDTH_PCT, ER_MIN, ER_WINDOW, bb_window_bars

RegimeKind = Literal["chop", "trend_up", "trend_down", "neutral"]


def add_regime_columns(df: pd.DataFrame) -> pd.DataFrame:
    """按 symbol|tf 增加 path_er_48、bb_width_chop、regime 等列。"""
    if df.empty:
        return df.copy()

    out = df.copy()
    grp_key = out["symbol"].astype(str) + "|" + out["tf"].astype(str)
    pieces: list[pd.DataFrame] = []

    for _, idx in out.groupby(grp_key).groups.items():
        chunk = out.loc[idx].sort_values("ts").copy()
        tf = str(chunk.iloc[0]["tf"])
        close = pd.to_numeric(chunk["close"], errors="coerce")
        high = pd.to_numeric(chunk["high"], errors="coerce")
        low = pd.to_numeric(chunk["low"], errors="coerce")

        net = (close - close.shift(ER_WINDOW)).abs()
        path = close.diff().abs().rolling(ER_WINDOW, min_periods=ER_WINDOW).sum()
        chunk["path_er_48"] = net / path.replace(0, np.nan)
        chunk["close_48_ago"] = close.shift(ER_WINDOW)

        mid = close.rolling(20, min_periods=20).mean()
        std = close.rolling(20, min_periods=20).std(ddof=0)
        upper = mid + 2 * std
        lower = mid - 2 * std
        bb_width = (upper - lower) / mid.replace(0, np.nan)
        chunk["bb_width"] = bb_width
        win = bb_window_bars(tf)
        p30 = bb_width.rolling(win, min_periods=min(80, win // 4)).quantile(BB_WIDTH_PCT)
        chunk["bb_width_chop"] = bb_width <= p30

        chunk["high_20_prev"] = high.rolling(20, min_periods=20).max().shift(1)
        r30h = high.rolling(30, min_periods=30).max()
        r30l = low.rolling(30, min_periods=30).min()
        span = (r30h - r30l).replace(0, np.nan)
        chunk["range_30_high"] = r30h
        chunk["range_30_low"] = r30l
        chunk["in_range_top_15"] = ((r30h - close) / span) <= 0.15

        rng = (high - low).replace(0, np.nan)
        chunk["close_range_frac"] = (close - low) / rng
        chunk["ema20"] = close.ewm(span=20, adjust=False).mean()

        pieces.append(chunk)

    merged = pd.concat(pieces, ignore_index=True).sort_values(["symbol", "tf", "ts"]).reset_index(drop=True)
    merged["regime"] = [classify_regime_row(merged.iloc[i]) for i in range(len(merged))]
    return merged


def classify_regime_row(row: pd.Series) -> RegimeKind:
    er = row.get("path_er_48")
    if pd.notna(er) and float(er) < ER_MIN:
        return "chop"
    if bool(row.get("bb_width_chop")):
        return "chop"
    c = float(row.get("close") or 0)
    c0 = row.get("close_48_ago")
    if pd.notna(c0) and c > 0:
        if c < float(c0):
            return "trend_down"
        if c > float(c0):
            return "trend_up"
    return "neutral"


def regime_blocks_long(regime: str) -> bool:
    return regime in ("chop", "trend_down")


def regime_blocks_short(regime: str) -> bool:
    return regime == "chop"
