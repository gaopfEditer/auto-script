"""短线策略 V2：与 V1（现有形态/MTF/setup）并行的独立可编程机会规则。

默认不叠加进 V1。可用 parallel.run_parallel_on_frames 同步产出两套信号。
"""

from oi_mornitor.strategy.short_term_v2.params import (
    BATCH1_STRATEGIES,
    RESEARCH_DISCLAIMER,
    STRATEGY_IDS,
    STRATEGY_VERSION,
    defaults_dict,
)
from oi_mornitor.strategy.short_term_v2.signal import V2Signal
from oi_mornitor.strategy.short_term_v2.tiers import classify_v2_tier

__all__ = [
    "BATCH1_STRATEGIES",
    "RESEARCH_DISCLAIMER",
    "STRATEGY_IDS",
    "STRATEGY_VERSION",
    "V2Signal",
    "classify_v2_tier",
    "defaults_dict",
]
