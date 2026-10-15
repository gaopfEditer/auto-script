"""摆动高低点软评分：走强 ≈ HH+HL；走弱 ≈ LH+LL（非教科书刚性匹配）。

用于结构倾向卡片、MAIN 一档推送、形态列表逆结构降权。
"""
from __future__ import annotations

from typing import Any, Literal

import pandas as pd

from oi_mornitor.strategy.candle_signals import closed_bar_index
from oi_mornitor.strategy.structure_signals import SWING_ORDER, mark_swing_points

BiasSide = Literal["bull", "bear", "neutral"]

# 最近几组摆动比较（2/3 即至少 2 票同向）
_SWING_PAIRS_LOOKBACK = 3
# 价格“持平”容差（相对前摆动点）
_SWING_FLAT_TOL = 0.0035
# 触发推送 / 一档 MAIN 的最低强度分（0–100）
BIAS_ALERT_MIN_SCORE = 55
BIAS_MAIN_TIER_MIN_SCORE = 58
STRUCTURE_BIAS_KIND = "structure_market_bias"
STRUCTURE_BIAS_INTERVALS = frozenset({"15m", "1h", "4h"})


def _compress_swing_prices(
    points: list[tuple[int, float]],
    *,
    mode: Literal["high", "low"],
    tol: float,
) -> list[float]:
    """合并容差内的连续摆动点，避免平台区重复计数。"""
    if not points:
        return []
    out: list[float] = []
    for _, price in points:
        if price <= 0:
            continue
        if not out:
            out.append(price)
            continue
        ref = out[-1]
        if abs(price - ref) / ref <= tol:
            if mode == "high":
                out[-1] = max(out[-1], price)
            else:
                out[-1] = min(out[-1], price)
        else:
            out.append(price)
    return out


def _compare_high_swings(
    prices: list[float],
    *,
    tol: float = _SWING_FLAT_TOL,
) -> tuple[list[str], int, int]:
    tags: list[str] = []
    bull_votes = 0
    bear_votes = 0
    for i in range(1, len(prices)):
        prev, cur = prices[i - 1], prices[i]
        if prev <= 0:
            continue
        rel = (cur - prev) / prev
        if abs(rel) <= tol:
            tag = "flat"
        elif rel > tol:
            tag, bull_votes = "HH", bull_votes + 1
        else:
            tag, bear_votes = "LH", bear_votes + 1
        tags.append(tag)
    return tags, bull_votes, bear_votes


def _compare_low_swings(
    prices: list[float],
    *,
    tol: float = _SWING_FLAT_TOL,
) -> tuple[list[str], int, int]:
    tags: list[str] = []
    bull_votes = 0
    bear_votes = 0
    for i in range(1, len(prices)):
        prev, cur = prices[i - 1], prices[i]
        if prev <= 0:
            continue
        rel = (cur - prev) / prev
        if abs(rel) <= tol:
            tag = "flat"
        elif rel > tol:
            tag, bull_votes = "HL", bull_votes + 1
        else:
            tag, bear_votes = "LL", bear_votes + 1
        tags.append(tag)
    return tags, bull_votes, bear_votes


def evaluate_market_structure_bias(
    df: pd.DataFrame,
    *,
    swing_order: int = SWING_ORDER,
    pairs_lookback: int = _SWING_PAIRS_LOOKBACK,
    flat_tol: float = _SWING_FLAT_TOL,
) -> dict[str, Any]:
    """全序列评估；返回 bias、score、high_tags、low_tags、reasons 等。"""
    empty: dict[str, Any] = {
        "bias": "neutral",
        "score": 0,
        "bull_votes": 0,
        "bear_votes": 0,
        "high_tags": [],
        "low_tags": [],
        "reasons": [],
        "swing_highs": [],
        "swing_lows": [],
    }
    if df is None or df.empty or len(df) < swing_order * 4 + 10:
        return empty

    work = mark_swing_points(df, order=swing_order)
    highs = [
        (int(i), float(work.iloc[i]["high"]))
        for i in range(len(work))
        if bool(work.iloc[i]["is_swing_high"])
    ]
    lows = [
        (int(i), float(work.iloc[i]["low"]))
        for i in range(len(work))
        if bool(work.iloc[i]["is_swing_low"])
    ]
    if len(highs) < 2 or len(lows) < 2:
        return empty

    hi_prices = _compress_swing_prices(highs, mode="high", tol=flat_tol)[
        -(pairs_lookback + 1) :
    ]
    lo_prices = _compress_swing_prices(lows, mode="low", tol=flat_tol)[
        -(pairs_lookback + 1) :
    ]

    high_tags, hi_bull, hi_bear = _compare_high_swings(hi_prices, tol=flat_tol)
    low_tags, lo_bull, lo_bear = _compare_low_swings(lo_prices, tol=flat_tol)

    bull_votes = hi_bull + lo_bull
    bear_votes = hi_bear + lo_bear
    reasons: list[str] = []

    if high_tags:
        reasons.append("高点: " + "→".join(high_tags))
    if low_tags:
        reasons.append("低点: " + "→".join(low_tags))

    bias: BiasSide = "neutral"
    score = 0

    # 软规则：主导方向需至少 2 票，且明显多于反向
    if bear_votes >= 2 and bear_votes >= bull_votes + 1:
        bias = "bear"
        score = min(100, 42 + bear_votes * 14 + max(0, bear_votes - bull_votes) * 6)
        reasons.append(f"走弱倾向 {bear_votes}/{bear_votes + bull_votes} 票")
    elif bull_votes >= 2 and bull_votes >= bear_votes + 1:
        bias = "bull"
        score = min(100, 42 + bull_votes * 14 + max(0, bull_votes - bear_votes) * 6)
        reasons.append(f"走强倾向 {bull_votes}/{bear_votes + bull_votes} 票")
    else:
        reasons.append("摆动分歧，暂无明确结构倾向")

    return {
        "bias": bias,
        "score": int(score),
        "bull_votes": bull_votes,
        "bear_votes": bear_votes,
        "high_tags": high_tags,
        "low_tags": low_tags,
        "reasons": reasons,
        "swing_highs": hi_prices,
        "swing_lows": lo_prices,
    }


def find_structure_bias_hit(
    df: pd.DataFrame,
    *,
    now_ms: int | None = None,
    min_score: int = BIAS_ALERT_MIN_SCORE,
) -> dict[str, Any] | None:
    """在最近已收盘 K 上，若结构倾向达阈值则返回卡片 hit（每根最多一条）。"""
    if df is None or df.empty or "open_time" not in df.columns:
        return None
    idx = closed_bar_index(df, now_ms=now_ms)
    if idx < 0:
        return None

    ev = evaluate_market_structure_bias(df.iloc[: idx + 1])
    bias = str(ev.get("bias") or "neutral")
    score = int(ev.get("score") or 0)
    if bias not in ("bull", "bear") or score < min_score:
        return None

    row = df.iloc[idx]
    closed_ts = int(row["open_time"] // 1000)
    side = bias
    type_label = "结构走强" if bias == "bull" else "结构走弱"
    pattern_label = (
        "摆动高点抬高 + 低点抬高 (HH/HL)"
        if bias == "bull"
        else "摆动高点降低 + 低点降低 (LH/LL)"
    )

    return {
        "kind": STRUCTURE_BIAS_KIND,
        "side": side,
        "type_label": type_label,
        "pattern_label": pattern_label,
        "bar_index": idx,
        "time": closed_ts,
        "structure_bias": ev,
        "bias_score": score,
        "open": float(row["open"]),
        "high": float(row["high"]),
        "low": float(row["low"]),
        "close": float(row["close"]),
        "price": float(row["close"]),
    }


def structure_bias_side_for_signal(side: str) -> str | None:
    """alert side → long/short 口径，供共振降权。"""
    s = str(side or "").lower()
    if s in ("bull", "long"):
        return "long"
    if s in ("bear", "short"):
        return "short"
    return None


def is_counter_structure_signal(
    signal_side: str,
    bias: str | None,
    bias_score: int,
    *,
    min_score: int = 50,
) -> bool:
    if not bias or bias == "neutral" or bias_score < min_score:
        return False
    sig = structure_bias_side_for_signal(signal_side)
    if not sig:
        return False
    struct = "long" if bias == "bull" else "short"
    return sig != struct
