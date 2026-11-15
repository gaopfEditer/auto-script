"""S10 OI 异常：六种价量组合；无确认只观察，不交易。"""
from __future__ import annotations

from oi_mornitor.strategy.short_term_v2.common import (
    BarContext,
    base_gates,
    check_oi_trigger,
    check_rr,
    check_rvol_trigger,
    structure_stop_target,
)
from oi_mornitor.strategy.short_term_v2.metrics import atr_at, lookback_high, lookback_low, oi_change_pct
from oi_mornitor.strategy.short_term_v2.params import tier_param
from oi_mornitor.strategy.short_term_v2.signal import V2Signal, make_observe


def _price_oi_regime(price_up: bool, price_flat: bool, oi_up: bool, oi_flat: bool) -> str:
    if price_flat and oi_up:
        return "range_oi_spike"
    if price_flat and (not oi_up) and not oi_flat:
        return "range_oi_drain"
    if price_up and oi_up:
        return "up_oi_up"
    if price_up and not oi_up:
        return "up_oi_down"
    if (not price_up) and oi_up:
        return "down_oi_up"
    return "down_oi_down"


def scan_s10(ctx: BarContext) -> list[V2Signal]:
    gate = base_gates(ctx)
    if not gate.ok and gate.reason in ("tier_skipped", "platform_halt"):
        return []
    if ctx.idx < 25:
        return []

    oi_g = check_oi_trigger(ctx, use_1h=False)
    if not oi_g.ok:
        # 也试 1H 触发
        oi_g = check_oi_trigger(ctx, use_1h=True)
        if not oi_g.ok:
            return []

    row = ctx.df_15m.iloc[ctx.idx]
    prev = ctx.df_15m.iloc[ctx.idx - 1]
    px_chg = (float(row["close"]) - float(prev["close"])) / max(float(prev["close"]), 1e-12)
    oi_chg = float(oi_g.metrics.get("oi_change_pct") or 0.0)
    price_flat = abs(px_chg) < 0.0015
    price_up = px_chg > 0.0015
    oi_flat = abs(oi_chg) < 0.5
    oi_up = oi_chg > 0.5
    regime = _price_oi_regime(price_up, price_flat, oi_up, oi_flat)

    evidence = [
        f"价Δ={px_chg * 100:.2f}%",
        f"OIΔ={oi_chg:.2f}%",
        f"组合={regime}",
        *oi_g.evidence,
    ]

    # 至少一个确认：RVOL / 结构突破 / funding / 清算
    confirmed = False
    confirm_notes: list[str] = []
    direction: str | None = None
    level: float | None = None

    rv = check_rvol_trigger(ctx)
    if rv.ok:
        confirmed = True
        confirm_notes.append(rv.evidence[0] if rv.evidence else "RVOL确认")

    hi = lookback_high(ctx.df_15m, ctx.idx, 20)
    lo = lookback_low(ctx.df_15m, ctx.idx, 20)
    c = float(row["close"])
    if hi and c > hi:
        confirmed = True
        confirm_notes.append("收盘突破20根高")
        direction = "long"
        level = hi
    elif lo and c < lo:
        confirmed = True
        confirm_notes.append("收盘跌破20根低")
        direction = "short"
        level = lo

    if "funding" in ctx.df_15m.columns:
        try:
            f_now = float(row["funding"])
            f_prev = float(prev["funding"])
            if abs(f_now - f_prev) > 0.0001:
                confirmed = True
                confirm_notes.append("Funding显著变化")
        except (TypeError, ValueError):
            pass

    if ctx.liq_events:
        confirmed = True
        confirm_notes.append("存在清算事件流（需结合S03细看）")

    # 组合释义 → 交易/观察处理
    tradeable_regimes = {"up_oi_up", "down_oi_up", "down_oi_down"}
    if not confirmed or regime not in tradeable_regimes:
        return [make_observe(
            "S10",
            symbol=ctx.symbol,
            market_cap_tier=ctx.market_cap_tier,
            trigger_time=ctx.ts(),
            trigger_idx=ctx.idx,
            evidence=evidence + (confirm_notes or ["无额外确认，仅观察"]),
            data_flags={**oi_g.metrics, "regime": regime, "confirmed": confirmed},
            oi_change_pct=oi_chg,
            direction=direction,
        )]

    if direction is None:
        if regime == "up_oi_up":
            direction = "long"
            level = hi or c
        elif regime in ("down_oi_up", "down_oi_down"):
            # down_oi_down → 清算后反转候选，交给观察或偏多
            if regime == "down_oi_down":
                return [make_observe(
                    "S10",
                    symbol=ctx.symbol,
                    market_cap_tier=ctx.market_cap_tier,
                    trigger_time=ctx.ts(),
                    trigger_idx=ctx.idx,
                    evidence=evidence + confirm_notes + ["下跌+OI降：倾向清算后反转，交由S03"],
                    data_flags={**oi_g.metrics, "regime": regime},
                    oi_change_pct=oi_chg,
                    direction="long",
                )]
            direction = "short"
            level = lo or c

    entry = c
    atr = atr_at(ctx.df_15m, ctx.idx)
    stop, target = structure_stop_target(
        entry=entry,
        direction=direction,
        structure_level=float(level or entry),
        atr=atr,
        reward_r=1.3,
    )
    rr = check_rr(entry=entry, stop=stop, target=target, direction=direction,
                  fee_pct=ctx.fee_pct, slip_pct=ctx.slip_pct)
    if not rr.ok:
        return [make_observe(
            "S10",
            symbol=ctx.symbol,
            market_cap_tier=ctx.market_cap_tier,
            trigger_time=ctx.ts(),
            trigger_idx=ctx.idx,
            evidence=evidence + confirm_notes + rr.evidence,
            data_flags={**oi_g.metrics, "regime": regime},
            oi_change_pct=oi_chg,
            direction=direction,
        )]

    return [V2Signal(
        signal_type="S10",
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
        structure_level=float(level or entry),
        oi_change_pct=oi_chg,
        risk_r=tier_param(ctx.market_cap_tier, "risk_r"),
        evidence=evidence + confirm_notes + rr.evidence,
        data_flags={**oi_g.metrics, "regime": regime},
    )]
