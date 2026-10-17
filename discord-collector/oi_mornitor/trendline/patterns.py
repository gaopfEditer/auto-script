"""收盘 K 反转形态 + 假突破回收 / 突破回踩。"""
from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.strategy.indicators import detect_long_lower_wick, detect_shooting_star
from oi_mornitor.trendline.lines import TrendLine


def _body(row: pd.Series) -> float:
    return abs(float(row["close"]) - float(row["open"]))


def _range(row: pd.Series) -> float:
    return max(float(row["high"]) - float(row["low"]), 1e-12)


def detect_hammer(row: pd.Series) -> bool:
    o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
    body = abs(c - o)
    lower = min(o, c) - l
    upper = h - max(o, c)
    rng = h - l
    if rng <= 0 or body <= 0:
        return False
    return lower >= body * 2 and upper <= body * 0.5 and lower / rng >= 0.55


def detect_pin_bar(row: pd.Series, *, side: str) -> bool:
    o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
    rng = h - l
    if rng <= 0:
        return False
    body = abs(c - o)
    upper = h - max(o, c)
    lower = min(o, c) - l
    if body / rng > 0.35:
        return False
    if side == "bull":
        return lower / rng >= 0.62 and upper / rng <= 0.15
    return upper / rng >= 0.62 and lower / rng <= 0.15


def detect_engulfing(df: pd.DataFrame, idx: int) -> tuple[bool, bool]:
    if idx < 1:
        return False, False
    prev, cur = df.iloc[idx - 1], df.iloc[idx]
    po, pc = float(prev["open"]), float(prev["close"])
    co, cc = float(cur["open"]), float(cur["close"])
    prev_bear = pc < po
    prev_bull = pc > po
    cur_bull = cc > co
    cur_bear = cc < co
    bull = prev_bear and cur_bull and co <= pc and cc >= po
    bear = prev_bull and cur_bear and co >= pc and cc <= po
    return bull, bear


def detect_sfp_at_line(
    row: pd.Series,
    *,
    line_price: float,
    side: str,
    tol_pct: float,
) -> bool:
    """刺破趋势线后收回（Swing Failure Pattern）。"""
    if line_price <= 0:
        return False
    tol = line_price * tol_pct
    h, l, c = float(row["high"]), float(row["low"]), float(row["close"])
    if side == "support":
        return l < line_price - tol and c > line_price
    return h > line_price + tol and c < line_price


def detect_breakout_retest(
    df: pd.DataFrame,
    idx: int,
    *,
    line: TrendLine,
    lookback: int,
    tol_pct: float,
) -> str | None:
    """突破后回踩：收盘在突破侧 + 当根触及趋势线 + 拒绝收回突破方向。返回 long/short 或 None。"""
    if idx < 2:
        return None
    level_now = line.price_at(idx)
    if level_now <= 0:
        return None
    start = max(0, idx - lookback)
    row = df.iloc[idx]
    c_now = float(row["close"])
    h_now = float(row["high"])
    l_now = float(row["low"])
    tol = level_now * tol_pct
    touch_band = level_now * tol_pct * 2

    if line.side == "resistance":
        broke = False
        for j in range(start, idx):
            lvl = line.price_at(j)
            if float(df.iloc[j]["close"]) > lvl * (1 + tol_pct):
                broke = True
                break
        if not broke or c_now <= level_now + tol:
            return None
        touched = l_now <= level_now + touch_band
        rejected = c_now > level_now + tol * 0.5
        return "long" if touched and rejected else None

    broke = False
    for j in range(start, idx):
        lvl = line.price_at(j)
        if float(df.iloc[j]["close"]) < lvl * (1 - tol_pct):
            broke = True
            break
    if not broke or c_now >= level_now - tol:
        return None
    touched = h_now >= level_now - touch_band
    rejected = c_now < level_now - tol * 0.5
    return "short" if touched and rejected else None


def classify_reversal_at_line(
    df: pd.DataFrame,
    idx: int,
    *,
    line: TrendLine,
    touch_tol_pct: float,
    breakout_lookback: int,
) -> dict[str, Any] | None:
    row = df.iloc[idx]
    level = line.price_at(idx)
    bull_side = line.side == "support"
    bear_side = line.side == "resistance"

    patterns: list[tuple[str, str]] = []
    if bull_side:
        if detect_hammer(row):
            patterns.append(("hammer", "long"))
        if detect_long_lower_wick(row):
            patterns.append(("long_lower_wick", "long"))
        if detect_pin_bar(row, side="bull"):
            patterns.append(("pin_bar", "long"))
        bull_eng, bear_eng = detect_engulfing(df, idx)
        if bull_eng:
            patterns.append(("engulfing", "long"))
        if detect_sfp_at_line(row, line_price=level, side="support", tol_pct=touch_tol_pct):
            patterns.append(("sfp", "long"))
    if bear_side:
        if detect_shooting_star(row):
            patterns.append(("shooting_star", "short"))
        if detect_pin_bar(row, side="bear"):
            patterns.append(("pin_bar", "short"))
        bull_eng, bear_eng = detect_engulfing(df, idx)
        if bear_eng:
            patterns.append(("engulfing", "short"))
        if detect_sfp_at_line(row, line_price=level, side="resistance", tol_pct=touch_tol_pct):
            patterns.append(("sfp", "short"))

    br_side = detect_breakout_retest(
        df,
        idx,
        line=line,
        lookback=breakout_lookback,
        tol_pct=touch_tol_pct,
    )
    if br_side:
        patterns.append(("breakout_retest", br_side))

    if not patterns:
        return None
    # 优先 SFP / engulfing
    priority = (
        "sfp",
        "engulfing",
        "breakout_retest",
        "pin_bar",
        "hammer",
        "long_lower_wick",
        "shooting_star",
    )
    patterns.sort(key=lambda x: priority.index(x[0]) if x[0] in priority else 99)
    kind, trade_side = patterns[0]
    return {
        "pattern": kind,
        "side": "bull" if trade_side == "long" else "bear",
        "trade_side": trade_side,
        "line_price": level,
    }
