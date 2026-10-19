"""区间箱体检测 + 边缘反转形态（无前瞻）。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import pandas as pd

from oi_mornitor.strategy.indicators import detect_long_lower_wick, detect_shooting_star
from oi_mornitor.trendline.patterns import detect_hammer
from oi_mornitor.trendline.pivots import mark_swing_pivots
from oi_mornitor.range_reversal_config import (
    RANGE_REVERSAL_BREAK_BUFFER_PCT,
    RANGE_REVERSAL_EDGE_ZONE_FRAC,
    RANGE_REVERSAL_LOOKBACK_BARS,
    RANGE_REVERSAL_MIN_TOUCHES,
    RANGE_REVERSAL_SL_ATR_MULT,
    RANGE_REVERSAL_SL_BUFFER_PCT,
    RANGE_REVERSAL_TOUCH_TOL_PCT,
    RANGE_REVERSAL_TP_EDGE_BUFFER_PCT,
    width_pct_bounds,
)

Side = Literal["short", "long"]


@dataclass(frozen=True)
class RangeBox:
    high: float
    low: float
    width: float
    width_pct: float
    touches_high: int
    touches_low: int


def _touches_near(df: pd.DataFrame, start: int, end: int, level: float, *, use_high: bool) -> int:
    if level <= 0:
        return 0
    tol = level * RANGE_REVERSAL_TOUCH_TOL_PCT
    n = 0
    for i in range(start, end + 1):
        row = df.iloc[i]
        h, l = float(row["high"]), float(row["low"])
        if use_high:
            if abs(h - level) <= tol or h >= level - tol:
                n += 1
        else:
            if abs(l - level) <= tol or l <= level + tol:
                n += 1
    return n


def _pick_edge_level(
    df: pd.DataFrame,
    pivot_indices: list[int],
    *,
    use_high: bool,
    start: int,
    end: int,
) -> tuple[float | None, int]:
    col = "high" if use_high else "low"
    best_level: float | None = None
    best_touches = 0
    seen: set[float] = set()
    for pi in pivot_indices:
        level = float(df.iloc[pi][col])
        if level <= 0:
            continue
        key = round(level, 6)
        if key in seen:
            continue
        seen.add(key)
        touches = _touches_near(df, start, end, level, use_high=use_high)
        if touches >= RANGE_REVERSAL_MIN_TOUCHES and touches >= best_touches:
            best_touches = touches
            best_level = level
    return best_level, best_touches


def detect_range_box(
    df: pd.DataFrame,
    end_idx: int,
    *,
    symbol: str,
) -> RangeBox | None:
    """仅用下标 <= end_idx 的已收盘 K 线识别横盘区间。"""
    if end_idx < 10 or end_idx >= len(df):
        return None
    n = RANGE_REVERSAL_LOOKBACK_BARS
    start = max(0, end_idx - n + 1)
    window = df.iloc[start : end_idx + 1].copy()
    rel_end = len(window) - 1
    work = mark_swing_pivots(
        window,
        left=3,
        right=3,
        confirm_upto=rel_end,
    )
    hi_pivots = [i for i in range(len(work)) if bool(work.iloc[i]["is_swing_high"])]
    lo_pivots = [i for i in range(len(work)) if bool(work.iloc[i]["is_swing_low"])]
    rh, th = _pick_edge_level(work, hi_pivots, use_high=True, start=0, end=rel_end)
    rl, tl = _pick_edge_level(work, lo_pivots, use_high=False, start=0, end=rel_end)
    if rh is None or rl is None or rh <= rl:
        rh = float(work["high"].max())
        rl = float(work["low"].min())
        th = _touches_near(work, 0, rel_end, rh, use_high=True)
        tl = _touches_near(work, 0, rel_end, rl, use_high=False)
        tol = rh * RANGE_REVERSAL_TOUCH_TOL_PCT
        hi_ok = any(
            bool(work.iloc[i]["is_swing_high"])
            and abs(float(work.iloc[i]["high"]) - rh) <= tol
            for i in hi_pivots
        )
        lo_ok = any(
            bool(work.iloc[i]["is_swing_low"])
            and abs(float(work.iloc[i]["low"]) - rl) <= tol
            for i in lo_pivots
        )
        if not (hi_ok and lo_ok and th >= RANGE_REVERSAL_MIN_TOUCHES and tl >= RANGE_REVERSAL_MIN_TOUCHES):
            return None
    if rh <= rl:
        return None
    width = rh - rl
    mid = (rh + rl) / 2.0
    if mid <= 0:
        return None
    width_pct = width / mid
    wmin, wmax = width_pct_bounds(symbol)
    if width_pct < wmin or width_pct > wmax:
        return None
    buf_hi = rh * RANGE_REVERSAL_BREAK_BUFFER_PCT
    buf_lo = rl * RANGE_REVERSAL_BREAK_BUFFER_PCT
    for i in range(0, rel_end + 1):
        c = float(work.iloc[i]["close"])
        if c > rh + buf_hi or c < rl - buf_lo:
            return None
    return RangeBox(high=rh, low=rl, width=width, width_pct=width_pct, touches_high=th, touches_low=tl)


def _in_top_zone(close: float, box: RangeBox) -> bool:
    zone = box.width * RANGE_REVERSAL_EDGE_ZONE_FRAC
    return close >= box.high - zone


def _in_bottom_zone(close: float, box: RangeBox) -> bool:
    zone = box.width * RANGE_REVERSAL_EDGE_ZONE_FRAC
    return close <= box.low + zone


def _wick_touches_top(row: pd.Series, box: RangeBox) -> bool:
    tol = box.high * RANGE_REVERSAL_TOUCH_TOL_PCT
    return float(row["high"]) >= box.high - tol


def _wick_touches_bottom(row: pd.Series, box: RangeBox) -> bool:
    tol = box.low * RANGE_REVERSAL_TOUCH_TOL_PCT
    return float(row["low"]) <= box.low + tol


def evaluate_range_reversal_at_bar(
    df: pd.DataFrame,
    end_idx: int,
    *,
    symbol: str,
    interval: str,
    require_range: bool = True,
) -> dict[str, Any] | None:
    """区间边缘反转；require_range=False 时仅形态（基线对比用）。"""
    if end_idx < 15 or end_idx >= len(df):
        return None
    row = df.iloc[end_idx]
    box = detect_range_box(df, end_idx, symbol=symbol)
    c = float(row["close"])
    vol_sma = float(row.get("vol_sma20") or 0)
    vol = float(row.get("volume") or 0)
    vol_ratio = (vol / vol_sma) if vol_sma > 0 else None
    vol_ok = vol_ratio is not None and vol_ratio >= 1.2

    short_pat = detect_shooting_star(row)
    long_pat = detect_hammer(row) or detect_long_lower_wick(row)

    def _hit(side: Side, pattern: str) -> dict[str, Any] | None:
        if side == "short":
            if not short_pat:
                return None
            if require_range:
                if box is None or not _in_top_zone(c, box):
                    return None
                if not _wick_touches_top(row, box):
                    return None
                if c > box.high:
                    return None
            label = "区间射击之星·空" if require_range else "射击之星·空(基线)"
        else:
            if not long_pat:
                return None
            if require_range:
                if box is None or not _in_bottom_zone(c, box):
                    return None
                if not _wick_touches_bottom(row, box):
                    return None
                if c < box.low:
                    return None
            label = "区间锤子·多" if require_range else "锤子·多(基线)"

        atr = float(row.get("atr14") or 0)
        if side == "short":
            wick_ext = float(row["high"])
        else:
            wick_ext = float(row["low"])
        buf_pct = max(
            RANGE_REVERSAL_SL_BUFFER_PCT,
            (RANGE_REVERSAL_SL_ATR_MULT * atr / c) if atr > 0 and c > 0 else 0.0,
        )
        if side == "short":
            sl = wick_ext * (1 + buf_pct)
        else:
            sl = wick_ext * (1 - buf_pct)

        entry = c
        if box is not None:
            mid = (box.high + box.low) / 2.0
            edge_buf = RANGE_REVERSAL_TP_EDGE_BUFFER_PCT
            if side == "short":
                tp1 = mid
                tp2 = box.low * (1 + edge_buf)
            else:
                tp1 = mid
                tp2 = box.high * (1 - edge_buf)
        else:
            risk = max(abs(entry - sl), entry * 0.001)
            if side == "short":
                tp1 = entry - risk
                tp2 = entry - 2 * risk
            else:
                tp1 = entry + risk
                tp2 = entry + 2 * risk

        risk = max(abs(sl - entry), entry * 0.001)
        reward = abs(tp2 - entry)
        rr_planned = reward / risk if risk > 0 else None
        sl_pct = abs(sl - entry) / entry * 100.0 if entry > 0 else None

        return {
            "symbol": symbol,
            "interval": interval,
            "side": "bear" if side == "short" else "bull",
            "trade_side": side,
            "pattern": pattern,
            "type_label": label,
            "range_high": box.high if box else None,
            "range_low": box.low if box else None,
            "range_width_pct": box.width_pct if box else None,
            "entry": entry,
            "sl": sl,
            "tp1": tp1,
            "tp2": tp2,
            "invalid_level": sl,
            "step_pct": sl_pct,
            "vol_ratio": vol_ratio,
            "vol_subset": vol_ok,
            "sl_pct": sl_pct,
            "rr_planned": rr_planned,
            "context": "range" if require_range and box else "baseline",
            "kind": f"range_rev_{pattern}_{side}",
        }

    if require_range:
        if box is None:
            return None
        if short_pat and _in_top_zone(c, box) and _wick_touches_top(row, box) and c <= box.high:
            return _hit("short", "shooting_star")
        if long_pat and _in_bottom_zone(c, box) and _wick_touches_bottom(row, box) and c >= box.low:
            return _hit("long", "hammer")
        return None

    # baseline：有形态但不在有效区间边缘
    range_hit = evaluate_range_reversal_at_bar(
        df, end_idx, symbol=symbol, interval=interval, require_range=True
    )
    if range_hit:
        return None
    if short_pat:
        return _hit("short", "shooting_star")
    if long_pat:
        return _hit("long", "hammer")
    return None
