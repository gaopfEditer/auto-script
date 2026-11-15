"""第二批策略 stub：注册编号与观察钩子，完整规则后续补全。"""
from __future__ import annotations

from oi_mornitor.strategy.short_term_v2.common import BarContext
from oi_mornitor.strategy.short_term_v2.metrics import atr_deviation_at, price_z_at, rsi_at
from oi_mornitor.strategy.short_term_v2.params import STRATEGY_LABELS, tier_param
from oi_mornitor.strategy.short_term_v2.signal import V2Signal, make_observe


def scan_s02(ctx: BarContext) -> list[V2Signal]:
    """大周期形态：需要 1D/4H；当前仅在数据齐全时发观察事件。"""
    if ctx.df_4h is None or len(ctx.df_4h) < 40:
        return []
    return [make_observe(
        "S02",
        symbol=ctx.symbol,
        market_cap_tier=ctx.market_cap_tier,
        trigger_time=ctx.ts(),
        trigger_idx=ctx.idx,
        evidence=["S02 大周期形态：第二批待实现（需 1D/1W 突破+EMA 过滤）"],
        data_flags={"implemented": False},
    )] if ctx.idx % 96 == 0 else []  # 约每日本地标一次，避免刷屏


def scan_s08(ctx: BarContext) -> list[V2Signal]:
    flags = ctx.event_flags or {}
    if not flags.get("news_event"):
        return []
    return [make_observe(
        "S08",
        symbol=ctx.symbol,
        market_cap_tier=ctx.market_cap_tier,
        trigger_time=ctx.ts(),
        trigger_idx=ctx.idx,
        evidence=["消息事件标记存在；S08 完整执行规则第二批实现"],
        data_flags={"news_event": flags.get("news_event")},
    )]


def scan_s09(ctx: BarContext) -> list[V2Signal]:
    flags = ctx.event_flags or {}
    halt = flags.get("delisted") or flags.get("deposit_suspended") or flags.get("trading_halted")
    if not halt and "mark_basis_pct" not in flags:
        return []
    status = "skipped" if halt else "observe"
    return [V2Signal(
        signal_type="S09",
        market_cap_tier=ctx.market_cap_tier,
        symbol=ctx.symbol,
        status=status,
        skip_reason="platform_halt" if halt else None,
        trigger_time=ctx.ts(),
        trigger_idx=ctx.idx,
        evidence=["平台事件过滤/观察"],
        data_flags=dict(flags),
        label=STRATEGY_LABELS["S09"],
    )]


def scan_s11(ctx: BarContext) -> list[V2Signal]:
    z = price_z_at(ctx.df_15m, ctx.idx)
    ad = atr_deviation_at(ctx.df_15m, ctx.idx)
    z_thr = tier_param(ctx.market_cap_tier, "price_z")
    atr_thr = tier_param(ctx.market_cap_tier, "atr_move")
    hit = (z is not None and abs(z) >= z_thr) or (ad is not None and ad >= atr_thr)
    if not hit:
        return []
    return [make_observe(
        "S11",
        symbol=ctx.symbol,
        market_cap_tier=ctx.market_cap_tier,
        trigger_time=ctx.ts(),
        trigger_idx=ctx.idx,
        evidence=[
            f"PriceZ={z}",
            f"ATRDeviation={ad}",
            "价格异常本身不是多空信号",
        ],
        data_flags={"price_z": z, "atr_deviation": ad, "implemented": False},
    )]


def scan_s12(ctx: BarContext) -> list[V2Signal]:
    """流动性陷阱：有深度/价差时做过滤型观察。"""
    if ctx.tier.spread_pct is None and ctx.tier.depth is None:
        return []
    spread_max = tier_param(ctx.market_cap_tier, "spread_max_pct")
    bad = False
    notes = []
    if ctx.tier.spread_pct is not None and ctx.tier.spread_pct > spread_max:
        bad = True
        notes.append(f"价差 {ctx.tier.spread_pct}% > {spread_max}%")
    if ctx.market_cap_tier == 3 and ctx.tier.depth_missing:
        bad = True
        notes.append("第三梯队深度缺失")
    if not bad:
        return []
    return [V2Signal(
        signal_type="S12",
        market_cap_tier=ctx.market_cap_tier,
        symbol=ctx.symbol,
        status="skipped",
        skip_reason="liquidity_trap",
        trigger_time=ctx.ts(),
        trigger_idx=ctx.idx,
        evidence=notes or ["流动性异常"],
        data_flags={
            "spread_pct": ctx.tier.spread_pct,
            "depth": ctx.tier.depth,
        },
    )]


def scan_s13(ctx: BarContext) -> list[V2Signal]:
    from oi_mornitor.strategy.short_term_v2.params import (
        RSI_HOT_15M,
        RSI_HOT_1H,
        RSI_PANIC_15M,
        RSI_PANIC_1H,
    )

    r15 = rsi_at(ctx.df_15m, ctx.idx)
    if r15 is None:
        return []
    r1 = None
    if ctx.df_1h is not None and len(ctx.df_1h) > 20:
        import numpy as np
        from oi_mornitor.strategy.short_term_v2.metrics import bar_ts

        t = ctx.ts()
        times = ctx.df_1h["open_time"].astype("int64").to_numpy()
        if times.size and int(times[-1]) < 1e12 and t and t > 1e12:
            times = times * 1000
        j = int(np.searchsorted(times, int(t or 0), side="right") - 1)
        r1 = rsi_at(ctx.df_1h, j) if j >= 15 else None

    panic = r15 < RSI_PANIC_15M and (r1 is None or r1 < RSI_PANIC_1H)
    hot = r15 > RSI_HOT_15M and (r1 is None or r1 > RSI_HOT_1H)
    if not panic and not hot:
        return []
    # 第三梯队不允许仅凭 RSI 入场 → 只观察
    return [make_observe(
        "S13",
        symbol=ctx.symbol,
        market_cap_tier=ctx.market_cap_tier,
        trigger_time=ctx.ts(),
        trigger_idx=ctx.idx,
        direction="long" if panic else "short",
        evidence=[
            f"RSI15={r15:.1f}",
            f"RSI1H={r1}",
            "恐慌" if panic else "过热",
            "完整结构确认第二批实现；T3 禁止纯 RSI 入场",
        ],
        data_flags={"rsi_15m": r15, "rsi_1h": r1, "implemented": False},
    )]
