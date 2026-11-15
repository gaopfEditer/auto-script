"""S04 清算之后趋势延续（独立于 S03 反转）。"""
from __future__ import annotations

import numpy as np

from oi_mornitor.strategy.short_term_v2.common import (
    BarContext,
    base_gates,
    check_rr,
    structure_stop_target,
)
from oi_mornitor.strategy.short_term_v2.metrics import atr_at, bar_ts, lookback_high, lookback_low, oi_change_pct, rvol_at
from oi_mornitor.strategy.short_term_v2.params import tier_param
from oi_mornitor.strategy.short_term_v2.signal import V2Signal
from oi_mornitor.strategy.short_term_v2.strategies.s03_liq_reversal import (
    _historical_liq_series,
    _liq_notional_at,
    _pctile,
)


def scan_s04(ctx: BarContext) -> list[V2Signal]:
    gate = base_gates(ctx)
    if not gate.ok and gate.reason in ("tier_skipped", "platform_halt", "t3_depth_missing"):
        return []
    if ctx.idx < 50 or not ctx.liq_events:
        return []

    # 在过去 8 根内找清算冲击峰，当前根为延续确认
    hist_full = _historical_liq_series(ctx, ctx.idx)
    pctile = tier_param(ctx.market_cap_tier, "liq_pctile")
    thr = _pctile(hist_full, pctile)
    if thr is None:
        return []

    shock_idx = None
    for i in range(ctx.idx - 1, max(ctx.idx - 8, 20) - 1, -1):
        # hist_full 对齐 start..ctx.idx；简化：直接算该根清算
        t = bar_ts(ctx.df_15m, i)
        if _liq_notional_at(ctx.liq_events, t) >= thr:
            shock_idx = i
            break
    if shock_idx is None:
        return []

    shock_row = ctx.df_15m.iloc[shock_idx]
    shock_prev = ctx.df_15m.iloc[shock_idx - 1]
    # 清算后下跌未收复 → 顺势做空；上涨未收复 → 顺势做多
    if float(shock_row["close"]) < float(shock_prev["close"]):
        direction = "short"
        level = lookback_low(ctx.df_15m, shock_idx, 20)
        if level is None:
            return []
        # 价格没有收回原支撑
        if float(ctx.df_15m.iloc[ctx.idx]["close"]) > level:
            return []
    else:
        direction = "long"
        level = lookback_high(ctx.df_15m, shock_idx, 20)
        if level is None:
            return []
        if float(ctx.df_15m.iloc[ctx.idx]["close"]) < level:
            return []

    # 1H 趋势同向
    if ctx.df_1h is None or len(ctx.df_1h) < 25:
        return []
    t = ctx.ts()
    times = ctx.df_1h["open_time"].astype("int64").to_numpy()
    if times.size and int(times[-1]) < 1e12 and t and t > 1e12:
        times = times * 1000
    j = int(np.searchsorted(times, int(t or 0), side="right") - 1)
    if j < 20:
        return []
    ema_fast = float(ctx.df_1h["close"].iloc[: j + 1].ewm(span=20, adjust=False).mean().iloc[-1])
    ema_slow = float(ctx.df_1h["close"].iloc[: j + 1].ewm(span=50, adjust=False).mean().iloc[-1])
    if direction == "short" and not (ema_fast < ema_slow):
        return []
    if direction == "long" and not (ema_fast > ema_slow):
        return []

    # 反弹/回撤缩量 + OI 重新增加
    rv = rvol_at(ctx.df_15m, ctx.idx)
    rv_shock = rvol_at(ctx.df_15m, shock_idx)
    if rv is None or rv_shock is None or rv >= rv_shock * 0.9:
        return []
    oi_now = oi_change_pct(ctx.df_15m, ctx.idx)
    if oi_now is None or oi_now <= 0.5:
        return []

    if ctx.market_cap_tier == 3:
        sd = base_gates(ctx)
        if not sd.ok:
            return []

    entry = float(ctx.df_15m.iloc[ctx.idx]["close"])
    atr = atr_at(ctx.df_15m, ctx.idx)
    stop, target = structure_stop_target(
        entry=entry, direction=direction, structure_level=float(level), atr=atr, reward_r=1.5
    )
    rr = check_rr(entry=entry, stop=stop, target=target, direction=direction,
                  fee_pct=ctx.fee_pct, slip_pct=ctx.slip_pct)
    if not rr.ok:
        return []

    return [V2Signal(
        signal_type="S04",
        market_cap_tier=ctx.market_cap_tier,
        symbol=ctx.symbol,
        direction=direction,
        status="entry_ready",
        trigger_idx=shock_idx,
        trigger_time=bar_ts(ctx.df_15m, shock_idx),
        confirm_idx=ctx.idx,
        confirm_time=ctx.ts(),
        entry_idx=ctx.idx,
        entry_time=ctx.ts(),
        entry_price=entry,
        stop_price=stop,
        target_price=target,
        structure_level=float(level),
        oi_change_pct=oi_now,
        rvol=rv,
        risk_r=tier_param(ctx.market_cap_tier, "risk_r"),
        evidence=[
            f"清算冲击根={shock_idx}",
            "结构未收复",
            f"1H EMA20{'<' if direction == 'short' else '>'}EMA50",
            f"反弹缩量 RVOL={rv:.2f}",
            f"OI 再增 {oi_now:.2f}%",
            *rr.evidence,
        ],
        data_flags={"shock_idx": shock_idx, "liq_threshold": thr},
    )]
