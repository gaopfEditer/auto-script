"""短线策略 V1：在现有 OI / 形态 / Vegas / 环境数据之上的决策层。研究框架，非已验证优势。"""

from oi_mornitor.strategy.short_term_v1.ablation import ExperimentFlags, flags_for
from oi_mornitor.strategy.short_term_v1.decision import TradeDecision, build_decision
from oi_mornitor.strategy.short_term_v1.params import RESEARCH_DISCLAIMER, defaults_dict
from oi_mornitor.strategy.short_term_v1.sizing import position_qty
from oi_mornitor.strategy.short_term_v1.tiers import classify_tier

__all__ = [
    "ExperimentFlags",
    "TradeDecision",
    "RESEARCH_DISCLAIMER",
    "build_decision",
    "classify_tier",
    "defaults_dict",
    "flags_for",
    "position_qty",
]
