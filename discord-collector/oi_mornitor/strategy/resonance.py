"""15m/1h/4h 加权共振 + 日线过滤。新信号只记日志，不推送。"""
from __future__ import annotations

import os
from typing import Any

W_15 = float(os.getenv("OI_RES_W_15M", "0.25"))
W_1H = float(os.getenv("OI_RES_W_1H", "0.35"))
W_4H = float(os.getenv("OI_RES_W_4H", "0.40"))
MIN_TF_SCORE = float(os.getenv("OI_RES_MIN_TF_SCORE", "40"))
MIN_TF_COUNT = int(os.getenv("OI_RES_MIN_TF_COUNT", "2"))
REV_4H = float(os.getenv("OI_RES_REVERSE_4H", "50"))
GRADE_A = float(os.getenv("OI_RES_GRADE_A", "65"))
GRADE_B = float(os.getenv("OI_RES_GRADE_B", "50"))
DAILY_STRONG = float(os.getenv("OI_RES_DAILY_STRONG", "55"))


def daily_against(daily_score: float | None, side: str, daily_opp: float | None) -> bool:
    """日线明确逆势：反向分数高且本向分数低。"""
    if daily_score is None or daily_opp is None:
        return False
    return daily_opp >= DAILY_STRONG and daily_score < 40


def resonate(
    scores: dict[str, dict[str, float]],
    *,
    side: str,
) -> dict[str, Any]:
    """scores: tf -> {long: score, short: score}。"""
    s15 = float((scores.get("15m") or {}).get(side) or 0)
    s1h = float((scores.get("1h") or {}).get(side) or 0)
    s4h = float((scores.get("4h") or {}).get(side) or 0)
    opp = "short" if side == "long" else "long"
    s4h_opp = float((scores.get("4h") or {}).get(opp) or 0)
    daily = (scores.get("1d") or {}).get(side)
    daily_opp = (scores.get("1d") or {}).get(opp)
    r = W_15 * s15 + W_1H * s1h + W_4H * s4h
    hit = [tf for tf, sc in (("15m", s15), ("1h", s1h), ("4h", s4h)) if sc >= MIN_TF_SCORE]
    reject = None
    if daily_against(daily, side, daily_opp):
        r *= 0.5
        reject = "daily_against"
    if len(hit) < MIN_TF_COUNT:
        reject = reject or "tf_count"
    if s4h_opp >= REV_4H:
        reject = reject or "htf_conflict"
    opp_r = W_15 * float((scores.get("15m") or {}).get(opp) or 0) + W_1H * float(
        (scores.get("1h") or {}).get(opp) or 0
    ) + W_4H * s4h_opp
    if r >= 50 and opp_r >= 50:
        reject = reject or "conflict"
    if reject == "daily_against":
        grade = "C"
    elif reject:
        grade = "C"
    elif r >= GRADE_A and sum(1 for sc in (s15, s1h, s4h) if sc >= 50) >= 2:
        grade = "A"
    elif r >= GRADE_B:
        grade = "B"
    else:
        grade = "C"
    return {
        "side": side,
        "resonance_r": round(r, 2),
        "grade": grade,
        "tfs_hit": hit,
        "tf_scores": {"15m": s15, "1h": s1h, "4h": s4h, "1d": daily},
        "reject_reason": reject,
        "family": "resonance",
        "kind": f"resonance_{side}",
    }
