"""形态信号分批纸面结算：V2 为 R 倍数 TP + invalid/ATR SL；仍兼容旧固定 % 兜底。

结算走步记录 MFE/MAE、TP 命中与强平；同柱优先级仍为 强平/止损 → 止盈（不改）。
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from oi_mornitor.pattern_alert_stats import _rec_pnl_pct

if TYPE_CHECKING:
    from oi_mornitor.pattern_settle_profile import SettlePlan

# 核实：每 15m 一步，最长 3h（12 根 15m）
_VERIFY_INTERVAL_MS = 15 * 60 * 1000
_VERIFY_DELAY_MS = 3 * 60 * 60 * 1000

# 分批 TP（价格变动 %）与仓位权重
TP_LEVELS_PCT = (3.0, 7.0, 12.0, 17.0)
TP1_PCT, TP2_PCT = TP_LEVELS_PCT[0], TP_LEVELS_PCT[1]
BATCH_WEIGHTS = (0.30, 0.30, 0.40)  # TP1 / TP2 / Runner
DEFAULT_SL_PCT = 5.0
RUNNER_TRAIL_PCT = 5.0  # Runner：从极值回撤 5% 触发（多单上移线 / 空单下移线）

# 兼容旧引用
_DEFAULT_TP_SL_PCT = TP1_PCT


def settle_rules_summary() -> str:
    from oi_mornitor.pattern_settle_profile import settle_rules_summary_v2
    from oi_mornitor.trade_leverage import OI_SETTLE_LIQUIDATION, audit_assumptions

    a = audit_assumptions()
    liq = "强平模拟+亏损封顶-100" if OI_SETTLE_LIQUIDATION else "未模拟强平"
    return (
        f"BTC/ETH/SOL {a['leverageMajor']}x · 山寨 {a['leverageAlt']}x · {settle_rules_summary_v2()} · "
        f"{liq} · 手续费默认 {a['feePctPerSideDefault']}%/边 · 滑点 {a['slippagePctPerSideDefault']}%/边 · "
        "资金费未建模 · 15m 步进核实 · 未平则按窗口末价"
    )


def price_move_pct(entry: float, price: float, *, is_short: bool) -> float:
    if entry <= 0:
        return 0.0
    if is_short:
        return (entry - price) / entry * 100.0
    return (price - entry) / entry * 100.0


def _align_factor(ref: float, entry: float) -> float:
    if not (ref > 0 and entry > 0):
        return 1.0
    ratio = ref / entry
    if ratio > 50 or ratio < 0.02:
        p = 10 ** round(__import__("math").log10(ratio))
        return p if abs(ratio / p - 1) < abs(ratio - 1) else ratio
    return 1.0


def _align_bars(bars: list[dict[str, float]], entry: float) -> list[dict[str, float]]:
    if not bars or entry <= 0:
        return bars
    samples = sorted(b["close"] for b in bars[:8] if b["close"] > 0)
    if not samples:
        return bars
    mid = samples[len(samples) // 2]
    factor = _align_factor(mid, entry)
    if factor == 1.0:
        return bars
    return [
        {"ts": b["ts"], "high": b["high"] * factor, "low": b["low"] * factor, "close": b["close"] * factor}
        for b in bars
    ]


def _aggregate_to_15m(bars: list[dict[str, float]]) -> list[dict[str, float]]:
    """5m → 15m 聚合（回测侧仍可用 5m 数据源）。"""
    if len(bars) < 2:
        return bars
    deltas = [bars[i + 1]["ts"] - bars[i]["ts"] for i in range(min(8, len(bars) - 1))]
    med = sorted(deltas)[len(deltas) // 2]
    if med >= 14 * 60_000:
        return bars
    bucket_ms = 15 * 60_000
    buckets: dict[int, dict[str, float]] = {}
    for b in bars:
        key = int(b["ts"] // bucket_ms)
        cur = buckets.get(key)
        if cur is None:
            buckets[key] = {"ts": key * bucket_ms, "high": b["high"], "low": b["low"], "close": b["close"]}
        else:
            cur["high"] = max(cur["high"], b["high"])
            cur["low"] = min(cur["low"], b["low"])
            cur["close"] = b["close"]
    return [buckets[k] for k in sorted(buckets.keys())]


def _tp_price(entry: float, pct: float, *, is_short: bool) -> float:
    step = pct / 100.0
    return entry * (1 - step) if is_short else entry * (1 + step)


def _sl_price(entry: float, pct: float, *, is_short: bool) -> float:
    step = pct / 100.0
    return entry * (1 + step) if is_short else entry * (1 - step)


def _bar_series_for_settle(
    bars: list[dict[str, float]],
    entry: float,
    *,
    fine_bars: bool | None,
) -> list[dict[str, float]]:
    aligned = _align_bars(bars, entry)
    if fine_bars is None:
        from oi_mornitor.config import OI_PATTERN_SETTLE_FINE_BARS

        fine_bars = OI_PATTERN_SETTLE_FINE_BARS
    if not fine_bars:
        return _aggregate_to_15m(aligned)
    if len(aligned) < 2:
        return aligned
    deltas = [
        aligned[i + 1]["ts"] - aligned[i]["ts"]
        for i in range(min(8, len(aligned) - 1))
    ]
    med = sorted(deltas)[len(deltas) // 2]
    if med >= 14 * 60_000:
        return aligned
    return aligned


def _adverse_hit(bar: dict[str, float], level: float, *, is_short: bool) -> bool:
    return bar["high"] >= level if is_short else bar["low"] <= level


def settle_signal_batch(
    *,
    side: str,
    entry: float,
    symbol: str,
    signal_at_ms: int,
    bars: list[dict[str, float]],
    sl_pct: float = DEFAULT_SL_PCT,
    verify_delay_ms: int = _VERIFY_DELAY_MS,
    now_ms: int | None = None,
    plan: "SettlePlan | None" = None,
    fine_bars: bool | None = None,
    breakeven_after_tp1: bool | None = None,
    fee_pct_per_side: float = 0.0,
    slippage_pct_per_side: float = 0.0,
    asset_class: str = "crypto",
    enable_liquidation: bool | None = None,
) -> dict[str, Any]:
    """
    三档分批 + Runner 跟踪止盈。
    返回 outcome / movePct（加权价格变动%）/ exitPrice / pnlPct 及诊断字段。
    """
    is_short = side in ("short", "bear")
    if plan is not None:
        tp1 = plan.tp1_price
        tp2 = plan.tp2_price
        sl = plan.sl_price
        verify_delay_ms = plan.verify_delay_ms
        batch_weights = plan.batch_weights
        runner_trail_pct = plan.runner_trail_pct
        step_pct = round(plan.tp1_r * (plan.risk_r / entry * 100.0), 4) if entry > 0 else TP1_PCT
        tp_levels = [step_pct, round(plan.tp2_r * (plan.risk_r / entry * 100.0), 4)]
        risk_r = plan.risk_r
    else:
        tp1 = _tp_price(entry, TP1_PCT, is_short=is_short)
        tp2 = _tp_price(entry, TP2_PCT, is_short=is_short)
        sl = _sl_price(entry, sl_pct, is_short=is_short)
        batch_weights = BATCH_WEIGHTS
        runner_trail_pct = RUNNER_TRAIL_PCT
        step_pct = TP1_PCT
        tp_levels = list(TP_LEVELS_PCT[:2])
        risk_r = abs(entry - sl)

    verify_at = signal_at_ms + verify_delay_ms
    now = verify_at if now_ms is None else min(now_ms, verify_at)

    if breakeven_after_tp1 is None:
        from oi_mornitor.config import OI_PATTERN_SETTLE_BREAKEVEN_TP1

        breakeven_after_tp1 = OI_PATTERN_SETTLE_BREAKEVEN_TP1

    from oi_mornitor.config import (
        SETTLE_WALK_VERSION,
        SETTLE_WALK_VERSION_LEGACY_AGG,
    )

    if fine_bars is None:
        from oi_mornitor.config import OI_PATTERN_SETTLE_FINE_BARS

        use_fine = OI_PATTERN_SETTLE_FINE_BARS
    else:
        use_fine = fine_bars
    settle_walk_version = SETTLE_WALK_VERSION if use_fine else SETTLE_WALK_VERSION_LEGACY_AGG

    series = _bar_series_for_settle(bars, entry, fine_bars=use_fine)
    sorted_bars = [
        b for b in sorted(series, key=lambda x: x["ts"]) if signal_at_ms - 1 <= b["ts"] <= now + 60_000
    ]

    rem = list(batch_weights)
    weighted_move = 0.0
    runner_active = False
    extreme = entry
    runner_stop: float | None = None
    exit_price = entry
    hit_at: int | None = None

    from oi_mornitor.trade_diagnostics import WalkDiagnostics
    from oi_mornitor.trade_leverage import (
        OI_SETTLE_LIQUIDATION,
        cap_roe_at_margin,
        leverage_for_symbol,
        liquidation_price,
        maintenance_margin_rate,
        move_pct_for_capped_roe,
        roe_from_price_move,
    )
    from oi_mornitor.trade_leverage import FUNDING_MODELED, FUNDING_NOTE

    diag = WalkDiagnostics(
        entry=entry,
        is_short=is_short,
        sl_price=sl,
        tp1=tp1,
        tp2=tp2,
        risk_r=risk_r,
        signal_at_ms=signal_at_ms,
    )
    lev = leverage_for_symbol(symbol, asset_class)
    mmr = maintenance_margin_rate(symbol, asset_class)
    use_liq = OI_SETTLE_LIQUIDATION if enable_liquidation is None else bool(enable_liquidation)
    liq_px = liquidation_price(entry, is_short=is_short, leverage=lev, mmr=mmr) if use_liq and lev > 0 else None
    exit_reason = "timeout"
    liquidated = False

    def _finish(outcome: str, *, move: float, price: float, at: int | None, reason: str) -> dict[str, Any]:
        rec: dict[str, Any] = {
            "outcome": outcome,
            "exitPrice": price,
            "movePct": move,
            "hitAt": at,
            "verifiedAt": now,
            "stepPct": step_pct,
            "tpLevels": tp_levels,
            "batchWeights": list(batch_weights),
            "side": "short" if is_short else "long",
            "entry": entry,
            "symbol": symbol,
            "tradeSymbol": symbol,
            "settleRulesVersion": 2 if plan else 1,
            "settleVersion": settle_walk_version,
        }
        if plan is not None:
            rec["settleProfileId"] = plan.profile_id
            rec["slPrice"] = sl
            rec["tp1Price"] = tp1
            rec["tp2Price"] = tp2
            rec["verifyAt"] = verify_at
        else:
            rec["slPrice"] = sl
            rec["tp1Price"] = tp1
            rec["tp2Price"] = tp2
        if fee_pct_per_side > 0 or slippage_pct_per_side > 0:
            from oi_mornitor.pattern_entry import apply_round_trip_costs

            move = apply_round_trip_costs(
                move,
                fee_pct=fee_pct_per_side,
                slippage_pct=slippage_pct_per_side,
            )
            rec["movePct"] = move
            rec["netMovePct"] = move
            rec["feePctPerSide"] = fee_pct_per_side
            rec["slippagePctPerSide"] = slippage_pct_per_side
        rec["pnlPct"] = _rec_pnl_pct(rec)
        raw_pnl = rec["pnlPct"]
        exceeded = False
        if raw_pnl is not None and lev > 0:
            capped, exceeded = cap_roe_at_margin(float(raw_pnl))
            rec["pnlPctRaw"] = raw_pnl
            if exceeded:
                rec["pnlPct"] = capped
                # 同步 movePct，避免后续用 move 重算又越过保证金
                rec["movePct"] = move_pct_for_capped_roe(capped, lev)
                rec["netMovePct"] = rec["movePct"]
        rec.update(
            diag.finish(
                exit_reason=reason,
                hit_at=at,
                liquidated=liquidated,
                fee_pct=fee_pct_per_side,
                slippage_pct=slippage_pct_per_side,
                leverage=lev,
                liquidation_px=liq_px,
                loss_exceeded_margin=exceeded,
                pnl_pct_raw=raw_pnl,
            )
        )
        rec["fundingModeled"] = FUNDING_MODELED
        rec["fundingNote"] = FUNDING_NOTE
        return rec

    def _close_adverse(level: float, reason: str, *, is_liq: bool = False) -> None:
        nonlocal weighted_move, rem, exit_price, hit_at, exit_reason, liquidated, sl
        remaining = sum(rem)
        move = price_move_pct(entry, level, is_short=is_short)
        weighted_move += move * remaining
        rem = [0.0, 0.0, 0.0]
        exit_price = level
        exit_reason = reason
        if is_liq:
            liquidated = True

    for bar in sorted_bars:
        remaining = sum(rem)
        if remaining <= 1e-9:
            break
        diag.update_excursions(bar)

        # 0) 强平：若强平价比当前 SL 更靠近入场，价格先触及强平
        if liq_px is not None and _adverse_hit(bar, liq_px, is_short=is_short):
            sl_also = _adverse_hit(bar, sl, is_short=is_short)
            # 同柱：取更靠近入场的一侧（先发生）
            liq_closer = abs(liq_px - entry) <= abs(sl - entry)
            if liq_closer or not sl_also:
                _close_adverse(liq_px, "liquidation", is_liq=True)
                hit_at = int(bar["ts"])
                break

        # 1) 全仓剩余止损（同柱优先于止盈）
        sl_hit = _adverse_hit(bar, sl, is_short=is_short)
        if sl_hit:
            reason = "initial_sl"
            if diag.tp1_hit and diag.sl_moved_to_be:
                reason = "tp1_breakeven"
            elif diag.tp1_hit:
                reason = "stop_loss"
            _close_adverse(sl, reason)
            hit_at = int(bar["ts"])
            break

        # 2) TP1 30%
        if rem[0] > 0:
            tp_hit = bar["low"] <= tp1 if is_short else bar["high"] >= tp1
            if tp_hit:
                move = price_move_pct(entry, tp1, is_short=is_short)
                weighted_move += move * rem[0]
                rem[0] = 0.0
                diag.mark_tp1()
                if breakeven_after_tp1 and (rem[1] > 0 or rem[2] > 0):
                    sl = min(sl, entry) if is_short else max(sl, entry)
                    diag.mark_be()

        # 3) TP2 30%
        if rem[1] > 0:
            tp_hit = bar["low"] <= tp2 if is_short else bar["high"] >= tp2
            if tp_hit:
                move = price_move_pct(entry, tp2, is_short=is_short)
                weighted_move += move * rem[1]
                rem[1] = 0.0
                diag.mark_tp2()
                runner_active = True
                diag.mark_runner()

        # 4) Runner 40% — 达 TP2 后启动跟踪；多单上移止损线 / 空单下移
        if rem[2] > 0:
            if not runner_active:
                act = bar["low"] <= tp2 if is_short else bar["high"] >= tp2
                if act:
                    runner_active = True
                    diag.mark_runner()
            if runner_active:
                if is_short:
                    extreme = min(extreme, bar["low"])
                    new_stop = extreme * (1 + runner_trail_pct / 100.0)
                    runner_stop = new_stop if runner_stop is None else min(runner_stop, new_stop)
                    if bar["high"] >= runner_stop:
                        move = price_move_pct(entry, runner_stop, is_short=True)
                        weighted_move += move * rem[2]
                        rem[2] = 0.0
                        exit_price = runner_stop
                        hit_at = int(bar["ts"])
                        exit_reason = "runner"
                else:
                    extreme = max(extreme, bar["high"])
                    new_stop = extreme * (1 - runner_trail_pct / 100.0)
                    runner_stop = new_stop if runner_stop is None else max(runner_stop, new_stop)
                    if bar["low"] <= runner_stop:
                        move = price_move_pct(entry, runner_stop, is_short=False)
                        weighted_move += move * rem[2]
                        rem[2] = 0.0
                        exit_price = runner_stop
                        hit_at = int(bar["ts"])
                        exit_reason = "runner"

    remaining = sum(rem)
    if remaining > 1e-9 and now < verify_at:
        return {"outcome": "pending", "entry": entry, "symbol": symbol, "pnlPct": None}

    if remaining > 1e-9:
        if not sorted_bars:
            return {"outcome": "error", "error": "no_klines", "entry": entry, "symbol": symbol, "pnlPct": None}
        last = sorted_bars[-1]
        move = price_move_pct(entry, last["close"], is_short=is_short)
        weighted_move += move * remaining
        exit_price = last["close"]
        hit_at = int(last["ts"])
        exit_reason = "timeout"

    if abs(weighted_move) < 1e-4:
        return _finish("flat", move=weighted_move, price=exit_price, at=hit_at, reason="flat")
    outcome = "take_profit" if weighted_move > 0 else "stop_loss"
    if liquidated:
        outcome = "stop_loss"
        exit_reason = "liquidation"
    return _finish(outcome, move=weighted_move, price=exit_price, at=hit_at, reason=exit_reason)


def settle_signal_by_5m_bars(
    *,
    side: str,
    entry: float,
    symbol: str,
    signal_at_ms: int,
    bars_5m: list[dict[str, float]],
    step_pct: float = TP1_PCT,
    verify_delay_ms: int = _VERIFY_DELAY_MS,
    now_ms: int | None = None,
    plan: "SettlePlan | None" = None,
    alert_rec: dict[str, Any] | None = None,
    fine_bars: bool | None = None,
    breakeven_after_tp1: bool | None = None,
    fee_pct_per_side: float = 0.0,
    slippage_pct_per_side: float = 0.0,
    enable_liquidation: bool | None = None,
) -> dict[str, Any]:
    """兼容旧名：5m 步进结算；可传 alert_rec 自动 build V2 plan。"""
    del step_pct  # 旧 ±5% 单档已废弃
    asset_class = "crypto"
    if plan is None and alert_rec is not None:
        from oi_mornitor.pattern_settle_profile import build_settle_plan

        plan = build_settle_plan(alert_rec)
        verify_delay_ms = plan.verify_delay_ms
        asset_class = str(alert_rec.get("assetClass") or "crypto")
    elif alert_rec is not None:
        asset_class = str(alert_rec.get("assetClass") or "crypto")
    return settle_signal_batch(
        side=side,
        entry=entry,
        symbol=symbol,
        signal_at_ms=signal_at_ms,
        bars=bars_5m,
        verify_delay_ms=verify_delay_ms,
        now_ms=now_ms,
        plan=plan,
        fine_bars=fine_bars,
        breakeven_after_tp1=breakeven_after_tp1,
        fee_pct_per_side=fee_pct_per_side,
        slippage_pct_per_side=slippage_pct_per_side,
        asset_class=asset_class,
        enable_liquidation=enable_liquidation,
    )


def klines_rows_to_bars(rows: list[list[Any]]) -> list[dict[str, float]]:
    out: list[dict[str, float]] = []
    for row in rows:
        if not row or len(row) < 5:
            continue
        out.append(
            {
                "ts": int(row[0]),
                "high": float(row[2]),
                "low": float(row[3]),
                "close": float(row[4]),
            }
        )
    return out
