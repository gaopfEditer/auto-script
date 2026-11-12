"""统一交易决策对象，并依次回答五问：环境、附近流动性、确认、失效位置、盈亏是否值得。"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from oi_mornitor.strategy.short_term_v1.params import (
    MIN_FIRST_TARGET_R,
    STOP_VS_ATR_CAP_MULT,
    STRUCTURE_BUFFER_PCT,
    atr_cap_for,
    atr_k_for,
    risk_percent_for,
    take_profit_payload,
)
from oi_mornitor.strategy.sl_profiles import resolve_sl_price


@dataclass
class TradeDecision:
    symbol: str
    tier: str
    timeframe: str = "15m"
    market_regime: str = ""
    setup: str = ""
    direction: str | None = None
    entry: float | None = None
    stop_loss: float | None = None
    take_profit: list[dict[str, Any]] = field(default_factory=list)
    risk_percent: float | None = None
    position_qty: float | None = None
    evidence: list[str] = field(default_factory=list)
    invalidation: str | None = None
    skipped: bool = False
    skip_reason: str | None = None
    answers: dict[str, Any] = field(default_factory=dict)
    data_flags: dict[str, Any] = field(default_factory=dict)
    kind: str | None = None
    structure_level: float | None = None
    atr_15m: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def regime_stance(regime_4h: str | None, direction: str | None = None) -> str:
    r = str(regime_4h or "").lower()
    if r in ("trend_up", "uptrend", "up"):
        return "long"
    if r in ("trend_down", "downtrend", "down"):
        return "short"
    if r in ("range",):
        return "stand_aside_or_range"
    if r in ("transition", "high_vol", "high_vol_risk"):
        return "stand_aside"
    return "stand_aside" if not r else "stand_aside"


def compute_stop(
    *,
    entry: float,
    direction: str,
    structure_level: float | None,
    atr_15m: float | None,
    tier: str,
    per_tier: bool = True,
    slippage_buffer_pct: float = 0.0,
) -> tuple[float, str]:
    short = str(direction).lower() in ("short", "bear")
    k = atr_k_for(tier, per_tier=per_tier)
    # D 档：结构止损 + 滑点缓冲，不用纯 ATR 止损
    if tier == "D" and per_tier:
        sl, used = resolve_sl_price(
            entry=entry,
            is_short=short,
            structure_level=structure_level,
            atr=None,
            atr_k=1.5,
            profile="structure",
            buffer_pct=STRUCTURE_BUFFER_PCT + slippage_buffer_pct / 100.0,
        )
        return sl, used
    sl, used = resolve_sl_price(
        entry=entry,
        is_short=short,
        structure_level=structure_level,
        atr=atr_15m,
        atr_k=float(k or 1.5),
        profile="structure",
        buffer_pct=STRUCTURE_BUFFER_PCT,
    )
    return sl, used


def stop_too_wide(
    *,
    entry: float,
    stop: float,
    atr_15m: float | None,
    tier: str,
    per_tier: bool = True,
    multiplier: float = STOP_VS_ATR_CAP_MULT,
) -> tuple[bool, str | None]:
    """结构止损宽于 档位 ATR 上限 × 记录倍数 → 放弃。D 档无 ATR 上限时不按 ATR 砍，但过远仍由盈亏比检查。"""
    dist = abs(float(entry) - float(stop))
    if dist <= 0 or entry <= 0:
        return True, "invalid_stop"
    cap_k = atr_cap_for(tier, per_tier=per_tier)
    if atr_15m and atr_15m > 0 and cap_k:
        if dist > float(atr_15m) * float(cap_k) * float(multiplier):
            return True, "stop_too_wide"
    return False, None


def first_target_r(tier: str, *, per_tier: bool = True) -> float:
    tps = take_profit_payload(tier, per_tier=per_tier)
    for t in tps:
        if isinstance(t.get("r"), (int, float)):
            return float(t["r"])
    return MIN_FIRST_TARGET_R


def reward_worth_risk(tier: str, *, per_tier: bool = True, min_r: float = MIN_FIRST_TARGET_R) -> tuple[bool, str]:
    ft = first_target_r(tier, per_tier=per_tier)
    if ft + 1e-12 < min_r:
        return False, f"first_target_{ft}R_below_{min_r}R"
    return True, f"first_target_{ft}R"


def build_decision(
    *,
    symbol: str,
    tier: str,
    setup: str,
    direction: str | None,
    entry: float | None,
    structure_level: float | None,
    atr_15m: float | None,
    market_regime: str,
    evidence: list[str] | None = None,
    nearby_liquidity: str | None = None,
    volume_confirmed: bool | None = None,
    oi_status: str | None = None,
    flow_confirmed: bool | None = None,
    data_flags: dict[str, Any] | None = None,
    timeframe: str = "15m",
    per_tier: bool = True,
    kind: str | None = None,
    invalidation: str | None = None,
    force_skip: str | None = None,
    slippage_buffer_pct: float = 0.0,
) -> TradeDecision:
    ev = list(evidence or [])
    flags = dict(data_flags or {})
    stance = regime_stance(market_regime, direction)
    answers: dict[str, Any] = {
        "1_regime": stance,
        "2_nearby_liquidity": nearby_liquidity or "",
        "3_confirmation": {
            "volume": volume_confirmed,
            "oi": oi_status,
            "aggressive_flow": flow_confirmed,
        },
        "4_invalidation": invalidation,
        "5_reward_worth_risk": None,
    }
    if force_skip:
        return TradeDecision(
            symbol=symbol,
            tier=tier,
            timeframe=timeframe,
            market_regime=market_regime,
            setup=setup,
            direction=direction,
            evidence=ev,
            skipped=True,
            skip_reason=force_skip,
            answers=answers,
            data_flags=flags,
            kind=kind,
            structure_level=structure_level,
            atr_15m=atr_15m,
            invalidation=invalidation,
        )

    if direction is None or entry is None or entry <= 0:
        return TradeDecision(
            symbol=symbol,
            tier=tier,
            timeframe=timeframe,
            market_regime=market_regime,
            setup=setup,
            direction=direction,
            evidence=ev,
            skipped=True,
            skip_reason="no_entry",
            answers=answers,
            data_flags=flags,
            kind=kind,
            atr_15m=atr_15m,
        )

    # 问题 1：环境是否允许该方向
    if stance == "stand_aside" and str(market_regime or "").lower() in ("high_vol", "high_vol_risk", "transition"):
        return TradeDecision(
            symbol=symbol,
            tier=tier,
            timeframe=timeframe,
            market_regime=market_regime,
            setup=setup,
            direction=direction,
            entry=entry,
            evidence=ev + ["高波动或转换期观望"],
            skipped=True,
            skip_reason="regime_stand_aside",
            answers=answers,
            data_flags=flags,
            kind=kind,
            atr_15m=atr_15m,
        )

    sl, used_sl = compute_stop(
        entry=entry,
        direction=direction,
        structure_level=structure_level,
        atr_15m=atr_15m,
        tier=tier,
        per_tier=per_tier,
        slippage_buffer_pct=slippage_buffer_pct,
    )
    inv = invalidation or (
        "15m 结构低点被收盘跌破" if str(direction).lower() in ("long", "bull") else "15m 结构高点被收盘涨破"
    )
    answers["4_invalidation"] = inv

    too_wide, wide_reason = stop_too_wide(
        entry=entry, stop=sl, atr_15m=atr_15m, tier=tier, per_tier=per_tier
    )
    worth, worth_reason = reward_worth_risk(tier, per_tier=per_tier)
    answers["5_reward_worth_risk"] = {"ok": (not too_wide) and worth, "stop": wide_reason, "rr": worth_reason}

    tps = take_profit_payload(tier, per_tier=per_tier)
    rp = risk_percent_for(tier, per_tier=per_tier)

    if too_wide:
        ev.append(f"结构止损过远（{used_sl}），超过档位 ATR 上限×{STOP_VS_ATR_CAP_MULT}")
        return TradeDecision(
            symbol=symbol,
            tier=tier,
            timeframe=timeframe,
            market_regime=market_regime,
            setup=setup,
            direction=direction,
            entry=entry,
            stop_loss=sl,
            take_profit=tps,
            risk_percent=rp,
            evidence=ev,
            invalidation=inv,
            skipped=True,
            skip_reason=wide_reason or "stop_too_wide",
            answers=answers,
            data_flags=flags,
            kind=kind,
            structure_level=structure_level,
            atr_15m=atr_15m,
        )
    if not worth:
        ev.append(worth_reason)
        return TradeDecision(
            symbol=symbol,
            tier=tier,
            timeframe=timeframe,
            market_regime=market_regime,
            setup=setup,
            direction=direction,
            entry=entry,
            stop_loss=sl,
            take_profit=tps,
            risk_percent=rp,
            evidence=ev,
            invalidation=inv,
            skipped=True,
            skip_reason="rr_insufficient",
            answers=answers,
            data_flags=flags,
            kind=kind,
            structure_level=structure_level,
            atr_15m=atr_15m,
        )

    ev.append(f"止损口径 {used_sl}")
    return TradeDecision(
        symbol=symbol,
        tier=tier,
        timeframe=timeframe,
        market_regime=market_regime,
        setup=setup,
        direction=direction,
        entry=entry,
        stop_loss=sl,
        take_profit=tps,
        risk_percent=rp,
        evidence=ev,
        invalidation=inv,
        skipped=False,
        skip_reason=None,
        answers=answers,
        data_flags=flags,
        kind=kind,
        structure_level=structure_level,
        atr_15m=atr_15m,
    )
