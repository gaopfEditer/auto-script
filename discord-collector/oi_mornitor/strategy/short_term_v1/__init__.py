"""短线策略 V1（基准）：现有形态 / MTF / setup 信号列表与产生策略。

与 `short_term_v2` 并行独立；不要把 V2 规则默认叠进本包。
"""

from oi_mornitor.strategy.short_term_v1.ablation import ExperimentFlags, flags_for
from oi_mornitor.strategy.short_term_v1.decision import TradeDecision, build_decision
from oi_mornitor.strategy.short_term_v1.params import (
    RESEARCH_DISCLAIMER,
    STRATEGY_VERSION,
    defaults_dict,
)
from oi_mornitor.strategy.short_term_v1.sizing import position_qty
from oi_mornitor.strategy.short_term_v1.tiers import classify_tier

__all__ = [
    "ExperimentFlags",
    "TradeDecision",
    "RESEARCH_DISCLAIMER",
    "STRATEGY_VERSION",
    "build_decision",
    "classify_tier",
    "defaults_dict",
    "flags_for",
    "position_qty",
]
