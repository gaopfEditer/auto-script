"""维加斯顺势：单边趋势 + 回踩通道 + 锤子/射击之星拒绝。"""
from __future__ import annotations

from typing import Any, Literal

import pandas as pd

from oi_mornitor.strategy.indicators import detect_long_lower_wick, detect_shooting_star
from oi_mornitor.trendline.patterns import detect_hammer
from oi_mornitor.trendline.pivots import mark_swing_pivots
from oi_mornitor.vegas_trend.channel import channel_far_edge, inner_channel
from oi_mornitor.vegas_trend_config import (
    VEGAS_TREND_MIN_SLOPE_PCT,
    VEGAS_TREND_SIDE_FRACTION,
    VEGAS_TREND_SLOPE_BARS,
    VEGAS_TREND_STRUCTURE_LOOKBACK,
    VEGAS_TREND_SWING_LOOKBACK,
    VEGAS_TREND_TOUCH_TOL_PCT,
    VEGAS_TREND_TP2_R,
    VEGAS_TREND_VOL_MULT,
)

TrendDir = Literal["up", "down"]


def _slope_pct(series: pd.Series, end_idx: int, bars: int) -> float:
    if end_idx < bars:
        return 0.0
    a = float(series.iloc[end_idx])
    b = float(series.iloc[end_idx - bars])
    if b <= 0 or pd.isna(a) or pd.isna(b):
        return 0.0
    return (a - b) / b


def _trend_direction(df: pd.DataFrame, end_idx: int) -> TrendDir | None:
    if "vegas_e1" not in df.columns or "vegas_e2" not in df.columns:
        return None
    k = VEGAS_TREND_SLOPE_BARS
    s144 = _slope_pct(df["vegas_e1"], end_idx, k)
    s169 = _slope_pct(df["vegas_e2"], end_idx, k)
    min_s = VEGAS_TREND_MIN_SLOPE_PCT
    if s144 >= min_s and s169 >= min_s:
        direction: TrendDir = "up"
    elif s144 <= -min_s and s169 <= -min_s:
        direction = "down"
    else:
        return None

    start = max(0, end_idx - VEGAS_TREND_STRUCTURE_LOOKBACK + 1)
    closes = df["close"].iloc[start : end_idx + 1]
    mids = ((df["vegas_e1"] + df["vegas_e2"]) / 2.0).iloc[start : end_idx + 1]
    if direction == "up":
        above = (closes > mids).sum()
        if above / max(len(closes), 1) < VEGAS_TREND_SIDE_FRACTION:
            return None
    else:
        below = (closes < mids).sum()
        if below / max(len(closes), 1) < VEGAS_TREND_SIDE_FRACTION:
            return None

    if not _structure_confirms(df, end_idx, direction):
        return None
    return direction


def _structure_confirms(df: pd.DataFrame, end_idx: int, direction: TrendDir) -> bool:
    start = max(0, end_idx - VEGAS_TREND_STRUCTURE_LOOKBACK)
    window = df.iloc[start : end_idx + 1].copy()
    work = mark_swing_pivots(window, left=2, right=2, confirm_upto=len(window) - 1)
    hi_ix = [i for i in range(len(work)) if bool(work.iloc[i]["is_swing_high"])]
    lo_ix = [i for i in range(len(work)) if bool(work.iloc[i]["is_swing_low"])]
    if len(hi_ix) < 2 or len(lo_ix) < 2:
        return True
    h1, h2 = float(work.iloc[hi_ix[-2]]["high"]), float(work.iloc[hi_ix[-1]]["high"])
    l1, l2 = float(work.iloc[lo_ix[-2]]["low"]), float(work.iloc[lo_ix[-1]]["low"])
    if direction == "up":
        return h2 >= h1 * 0.998 and l2 >= l1 * 0.998
    return h2 <= h1 * 1.002 and l2 <= l1 * 1.002


def _probes_channel(row: pd.Series, direction: TrendDir) -> bool:
    ch = inner_channel(row)
    if ch is None:
        return False
    lo, hi = ch
    tol_hi = hi * VEGAS_TREND_TOUCH_TOL_PCT
    tol_lo = lo * VEGAS_TREND_TOUCH_TOL_PCT
    h, l, c = float(row["high"]), float(row["low"]), float(row["close"])
    if direction == "up":
        touched = l <= hi + tol_hi
        rejected = c > lo + tol_lo
        return touched and rejected
    touched = h >= lo - tol_lo
    rejected = c < hi - tol_hi
    return touched and rejected


def _prior_swing_extreme(df: pd.DataFrame, end_idx: int, direction: TrendDir) -> float | None:
    start = max(0, end_idx - VEGAS_TREND_SWING_LOOKBACK)
    window = df.iloc[start : end_idx].copy()
    if len(window) < 5:
        return None
    work = mark_swing_pivots(window, left=2, right=2, confirm_upto=len(window) - 1)
    if direction == "up":
        hi_ix = [i for i in range(len(work)) if bool(work.iloc[i]["is_swing_high"])]
        if not hi_ix:
            return None
        return float(work.iloc[hi_ix[-1]]["high"])
    lo_ix = [i for i in range(len(work)) if bool(work.iloc[i]["is_swing_low"])]
    if not lo_ix:
        return None
    return float(work.iloc[lo_ix[-1]]["low"])


def evaluate_vegas_trend_at_bar(
    df: pd.DataFrame,
    end_idx: int,
    *,
    symbol: str,
    interval: str,
) -> dict[str, Any] | None:
    if end_idx < max(VEGAS_TREND_SLOPE_BARS, 30) or end_idx >= len(df):
        return None
    direction = _trend_direction(df, end_idx)
    if direction is None:
        return None
    row = df.iloc[end_idx]
    if not _probes_channel(row, direction):
        return None

    if direction == "up":
        if not (detect_hammer(row) or detect_long_lower_wick(row)):
            return None
        trade_side = "long"
        label = "维加斯顺势·多"
        pattern = "hammer"
        wick_ext = float(row["low"])
    else:
        if not detect_shooting_star(row):
            return None
        trade_side = "short"
        label = "维加斯顺势·空"
        pattern = "shooting_star"
        wick_ext = float(row["high"])

    vol_sma = float(row.get("vol_sma20") or 0)
    vol = float(row.get("volume") or 0)
    vol_ratio = (vol / vol_sma) if vol_sma > 0 else None
    vol_ok = vol_ratio is not None and vol_ratio >= VEGAS_TREND_VOL_MULT

    entry = float(row["close"])
    atr = float(row.get("atr14") or 0)
    from oi_mornitor.vegas_trend_config import VEGAS_TREND_SL_ATR_MULT, VEGAS_TREND_SL_BUFFER_PCT

    buf = max(
        VEGAS_TREND_SL_BUFFER_PCT,
        (VEGAS_TREND_SL_ATR_MULT * atr / entry) if atr > 0 and entry > 0 else 0.0,
    )
    far = channel_far_edge(row, side=trade_side)
    if trade_side == "long":
        sl_base = min(wick_ext, far if far is not None else wick_ext)
        sl = sl_base * (1 - buf)
    else:
        sl_base = max(wick_ext, far if far is not None else wick_ext)
        sl = sl_base * (1 + buf)

    risk = max(abs(entry - sl), entry * 0.001)
    if trade_side == "long":
        tp1 = entry + risk
        swing_tgt = _prior_swing_extreme(df, end_idx, "up")
        tp2_r = entry + risk * VEGAS_TREND_TP2_R
        tp2 = max(swing_tgt or tp2_r, tp2_r) if swing_tgt else tp2_r
    else:
        tp1 = entry - risk
        swing_tgt = _prior_swing_extreme(df, end_idx, "down")
        tp2_r = entry - risk * VEGAS_TREND_TP2_R
        tp2 = min(swing_tgt or tp2_r, tp2_r) if swing_tgt else tp2_r

    return {
        "symbol": symbol,
        "interval": interval,
        "side": "bull" if trade_side == "long" else "bear",
        "trade_side": trade_side,
        "trend_dir": direction,
        "pattern": pattern,
        "type_label": label,
        "entry": entry,
        "sl": sl,
        "tp1": tp1,
        "tp2": tp2,
        "invalid_level": sl,
        "step_pct": risk / entry * 100.0 if entry > 0 else 3.0,
        "vol_ratio": vol_ratio,
        "vol_ok": vol_ok,
        "vegas_trend": True,
        "vegas_trend_volume": vol_ok,
        "kind": f"vegas_trend_{pattern}_{trade_side}",
        "sl_pct": risk / entry * 100.0 if entry > 0 else None,
        "rr_planned": abs(tp2 - entry) / risk if risk > 0 else None,
    }
