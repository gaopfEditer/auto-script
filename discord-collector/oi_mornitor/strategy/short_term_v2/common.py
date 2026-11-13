"""所有 V2 策略共用的基础约束检查（§一.1）。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from oi_mornitor.strategy.short_term_v2.metrics import atr_at, bar_ts, oi_change_abs, oi_change_pct, rvol_at
from oi_mornitor.strategy.short_term_v2.params import (
    DEFAULT_FEE_PCT,
    DEFAULT_SLIP_PCT,
    MAX_CHASE_ATR,
    MIN_RR_AFTER_COST,
    tier_param,
)
from oi_mornitor.strategy.short_term_v2.tiers import V2Tier


@dataclass
class BarContext:
    symbol: str
    tier: V2Tier
    idx: int
    df_15m: pd.DataFrame
    df_1h: pd.DataFrame | None = None
    df_4h: pd.DataFrame | None = None
    df_1d: pd.DataFrame | None = None
    df_btc_15m: pd.DataFrame | None = None
    liq_events: list[dict[str, Any]] | None = None
    order_notional: float = 1000.0  # 预期下单金额，用于深度倍数
    event_flags: dict[str, Any] = field(default_factory=dict)  # 解锁/下架等
    fee_pct: float = DEFAULT_FEE_PCT
    slip_pct: float = DEFAULT_SLIP_PCT

    @property
    def market_cap_tier(self) -> int:
        return int(self.tier.market_cap_tier)

    def ts(self) -> int | None:
        return bar_ts(self.df_15m, self.idx)


@dataclass
class GateResult:
    ok: bool
    reason: str | None = None
    metrics: dict[str, Any] = field(default_factory=dict)
    evidence: list[str] = field(default_factory=list)


def closed_bar_only(df: pd.DataFrame, idx: int) -> bool:
    """只使用已收盘 K 线：扫描到 idx 时视为该根已收盘（回测约定）。"""
    return df is not None and 0 <= idx < len(df)


def check_rvol_trigger(ctx: BarContext) -> GateResult:
    thr = tier_param(ctx.market_cap_tier, "rvol_15m")
    rv = rvol_at(ctx.df_15m, ctx.idx)
    m = {"rvol": rv, "rvol_threshold": thr}
    if rv is None:
        return GateResult(False, "rvol_unavailable", m)
    if rv < thr:
        return GateResult(False, "rvol_below_threshold", m, [f"RVOL={rv:.2f} < {thr}"])
    return GateResult(True, None, m, [f"RVOL={rv:.2f} ≥ {thr}"])


def check_oi_trigger(ctx: BarContext, *, use_1h: bool = False) -> GateResult:
    key = "oi_1h_pct" if use_1h else "oi_15m_pct"
    thr = tier_param(ctx.market_cap_tier, key)
    df = ctx.df_1h if use_1h else ctx.df_15m
    idx = ctx.idx
    if use_1h:
        if ctx.df_1h is None or len(ctx.df_1h) < 2:
            return GateResult(False, "oi_1h_unavailable", {})
        # 对齐到 1h 末根 ≤ 当前 15m 时间
        from oi_mornitor.strategy.short_term_v2.metrics import bar_ts as _ts
        import numpy as np

        t = _ts(ctx.df_15m, ctx.idx)
        if t is None:
            return GateResult(False, "oi_1h_unavailable", {})
        times = ctx.df_1h["open_time"].astype("int64").to_numpy()
        if times.size and int(times[-1]) < 1e12 and t > 1e12:
            times = times * 1000
        idx = int(np.searchsorted(times, int(t), side="right") - 1)
        if idx < 1:
            return GateResult(False, "oi_1h_unavailable", {})
        df = ctx.df_1h
    chg = oi_change_pct(df, idx)
    abs_chg = oi_change_abs(df, idx)
    m = {"oi_change_pct": chg, "oi_change_abs": abs_chg, "oi_threshold_pct": thr}
    if chg is None:
        return GateResult(False, "oi_unavailable", m)
    # 第三梯队：百分比大但绝对量很小则不算异常
    if ctx.market_cap_tier == 3 and abs_chg is not None and abs(abs_chg) < 50_000:
        return GateResult(False, "oi_abs_too_small_t3", m, ["第三梯队 OI 绝对变化过小"])
    if abs(chg) < thr:
        return GateResult(False, "oi_below_threshold", m)
    return GateResult(True, None, m, [f"OIΔ={chg:.2f}% ≥ {thr}%"])


def check_spread_depth(ctx: BarContext) -> GateResult:
    thr_spread = tier_param(ctx.market_cap_tier, "spread_max_pct")
    depth_mult = tier_param(ctx.market_cap_tier, "depth_mult")
    evidence: list[str] = []
    m: dict[str, Any] = {
        "spread_pct": ctx.tier.spread_pct,
        "spread_max_pct": thr_spread,
        "depth": ctx.tier.depth,
        "depth_mult": depth_mult,
        "order_notional": ctx.order_notional,
    }
    if ctx.tier.spread_pct is not None and ctx.tier.spread_pct > thr_spread:
        return GateResult(False, "spread_too_wide", m, [f"价差 {ctx.tier.spread_pct}% > {thr_spread}%"])
    if ctx.market_cap_tier == 3 and ctx.tier.depth_missing:
        return GateResult(False, "t3_depth_missing", m, ["第三梯队缺少盘口深度"])
    if ctx.tier.depth is not None:
        need = ctx.order_notional * depth_mult
        m["depth_required"] = need
        if ctx.tier.depth < need:
            return GateResult(False, "depth_insufficient", m, [f"深度 {ctx.tier.depth:.0f} < 需求 {need:.0f}"])
        evidence.append(f"深度 {ctx.tier.depth:.0f} ≥ {need:.0f}")
    else:
        evidence.append("depth_missing：未虚构深度，非 T3 允许继续")
    return GateResult(True, None, m, evidence)


def check_event_risk(ctx: BarContext) -> GateResult:
    flags = ctx.event_flags or {}
    if flags.get("delisted") or flags.get("deposit_suspended") or flags.get("trading_halted"):
        return GateResult(False, "platform_halt", {"event_flags": flags}, ["平台暂停/下架，禁止新开仓"])
    if ctx.market_cap_tier == 3 and flags.get("major_unlock"):
        return GateResult(False, "t3_major_unlock", {"event_flags": flags}, ["第三梯队重大解锁过滤"])
    return GateResult(True, None, {"event_flags": flags})


def check_chase_distance(
    *,
    close: float,
    level: float,
    atr: float,
    direction: str,
    max_atr: float = MAX_CHASE_ATR,
) -> GateResult:
    if atr <= 0 or level <= 0:
        return GateResult(False, "atr_or_level_invalid", {})
    dist = abs(close - level) / atr
    m = {"chase_atr": dist, "max_chase_atr": max_atr}
    if dist > max_atr:
        return GateResult(False, "chase_too_far", m, [f"距突破位 {dist:.2f} ATR > {max_atr}"])
    return GateResult(True, None, m)


def check_rr(
    *,
    entry: float,
    stop: float,
    target: float,
    direction: str,
    fee_pct: float = DEFAULT_FEE_PCT,
    slip_pct: float = DEFAULT_SLIP_PCT,
) -> GateResult:
    risk = abs(entry - stop)
    reward = abs(target - entry)
    if risk <= 0:
        return GateResult(False, "zero_risk", {})
    cost = entry * (fee_pct + slip_pct) * 2 / 100.0
    net_reward = reward - cost
    rr = net_reward / risk
    m = {"risk": risk, "reward": reward, "cost": cost, "rr_after_cost": rr}
    if rr < MIN_RR_AFTER_COST:
        return GateResult(False, "rr_insufficient", m, [f"费后 RR={rr:.2f} < {MIN_RR_AFTER_COST}"])
    return GateResult(True, None, m, [f"费后 RR={rr:.2f}"])


def base_gates(ctx: BarContext, *, require_rvol: bool = False, require_oi: bool = False) -> GateResult:
    """基础闸：收盘有效、事件风险、价差深度；可选 RVOL/OI 触发。"""
    if ctx.tier.skipped or ctx.market_cap_tier < 1:
        return GateResult(False, ctx.tier.skip_reason or "tier_skipped", {})
    if not closed_bar_only(ctx.df_15m, ctx.idx):
        return GateResult(False, "bar_invalid", {})
    ev = check_event_risk(ctx)
    if not ev.ok:
        return ev
    sd = check_spread_depth(ctx)
    if not sd.ok:
        return sd
    evidence = list(sd.evidence)
    metrics = dict(sd.metrics)
    if require_rvol:
        rv = check_rvol_trigger(ctx)
        metrics.update(rv.metrics)
        if not rv.ok:
            return GateResult(False, rv.reason, metrics, evidence + rv.evidence)
        evidence.extend(rv.evidence)
    if require_oi:
        oi = check_oi_trigger(ctx)
        metrics.update(oi.metrics)
        if not oi.ok:
            return GateResult(False, oi.reason, metrics, evidence + oi.evidence)
        evidence.extend(oi.evidence)
    atr = atr_at(ctx.df_15m, ctx.idx)
    metrics["atr_15m"] = atr
    return GateResult(True, None, metrics, evidence)


def structure_stop_target(
    *,
    entry: float,
    direction: str,
    structure_level: float,
    atr: float,
    reward_r: float = 1.5,
) -> tuple[float, float]:
    short = direction == "short"
    buf = abs(structure_level) * 0.0005
    if short:
        stop = max(structure_level, entry) + buf
        risk = abs(stop - entry)
        if risk <= 0 and atr > 0:
            stop = entry + atr
            risk = atr
        target = entry - risk * reward_r
    else:
        stop = min(structure_level, entry) - buf
        risk = abs(entry - stop)
        if risk <= 0 and atr > 0:
            stop = entry - atr
            risk = atr
        target = entry + risk * reward_r
    return float(stop), float(target)
