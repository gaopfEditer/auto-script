"""仓位 = (E × r) / |P − S|。r 是单笔风险预算（占权益），不是名义仓位占比。"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Iterable

from oi_mornitor.strategy.short_term_v1.params import (
    CONCURRENT_RISK_CAP_PERCENT,
    CORRELATED_CLUSTER,
    DEFAULT_EQUITY,
    MIN_POSITION_QTY,
    risk_percent_for,
)


@dataclass
class SizeResult:
    equity: float
    risk_percent: float
    risk_amount: float
    entry: float
    stop: float
    qty: float
    skipped: bool = False
    skip_reason: str | None = None
    concurrent_risk_percent: float = 0.0
    cluster: str = CORRELATED_CLUSTER

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def position_qty(
    equity: float,
    risk_percent: float,
    entry: float,
    stop: float,
) -> float:
    """仓位数量 = (E × r) / |P − S|。risk_percent 为百分数，如 0.40 表示 0.40%。"""
    e = float(equity)
    r = float(risk_percent) / 100.0
    p = float(entry)
    s = float(stop)
    dist = abs(p - s)
    if e <= 0 or r <= 0 or dist <= 0 or p <= 0:
        return 0.0
    return (e * r) / dist


def size_trade(
    *,
    entry: float,
    stop: float,
    tier: str,
    equity: float = DEFAULT_EQUITY,
    per_tier: bool = True,
    risk_percent: float | None = None,
    open_risk_percents: Iterable[float] | None = None,
    concurrent_cap: float = CONCURRENT_RISK_CAP_PERCENT,
    size_down_mult: float = 1.0,
) -> SizeResult:
    rp = float(risk_percent if risk_percent is not None else risk_percent_for(tier, per_tier=per_tier))
    if size_down_mult < 1.0:
        rp = rp * max(0.0, size_down_mult)
    open_sum = sum(float(x) for x in (open_risk_percents or []) if x)
    if open_sum + rp > concurrent_cap + 1e-12:
        return SizeResult(
            equity=float(equity),
            risk_percent=rp,
            risk_amount=float(equity) * rp / 100.0,
            entry=float(entry),
            stop=float(stop),
            qty=0.0,
            skipped=True,
            skip_reason="concurrent_risk_cap",
            concurrent_risk_percent=open_sum,
        )
    qty = position_qty(equity, rp, entry, stop)
    if qty < MIN_POSITION_QTY:
        return SizeResult(
            equity=float(equity),
            risk_percent=rp,
            risk_amount=float(equity) * rp / 100.0,
            entry=float(entry),
            stop=float(stop),
            qty=0.0,
            skipped=True,
            skip_reason="position_too_small",
            concurrent_risk_percent=open_sum,
        )
    return SizeResult(
        equity=float(equity),
        risk_percent=rp,
        risk_amount=float(equity) * rp / 100.0,
        entry=float(entry),
        stop=float(stop),
        qty=qty,
        concurrent_risk_percent=open_sum + rp,
    )
