"""收盘 K 反转形态 + 假突破回收 / 突破回踩。"""
from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.strategy.indicators import detect_inverted_hammer, detect_shooting_star
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
) -> bool:
    if idx < 2:
        return False
    level_now = line.price_at(idx)
    start = max(0, idx - lookback)
    broke = False
    for j in range(start, idx):
        lvl = line.price_at(j)
        c = float(df.iloc[j]["close"])
        if line.side == "support":
            if c < lvl * (1 - tol_pct):
                broke = True
        else:
            if c > lvl * (1 + tol_pct):
                broke = True
    if not broke:
        return False
    row = df.iloc[idx]
    dist = min(
        abs(float(row["high"]) - level_now),
        abs(float(row["low"]) - level_now),
        abs(float(row["close"]) - level_now),
    )
    return dist <= level_now * tol_pct * 2


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
        if detect_inverted_hammer(row):
            patterns.append(("inverted_hammer", "long"))
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

    if detect_breakout_retest(
        df,
        idx,
        line=line,
        lookback=breakout_lookback,
        tol_pct=touch_tol_pct,
    ):
        side = "long" if line.side == "resistance" else "short"
        patterns.append(("breakout_retest", side))

    if not patterns:
        return None
    # 优先 SFP / engulfing
    priority = ("sfp", "engulfing", "breakout_retest", "pin_bar", "hammer", "inverted_hammer", "shooting_star")
    patterns.sort(key=lambda x: priority.index(x[0]) if x[0] in priority else 99)
    kind, trade_side = patterns[0]
    return {
        "pattern": kind,
        "side": "bull" if trade_side == "long" else "bear",
        "trade_side": trade_side,
        "line_price": level,
    }
