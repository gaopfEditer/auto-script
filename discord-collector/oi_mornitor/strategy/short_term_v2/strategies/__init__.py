"""V2 策略注册表：编号 → 扫描函数。"""
from __future__ import annotations

from typing import Callable

from oi_mornitor.strategy.short_term_v2.common import BarContext
from oi_mornitor.strategy.short_term_v2.params import BATCH1_STRATEGIES, BATCH2_STRATEGIES
from oi_mornitor.strategy.short_term_v2.signal import V2Signal
from oi_mornitor.strategy.short_term_v2.strategies.s01_pattern_volume import scan_s01
from oi_mornitor.strategy.short_term_v2.strategies.s03_liq_reversal import scan_s03
from oi_mornitor.strategy.short_term_v2.strategies.s04_liq_continuation import scan_s04
from oi_mornitor.strategy.short_term_v2.strategies.s05_quiet_revival import scan_s05
from oi_mornitor.strategy.short_term_v2.strategies.s06_small_fake_break import scan_s06
from oi_mornitor.strategy.short_term_v2.strategies.s07_large_fake_break import scan_s07
from oi_mornitor.strategy.short_term_v2.strategies.s10_oi_anomaly import scan_s10
from oi_mornitor.strategy.short_term_v2.strategies.stubs import (
    scan_s02,
    scan_s08,
    scan_s09,
    scan_s11,
    scan_s12,
    scan_s13,
)

Scanner = Callable[[BarContext], list[V2Signal]]

SCANNERS: dict[str, Scanner] = {
    "S01": scan_s01,
    "S02": scan_s02,
    "S03": scan_s03,
    "S04": scan_s04,
    "S05": scan_s05,
    "S06": scan_s06,
    "S07": scan_s07,
    "S08": scan_s08,
    "S09": scan_s09,
    "S10": scan_s10,
    "S11": scan_s11,
    "S12": scan_s12,
    "S13": scan_s13,
}


def enabled_scanners(
    *,
    strategies: list[str] | None = None,
    include_batch2: bool = False,
) -> dict[str, Scanner]:
    if strategies:
        ids = [s.upper() for s in strategies]
    else:
        ids = list(BATCH1_STRATEGIES)
        if include_batch2:
            ids.extend(BATCH2_STRATEGIES)
    return {k: SCANNERS[k] for k in ids if k in SCANNERS}
