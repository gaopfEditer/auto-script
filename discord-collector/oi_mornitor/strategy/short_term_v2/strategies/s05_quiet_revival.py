"""S05 沉寂复苏：低波动横盘后放量突破。"""
from __future__ import annotations

import numpy as np

from oi_mornitor.strategy.short_term_v2.common import (
    BarContext,
    base_gates,
    check_rr,
    structure_stop_target,
)
from oi_mornitor.strategy.short_term_v2.metrics import (
    atr_at,
    atr_pct_at,
    oi_change_pct,
    rvol_at,
)
from oi_mornitor.strategy.short_term_v2.params import (
    QUIET_ATR_PCTILE,
    QUIET_BASELINE_DAYS,
    QUIET_LOOKBACK_DAYS,
    REVIVAL_1H_RVOL,
    tier_param,
)
from oi_mornitor.strategy.short_term_v2.signal import V2Signal


def _is_quiet(ctx: BarContext) -> tuple[bool, list[str]]:
    """过去约 30 天 ATR%/Close 处于过去约 180 天的 P20 以下，且横盘。"""
    # 15m 近似：30d≈2880 根，180d≈17280；样本不足时用可用窗口
    need_short = QUIET_LOOKBACK_DAYS * 24 * 4
    need_long = QUIET_BASELINE_DAYS * 24 * 4
    if ctx.idx < min(need_short, 200):
        return False, ["沉寂窗口不足"]
    start_long = max(0, ctx.idx - need_long)
    atr_pcts: list[float] = []
    for i in range(max(start_long, 14), ctx.idx + 1):
        ap = atr_pct_at(ctx.df_15m, i)
        if ap is not None:
            atr_pcts.append(ap)
    if len(atr_pcts) < 50:
        return False, ["ATR% 样本不足"]
    short_n = min(len(atr_pcts), need_short)
    recent = atr_pcts[-short_n:]
    baseline = atr_pcts
    p20 = float(np.percentile(baseline, QUIET_ATR_PCTILE))
    recent_med = float(np.median(recent))
    if recent_med > p20:
        return False, [f"近期ATR%中位={recent_med:.4f} > P20={p20:.4f}"]
    # 横盘：近 30d 高低振幅 / 中价 较小
    sl = ctx.df_15m.iloc[ctx.idx - short_n + 1 : ctx.idx + 1]
    hi, lo = float(sl["high"].max()), float(sl["low"].min())
    mid = (hi + lo) / 2.0
    range_pct = (hi - lo) / mid * 100.0 if mid > 0 else 999.0
    if range_pct > 25.0:
        return False, [f"振幅过大 {range_pct:.1f}% 不像沉寂"]
    return True, [f"沉寂：ATR%中位={recent_med:.4f}≤P20={p20:.4f}", f"振幅={range_pct:.1f}%"]


def scan_s05(ctx: BarContext) -> list[V2Signal]:
    # 第二、第三梯队重点；第一梯队也允许但非重点
    gate = base_gates(ctx)
    if not gate.ok and gate.reason in ("tier_skipped", "platform_halt", "t3_depth_missing", "spread_too_wide"):
        return []
    quiet, qev = _is_quiet(ctx)
    if not quiet:
        return []

    thr = tier_param(ctx.market_cap_tier, "quiet_rvol")
    rv = rvol_at(ctx.df_15m, ctx.idx)
    if rv is None or rv < thr:
        return []
    oi_thr = tier_param(ctx.market_cap_tier, "quiet_oi_pct")
    oi = oi_change_pct(ctx.df_15m, ctx.idx)
    if oi is None or oi < oi_thr:
        return []

    # 1H RVOL 与突破
    if ctx.df_1h is None or len(ctx.df_1h) < 25:
        return []
    t = ctx.ts()
    times = ctx.df_1h["open_time"].astype("int64").to_numpy()
    if times.size and int(times[-1]) < 1e12 and t and t > 1e12:
        times = times * 1000
    j = int(np.searchsorted(times, int(t or 0), side="right") - 1)
    if j < 21:
        return []
    vol_hist = ctx.df_1h["volume"].iloc[j - 20 : j].astype(float)
    mean_v = float(vol_hist.mean()) if len(vol_hist) else 0.0
    if mean_v <= 0:
        return []
    rvol_1h = float(ctx.df_1h.iloc[j]["volume"]) / mean_v
    if rvol_1h < REVIVAL_1H_RVOL:
        return []
    hi1 = float(ctx.df_1h["high"].iloc[j - 20 : j].max())
    lo1 = float(ctx.df_1h["low"].iloc[j - 20 : j].min())
    c1 = float(ctx.df_1h.iloc[j]["close"])
    if c1 > hi1:
        direction = "long"
        level = hi1
    elif c1 < lo1:
        direction = "short"
        level = lo1
    else:
        return []  # 只有量没有结构突破 → 不算复苏

    # 第二/三梯队要求 4H 同向软确认
    if ctx.market_cap_tier >= 2 and ctx.df_4h is not None and len(ctx.df_4h) >= 30:
        times4 = ctx.df_4h["open_time"].astype("int64").to_numpy()
        if times4.size and int(times4[-1]) < 1e12 and t and t > 1e12:
            times4 = times4 * 1000
        k = int(np.searchsorted(times4, int(t or 0), side="right") - 1)
        if k >= 20:
            c4 = float(ctx.df_4h.iloc[k]["close"])
            mid4 = (
                float(ctx.df_4h["high"].iloc[k - 20 : k].max())
                + float(ctx.df_4h["low"].iloc[k - 20 : k].min())
            ) / 2.0
            if direction == "long" and c4 < mid4:
                return []
            if direction == "short" and c4 > mid4:
                return []

    entry = float(ctx.df_15m.iloc[ctx.idx]["close"])
    atr = atr_at(ctx.df_15m, ctx.idx)
    stop, target = structure_stop_target(
        entry=entry, direction=direction, structure_level=level, atr=atr, reward_r=1.8
    )
    rr = check_rr(entry=entry, stop=stop, target=target, direction=direction,
                  fee_pct=ctx.fee_pct, slip_pct=ctx.slip_pct)
    if not rr.ok:
        return []

    return [V2Signal(
        signal_type="S05",
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
        rvol=rv,
        oi_change_pct=oi,
        risk_r=tier_param(ctx.market_cap_tier, "risk_r"),
        evidence=[
            *qev,
            f"15m RVOL={rv:.2f}≥{thr}",
            f"1H RVOL={rvol_1h:.2f}",
            f"OIΔ={oi:.2f}%≥{oi_thr}",
            "价格突破 1H 震荡区间",
            *rr.evidence,
        ],
        data_flags={"rvol_1h": rvol_1h},
    )]
