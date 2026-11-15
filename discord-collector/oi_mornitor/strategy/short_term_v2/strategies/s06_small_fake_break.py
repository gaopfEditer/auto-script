"""S06 小币假突破诱多/诱空（第三梯队重点）。"""
from __future__ import annotations

from oi_mornitor.strategy.short_term_v2.common import (
    BarContext,
    base_gates,
    check_rr,
    structure_stop_target,
)
from oi_mornitor.strategy.short_term_v2.metrics import atr_at, bar_ts, lookback_high, lookback_low, oi_change_pct, rvol_at
from oi_mornitor.strategy.short_term_v2.params import FAKE_BREAK_OI_T3, FAKE_BREAK_RVOL_T3, tier_param
from oi_mornitor.strategy.short_term_v2.signal import V2Signal


def scan_s06(ctx: BarContext) -> list[V2Signal]:
    # 第三梯队重点；第二梯队可监控；第一梯队低优先级（仍允许但不主动放宽）
    if ctx.market_cap_tier == 1:
        return []
    gate = base_gates(ctx)
    if not gate.ok:
        return []
    lookback = 20
    if ctx.idx < lookback + 2:
        return []

    # 找前一根是否假突破
    prev = ctx.idx - 1
    hi = lookback_high(ctx.df_15m, prev, lookback)
    lo = lookback_low(ctx.df_15m, prev, lookback)
    if hi is None or lo is None:
        return []
    prow = ctx.df_15m.iloc[prev]
    crow = ctx.df_15m.iloc[ctx.idx]
    rv = rvol_at(ctx.df_15m, prev)
    oi = oi_change_pct(ctx.df_15m, prev)
    thr_rvol = FAKE_BREAK_RVOL_T3 if ctx.market_cap_tier == 3 else tier_param(2, "rvol_15m")
    thr_oi = FAKE_BREAK_OI_T3 if ctx.market_cap_tier == 3 else tier_param(2, "oi_15m_pct")

    out: list[V2Signal] = []

    # A. 假突破诱多 → 做空
    if (
        float(prow["high"]) > hi
        and float(prow["close"]) < hi
        and rv is not None
        and rv >= thr_rvol
        and oi is not None
        and oi >= thr_oi
        and float(crow["close"]) < hi
        and float(crow["high"]) < float(prow["high"])
    ):
        direction = "short"
        level = hi
        entry = float(crow["close"])
        atr = atr_at(ctx.df_15m, ctx.idx)
        stop, target = structure_stop_target(
            entry=entry, direction=direction, structure_level=level, atr=atr, reward_r=1.2
        )
        rr = check_rr(entry=entry, stop=stop, target=target, direction=direction,
                      fee_pct=ctx.fee_pct, slip_pct=ctx.slip_pct)
        if rr.ok:
            out.append(V2Signal(
                signal_type="S06",
                market_cap_tier=ctx.market_cap_tier,
                symbol=ctx.symbol,
                direction=direction,
                status="entry_ready",
                trigger_idx=prev,
                trigger_time=bar_ts(ctx.df_15m, prev),
                confirm_idx=ctx.idx,
                confirm_time=ctx.ts(),
                entry_idx=ctx.idx,
                entry_time=ctx.ts(),
                entry_price=entry,
                stop_price=stop,
                target_price=target,
                structure_level=level,
                rvol=rv,
                oi_change_pct=oi,
                risk_r=tier_param(ctx.market_cap_tier, "risk_r"),
                evidence=[
                    "前高假突破诱多",
                    f"突破RVOL={rv:.2f}",
                    f"OIΔ={oi:.2f}%",
                    "确认根未能收复前高",
                    *rr.evidence,
                ],
            ))

    # B. 假跌破诱空 → 做多
    if (
        float(prow["low"]) < lo
        and float(prow["close"]) > lo
        and rv is not None
        and rv >= thr_rvol
        and float(crow["close"]) > lo
        and float(crow["low"]) > float(prow["low"])
    ):
        direction = "long"
        level = lo
        entry = float(crow["close"])
        atr = atr_at(ctx.df_15m, ctx.idx)
        stop, target = structure_stop_target(
            entry=entry, direction=direction, structure_level=level, atr=atr, reward_r=1.2
        )
        rr = check_rr(entry=entry, stop=stop, target=target, direction=direction,
                      fee_pct=ctx.fee_pct, slip_pct=ctx.slip_pct)
        if rr.ok:
            out.append(V2Signal(
                signal_type="S06",
                market_cap_tier=ctx.market_cap_tier,
                symbol=ctx.symbol,
                direction=direction,
                status="entry_ready",
                trigger_idx=prev,
                trigger_time=bar_ts(ctx.df_15m, prev),
                confirm_idx=ctx.idx,
                confirm_time=ctx.ts(),
                entry_idx=ctx.idx,
                entry_time=ctx.ts(),
                entry_price=entry,
                stop_price=stop,
                target_price=target,
                structure_level=level,
                rvol=rv,
                oi_change_pct=oi,
                risk_r=tier_param(ctx.market_cap_tier, "risk_r"),
                evidence=[
                    "前低假跌破诱空",
                    f"放量RVOL={rv:.2f}",
                    "确认根低点未创新低",
                    *rr.evidence,
                ],
            ))
    return out
