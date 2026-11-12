"""交易机会结构化评估。

评分权重必须经历史训练与样本外验证后才能当期望值使用。
本模块只记录特征标志与文字判断，不把人工分数当作胜率。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

# 决策仅四档；wait = 缺确认，skip = 禁止/质量不足。
DECISIONS = ("long", "short", "wait", "skip")


@dataclass
class OpportunityAssessment:
    symbol: str = ""
    side_intent: str = ""  # long / short / none
    regime_4h: str = "unknown"
    regime_1h: str = "unknown"
    structure_1h: str = "none"  # bos / choch / none
    oi_status: str = "oi_unavailable"  # confirmed / adverse / pending / oi_unavailable
    pullback_volume: str = "unknown"  # contraction / expansion / unknown
    pattern: str = ""
    decision: str = "wait"
    reasons: list[str] = field(default_factory=list)
    # 可训练特征（布尔/离散），供 expectancy_combo / 消融使用。不是胜率权重。
    feature_flags: dict[str, Any] = field(default_factory=dict)
    hypothesis_filters: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["weightsAreTrained"] = False
        d["scoreNote"] = "特征仅作记录；权重须经历史与样本外验证，不得把人工赋分当作胜率。"
        return d


def assess(
    *,
    symbol: str,
    side_intent: str,
    regime_4h: str = "unknown",
    regime_1h: str = "unknown",
    structure_1h: str = "none",
    oi_status: str = "oi_unavailable",
    pullback_volume: str = "unknown",
    pattern: str = "",
    htf_aligned: bool | None = None,
    close_confirmed: bool | None = None,
    sweep_reclaim_choch: bool | None = None,
    at_range_edge: bool | None = None,
    forbidden: str | None = None,
    extra_flags: dict[str, Any] | None = None,
    extra_reasons: list[str] | None = None,
) -> OpportunityAssessment:
    reasons = list(extra_reasons or [])
    flags: dict[str, Any] = {
        "pattern": pattern,
        "regime_4h": regime_4h,
        "regime_1h": regime_1h,
        "structure_1h": structure_1h,
        "oi_status": oi_status,
        "pullback_volume": pullback_volume,
        "htf_aligned": bool(htf_aligned) if htf_aligned is not None else None,
        "close_confirmed": bool(close_confirmed) if close_confirmed is not None else None,
        "sweep_reclaim_choch": bool(sweep_reclaim_choch) if sweep_reclaim_choch is not None else None,
        "at_range_edge": bool(at_range_edge) if at_range_edge is not None else None,
    }
    if extra_flags:
        flags.update(extra_flags)

    decision = "wait"
    hypotheses: list[str] = []
    side = str(side_intent or "").lower()

    if forbidden:
        decision = "skip"
        reasons.append(forbidden)
    elif side in ("long", "short"):
        # 规则只做「能否入场」的硬条件；不输出数值胜率。
        missing: list[str] = []
        if htf_aligned is False:
            missing.append("HTF 方向不一致")
        if close_confirmed is False:
            missing.append("缺少收盘确认")
        if sweep_reclaim_choch is False:
            missing.append("流动性反转不完整（需 sweep+reclaim+CHoCH）")
        if at_range_edge is False:
            missing.append("不在区间边缘")
        if oi_status == "adverse":
            reasons.append("OI 出现不利变化（置信度下降，非替代入场条件）")
        if missing:
            decision = "wait"
            reasons.extend(missing)
        else:
            # 硬条件满足 → 给出方向决策；是否交易仍由策略自己的入场规则决定。
            decision = side
            if htf_aligned:
                reasons.append("HTF 方向一致")
            if close_confirmed:
                reasons.append("收盘确认结构")
            if structure_1h in ("bos", "choch"):
                reasons.append(f"1h 结构 {structure_1h}")
            if pullback_volume == "contraction":
                reasons.append("回踩缩量")
            if oi_status == "oi_unavailable":
                reasons.append("oi_unavailable")
            elif oi_status == "pending":
                reasons.append("OI 待确认")
    else:
        decision = "wait"
        reasons.append("无明确方向")

    return OpportunityAssessment(
        symbol=symbol,
        side_intent=side,
        regime_4h=regime_4h,
        regime_1h=regime_1h,
        structure_1h=structure_1h,
        oi_status=oi_status,
        pullback_volume=pullback_volume,
        pattern=pattern,
        decision=decision,
        reasons=reasons,
        feature_flags=flags,
        hypothesis_filters=hypotheses,
    )


def feature_combo_key(flags: dict[str, Any] | None) -> str:
    """稳定、可回放的消融组合键（与 expectancy_combo 共用）。"""
    if not flags:
        return "empty"
    parts: list[str] = []
    for k in sorted(flags):
        v = flags[k]
        if v is None:
            continue
        if isinstance(v, bool):
            parts.append(f"{k}={int(v)}")
        else:
            parts.append(f"{k}={v}")
    return "|".join(parts)[:240]
