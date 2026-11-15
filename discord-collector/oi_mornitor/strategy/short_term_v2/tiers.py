"""V2 市值梯队：复用 V1 的 A/B/C/D/E，映射到规则表第一/二/三梯队。

映射：A→1，B→2，C/D→3，E 默认排除。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from oi_mornitor.strategy.short_term_v1.tiers import TierAssignment, classify_tier

TIER_MAP = {"A": 1, "B": 2, "C": 3, "D": 3}
TIER_LABELS = {
    1: "第一梯队（核心高流动性）",
    2: "第二梯队（大市值山寨）",
    3: "第三梯队（中小市值 / 长尾）",
}


@dataclass
class V2Tier:
    symbol: str
    market_cap_tier: int  # 1/2/3
    v1_tier: str
    label: str
    depth: float | None = None
    depth_missing: bool = True
    spread_pct: float | None = None
    vol_30d_quote: float | None = None
    skipped: bool = False
    skip_reason: str | None = None
    evidence: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def from_v1(assignment: TierAssignment, *, spread_pct: float | None = None) -> V2Tier:
    if assignment.tier == "E" or assignment.is_equity_token:
        return V2Tier(
            symbol=assignment.symbol,
            market_cap_tier=0,
            v1_tier="E",
            label="美股代币（V2 默认排除）",
            depth=assignment.depth,
            depth_missing=assignment.depth_missing,
            spread_pct=spread_pct,
            vol_30d_quote=assignment.vol_30d_quote,
            skipped=True,
            skip_reason=assignment.skip_reason or "equity_token_excluded",
            evidence=list(assignment.evidence) + ["V2 不交易美股代币"],
        )
    mct = int(TIER_MAP.get(assignment.tier, 3))
    skipped = bool(assignment.skipped)
    reason = assignment.skip_reason
    evidence = list(assignment.evidence)
    evidence.append(f"V1 档位 {assignment.tier} → V2 第{mct}梯队")
    return V2Tier(
        symbol=assignment.symbol,
        market_cap_tier=mct,
        v1_tier=assignment.tier,
        label=TIER_LABELS.get(mct, f"tier-{mct}"),
        depth=assignment.depth,
        depth_missing=assignment.depth_missing,
        spread_pct=spread_pct,
        vol_30d_quote=assignment.vol_30d_quote,
        skipped=skipped,
        skip_reason=reason,
        evidence=evidence,
    )


def classify_v2_tier(
    symbol: str,
    *,
    vol_30d_quote: float | None = None,
    depth: float | None = None,
    spread_pct: float | None = None,
    df=None,
    end_idx: int | None = None,
) -> V2Tier:
    a = classify_tier(
        symbol,
        vol_30d_quote=vol_30d_quote,
        depth=depth,
        df=df,
        end_idx=end_idx,
        skip_d_without_depth=True,
        exclude_equity=True,
    )
    return from_v1(a, spread_pct=spread_pct)
