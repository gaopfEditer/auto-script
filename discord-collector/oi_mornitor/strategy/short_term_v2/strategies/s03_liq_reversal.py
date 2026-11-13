"""S03 清算之后反转（与 S04 延续严格分开）。"""
from __future__ import annotations

from typing import Any

import numpy as np

from oi_mornitor.strategy.short_term_v2.common import (
    BarContext,
    base_gates,
    check_rr,
    structure_stop_target,
)
from oi_mornitor.strategy.short_term_v2.metrics import atr_at, bar_ts, lookback_high, lookback_low, oi_change_pct
from oi_mornitor.strategy.short_term_v2.params import LIQ_LOOKBACK_BARS_30D_15M, LIQ_SHOCK_ATR, tier_param
from oi_mornitor.strategy.short_term_v2.signal import V2Signal


def _liq_notional_at(events: list[dict[str, Any]] | None, ts: int | None, window_ms: int = 900_000) -> float:
    if not events or ts is None:
        return 0.0
    total = 0.0
    for e in events:
        et = e.get("ts") or e.get("time") or e.get("open_time")
        if et is None:
            continue
        et = int(et)
        if et < 1e12:
            et *= 1000
        if ts - window_ms <= et <= ts + window_ms:
            total += float(e.get("notional") or e.get("qty_usd") or e.get("amount") or 0.0)
    return total


def _historical_liq_series(ctx: BarContext, end_idx: int) -> list[float]:
    """用每根 15m 窗口内清算名义金额近似历史分布；无事件则空。"""
    if not ctx.liq_events:
        return []
    out: list[float] = []
    start = max(0, end_idx - LIQ_LOOKBACK_BARS_30D_15M)
    for i in range(start, end_idx + 1):
        t = bar_ts(ctx.df_15m, i)
        out.append(_liq_notional_at(ctx.liq_events, t))
    return out


def _pctile(values: list[float], p: float) -> float | None:
    if len(values) < 20:
        return None
    arr = np.asarray(values, dtype=float)
    return float(np.percentile(arr, p))


def scan_s03(ctx: BarContext) -> list[V2Signal]:
    gate = base_gates(ctx)
    if not gate.ok and gate.reason in ("tier_skipped", "platform_halt", "t3_depth_missing", "spread_too_wide"):
        return []
    if ctx.idx < 40:
        return []
    if not ctx.liq_events:
        return [V2Signal(
            signal_type="S03",
            market_cap_tier=ctx.market_cap_tier,
            symbol=ctx.symbol,
            status="skipped",
            skip_reason="liq_data_missing",
            trigger_idx=ctx.idx,
            trigger_time=ctx.ts(),
            evidence=["无清算历史，不假装检出"],
            data_flags={"liq_available": False},
        )]

    hist = _historical_liq_series(ctx, ctx.idx)
    pctile = tier_param(ctx.market_cap_tier, "liq_pctile")
    thr = _pctile(hist, pctile)
    if thr is None or thr <= 0:
        return []
    cur_liq = hist[-1] if hist else 0.0
    if cur_liq < thr:
        return []

    atr = atr_at(ctx.df_15m, ctx.idx)
    row = ctx.df_15m.iloc[ctx.idx]
    prev = ctx.df_15m.iloc[ctx.idx - 1]
    move = abs(float(row["close"]) - float(prev["close"]))
    if atr <= 0 or move < LIQ_SHOCK_ATR * atr:
        return []

    oi_chg = oi_change_pct(ctx.df_15m, ctx.idx)
    if oi_chg is None or oi_chg >= -0.5:
        # 要求 OI 明显下降（集中平仓/强平）
        return []

    # 方向：下跌冲击 → 做多反转候选；上涨冲击 → 做空反转
    direction = "long" if float(row["close"]) < float(prev["close"]) else "short"
    support = lookback_low(ctx.df_15m, ctx.idx, 20)
    resist = lookback_high(ctx.df_15m, ctx.idx, 20)
    if direction == "long":
        if support is None:
            return []
        # 收盘重新收回支撑区域（当前接近并站上近期低点）
        if float(row["close"]) < support * 0.998:
            return []
        # 后续低点未创新低：当前低 >= 前一根低
        if float(row["low"]) < float(prev["low"]):
            return []
        level = support
    else:
        if resist is None:
            return []
        if float(row["close"]) > resist * 1.002:
            return []
        if float(row["high"]) > float(prev["high"]):
            return []
        level = resist

    # 第二梯队要求 1H 确认
    if ctx.market_cap_tier >= 2 and ctx.df_1h is not None and len(ctx.df_1h) >= 5:
        t = ctx.ts()
        times = ctx.df_1h["open_time"].astype("int64").to_numpy()
        if times.size and int(times[-1]) < 1e12 and t and t > 1e12:
            times = times * 1000
        j = int(np.searchsorted(times, int(t or 0), side="right") - 1)
        if j >= 1:
            hc = float(ctx.df_1h.iloc[j]["close"])
            hp = float(ctx.df_1h.iloc[j - 1]["close"])
            if direction == "long" and hc < hp:
                return []
            if direction == "short" and hc > hp:
                return []
    elif ctx.market_cap_tier >= 2:
        return []

    if ctx.market_cap_tier == 3:
        sd = base_gates(ctx)
        if not sd.ok:
            return []

    entry = float(row["close"])
    stop, target = structure_stop_target(
        entry=entry, direction=direction, structure_level=level, atr=atr, reward_r=1.2
    )
    rr = check_rr(entry=entry, stop=stop, target=target, direction=direction,
                  fee_pct=ctx.fee_pct, slip_pct=ctx.slip_pct)
    if not rr.ok:
        return []

    return [V2Signal(
        signal_type="S03",
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
        structure_level=level,
        oi_change_pct=oi_chg,
        risk_r=tier_param(ctx.market_cap_tier, "risk_r"),
        evidence=[
            f"清算名义={cur_liq:.0f} ≥ P{pctile:.0f}阈值={thr:.0f}",
            f"冲击={move / atr:.2f} ATR",
            f"OIΔ={oi_chg:.2f}%",
            "结构收复确认",
            *rr.evidence,
        ],
        data_flags={"liq_notional": cur_liq, "liq_threshold": thr, "liq_pctile": pctile},
    )]
