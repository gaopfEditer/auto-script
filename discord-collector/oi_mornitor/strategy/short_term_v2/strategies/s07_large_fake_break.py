"""S07 大市值假突破 / 流动性抓取失败（第一梯队重点）。"""
from __future__ import annotations

import numpy as np

from oi_mornitor.strategy.short_term_v2.common import (
    BarContext,
    base_gates,
    check_rr,
    structure_stop_target,
)
from oi_mornitor.strategy.short_term_v2.metrics import atr_at, oi_change_pct
from oi_mornitor.strategy.short_term_v2.params import FAKE_BREAK_OI_T1, tier_param
from oi_mornitor.strategy.short_term_v2.signal import V2Signal


def _align_1h(ctx: BarContext) -> int | None:
    if ctx.df_1h is None or len(ctx.df_1h) < 25:
        return None
    t = ctx.ts()
    times = ctx.df_1h["open_time"].astype("int64").to_numpy()
    if times.size and int(times[-1]) < 1e12 and t and t > 1e12:
        times = times * 1000
    j = int(np.searchsorted(times, int(t or 0), side="right") - 1)
    return j if j >= 21 else None


def scan_s07(ctx: BarContext) -> list[V2Signal]:
    if ctx.market_cap_tier > 2:
        return []  # 第三梯队用 S06
    gate = base_gates(ctx)
    if not gate.ok and gate.reason in ("tier_skipped", "platform_halt"):
        return []
    j = _align_1h(ctx)
    if j is None or j < 2:
        return []

    hi = float(ctx.df_1h["high"].iloc[j - 20 : j].max())
    lo = float(ctx.df_1h["low"].iloc[j - 20 : j].min())
    # 突破发生在 j-1，确认在当前 15m
    prow = ctx.df_1h.iloc[j - 1]
    crow_1h = ctx.df_1h.iloc[j]
    oi = oi_change_pct(ctx.df_1h, j - 1)
    funding = None
    if "funding" in ctx.df_1h.columns:
        try:
            funding = float(ctx.df_1h.iloc[j - 1]["funding"])
        except (TypeError, ValueError):
            funding = None

    out: list[V2Signal] = []
    # A. 前高假突破 → 做空
    if (
        float(prow["high"]) > hi
        and float(prow["close"]) < hi
        and oi is not None
        and oi >= FAKE_BREAK_OI_T1
        and float(crow_1h["close"]) < hi
    ):
        # 下一根 15m 反弹无法重新站上前高
        row = ctx.df_15m.iloc[ctx.idx]
        if float(row["close"]) < hi and float(row["high"]) <= hi * 1.001:
            direction = "short"
            entry = float(row["close"])
            atr = atr_at(ctx.df_15m, ctx.idx)
            stop, target = structure_stop_target(
                entry=entry, direction=direction, structure_level=hi, atr=atr, reward_r=1.5
            )
            rr = check_rr(entry=entry, stop=stop, target=target, direction=direction,
                          fee_pct=ctx.fee_pct, slip_pct=ctx.slip_pct)
            if rr.ok:
                ev = [
                    "1H 前高假突破",
                    f"OIΔ={oi:.2f}%",
                    "15m 未能收复前高",
                    *rr.evidence,
                ]
                if funding is not None:
                    ev.append(f"funding={funding:.6f}")
                out.append(V2Signal(
                    signal_type="S07",
                    market_cap_tier=ctx.market_cap_tier,
                    symbol=ctx.symbol,
                    direction=direction,
                    status="entry_ready",
                    trigger_idx=ctx.idx,
                    trigger_time=ctx.ts(),
                    confirm_idx=ctx.idx,
                    confirm_time=ctx.ts(),
                    entry_idx=ctx.idx,
                    entry_time=ctx.ts(),
                    entry_price=entry,
                    stop_price=stop,
                    target_price=target,
                    structure_level=hi,
                    oi_change_pct=oi,
                    risk_r=tier_param(ctx.market_cap_tier, "risk_r"),
                    evidence=ev,
                    data_flags={"funding": funding, "1h_idx": j},
                ))

    # B. 前低假跌破 → 做多
    if (
        float(prow["low"]) < lo
        and float(prow["close"]) > lo
        and float(crow_1h["close"]) > lo
    ):
        row = ctx.df_15m.iloc[ctx.idx]
        if float(row["close"]) > lo and float(row["low"]) >= lo * 0.999:
            oi2 = oi_change_pct(ctx.df_15m, ctx.idx)
            # OI 不再持续下降
            if oi2 is not None and oi2 < -1.0:
                return out
            direction = "long"
            entry = float(row["close"])
            atr = atr_at(ctx.df_15m, ctx.idx)
            stop, target = structure_stop_target(
                entry=entry, direction=direction, structure_level=lo, atr=atr, reward_r=1.5
            )
            rr = check_rr(entry=entry, stop=stop, target=target, direction=direction,
                          fee_pct=ctx.fee_pct, slip_pct=ctx.slip_pct)
            if rr.ok:
                out.append(V2Signal(
                    signal_type="S07",
                    market_cap_tier=ctx.market_cap_tier,
                    symbol=ctx.symbol,
                    direction=direction,
                    status="entry_ready",
                    trigger_idx=ctx.idx,
                    trigger_time=ctx.ts(),
                    confirm_idx=ctx.idx,
                    confirm_time=ctx.ts(),
                    entry_idx=ctx.idx,
                    entry_time=ctx.ts(),
                    entry_price=entry,
                    stop_price=stop,
                    target_price=target,
                    structure_level=lo,
                    oi_change_pct=oi2,
                    risk_r=tier_param(ctx.market_cap_tier, "risk_r"),
                    evidence=["1H 前低假跌破收回", "15m 回踩不破", *rr.evidence],
                    data_flags={"1h_idx": j},
                ))
    return out
