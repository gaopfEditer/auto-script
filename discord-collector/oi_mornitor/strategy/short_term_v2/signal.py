"""V2 统一信号对象（§十六 验证字段）。"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from oi_mornitor.strategy.short_term_v2.params import STRATEGY_LABELS, STRATEGY_VERSION


@dataclass
class V2Signal:
    signal_type: str  # S01..S13
    market_cap_tier: int
    trigger_time: int | None = None
    confirm_time: int | None = None
    entry_time: int | None = None
    direction: str | None = None  # long / short
    entry_price: float | None = None
    stop_price: float | None = None
    target_price: float | None = None
    price_return: float | None = None
    net_return: float | None = None
    MAE: float | None = None
    MFE: float | None = None
    exit_reason: str | None = None

    # 扩展元数据（回测/并行合并用）
    strategy_version: str = STRATEGY_VERSION
    symbol: str = ""
    status: str = "triggered"  # triggered / confirmed / entry_ready / skipped / observe / traded
    skip_reason: str | None = None
    evidence: list[str] = field(default_factory=list)
    data_flags: dict[str, Any] = field(default_factory=dict)
    structure_level: float | None = None
    trigger_idx: int | None = None
    confirm_idx: int | None = None
    entry_idx: int | None = None
    exit_idx: int | None = None
    exit_price: float | None = None
    label: str = ""
    risk_r: float | None = None
    rvol: float | None = None
    oi_change_pct: float | None = None

    def __post_init__(self) -> None:
        if not self.label:
            self.label = STRATEGY_LABELS.get(self.signal_type, self.signal_type)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d


def make_observe(
    signal_type: str,
    *,
    symbol: str,
    market_cap_tier: int,
    trigger_time: int | None,
    trigger_idx: int | None,
    evidence: list[str] | None = None,
    data_flags: dict[str, Any] | None = None,
    **kwargs: Any,
) -> V2Signal:
    return V2Signal(
        signal_type=signal_type,
        market_cap_tier=market_cap_tier,
        trigger_time=trigger_time,
        trigger_idx=trigger_idx,
        symbol=symbol,
        status="observe",
        evidence=list(evidence or []),
        data_flags=dict(data_flags or {}),
        **kwargs,
    )


def make_skip(
    signal_type: str,
    *,
    symbol: str,
    market_cap_tier: int,
    reason: str,
    trigger_time: int | None = None,
    trigger_idx: int | None = None,
    evidence: list[str] | None = None,
) -> V2Signal:
    return V2Signal(
        signal_type=signal_type,
        market_cap_tier=market_cap_tier,
        trigger_time=trigger_time,
        trigger_idx=trigger_idx,
        symbol=symbol,
        status="skipped",
        skip_reason=reason,
        evidence=list(evidence or []),
    )
