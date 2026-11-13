"""S01 短线：形态突破 → 放量确认 → 收盘站稳 → 回踩/延续 → 入场。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.strategy.short_term_v2.common import (
    BarContext,
    base_gates,
    check_chase_distance,
    check_rr,
    structure_stop_target,
)
from oi_mornitor.strategy.short_term_v2.metrics import atr_at, bar_ts, lookback_high, lookback_low, rvol_at
from oi_mornitor.strategy.short_term_v2.params import tier_param
from oi_mornitor.strategy.short_term_v2.signal import V2Signal


def _mtf_bias(ctx: BarContext, direction: str) -> tuple[bool, str]:
    """优先 1H 同向；第三梯队至少要求 15m 结构（已由突破满足），最好 1H。"""
    if ctx.df_1h is None or len(ctx.df_1h) < 25:
        if ctx.market_cap_tier <= 2:
            return False, "mtf_1h_missing"
        return True, "mtf_15m_only_t3"
    import numpy as np

    t = bar_ts(ctx.df_15m, ctx.idx)
    times = ctx.df_1h["open_time"].astype("int64").to_numpy()
    if times.size and int(times[-1]) < 1e12 and t and t > 1e12:
        times = times * 1000
    j = int(np.searchsorted(times, int(t or 0), side="right") - 1)
    if j < 20:
        return False, "mtf_1h_short"
    hi = float(ctx.df_1h["high"].iloc[j - 20 : j].max())
    lo = float(ctx.df_1h["low"].iloc[j - 20 : j].min())
    c = float(ctx.df_1h.iloc[j]["close"])
    if direction == "long" and c >= (hi + lo) / 2:
        return True, "1h_bias_long"
    if direction == "short" and c <= (hi + lo) / 2:
        return True, "1h_bias_short"
    if ctx.market_cap_tier == 3:
        return True, "mtf_soft_t3"
    return False, "mtf_1h_conflict"


def scan_s01(ctx: BarContext) -> list[V2Signal]:
    """在当前 15m 根扫描突破触发；向后最多看几根找回踩确认（不越界未来：仅用 idx 及之前）。

    约定：突破发生在 break_idx < idx，确认/入场在 idx（已收盘）。
    """
    out: list[V2Signal] = []
    gate = base_gates(ctx)
    if not gate.ok and gate.reason not in ("rvol_below_threshold",):
        # 深度/事件失败则整根跳过
        if gate.reason in ("t3_depth_missing", "depth_insufficient", "spread_too_wide", "platform_halt", "tier_skipped"):
            return [V2Signal(
                signal_type="S01",
                market_cap_tier=ctx.market_cap_tier,
                symbol=ctx.symbol,
                status="skipped",
                skip_reason=gate.reason,
                trigger_idx=ctx.idx,
                trigger_time=ctx.ts(),
                evidence=gate.evidence,
                data_flags=gate.metrics,
            )]
    lookback = int(tier_param(ctx.market_cap_tier, "breakout_lookback"))
    if ctx.idx < lookback + 3:
        return out

    # 在 [idx-6, idx] 内找最近突破根，当前根作为回踩确认
    search_start = max(lookback, ctx.idx - 6)
    for break_idx in range(ctx.idx - 1, search_start - 1, -1):
        for direction, level_fn, side_ok in (
            ("long", lookback_high, lambda c, lvl: c > lvl),
            ("short", lookback_low, lambda c, lvl: c < lvl),
        ):
            level = level_fn(ctx.df_15m, break_idx, lookback)
            if level is None or level <= 0:
                continue
            brow = ctx.df_15m.iloc[break_idx]
            bclose = float(brow["close"])
            if not side_ok(bclose, level):
                continue
            # 突破根 RVOL
            rv_break = rvol_at(ctx.df_15m, break_idx)
            thr = tier_param(ctx.market_cap_tier, "rvol_15m")
            if rv_break is None or rv_break < thr:
                continue
            atr_b = atr_at(ctx.df_15m, break_idx)
            chase = check_chase_distance(close=bclose, level=level, atr=atr_b, direction=direction)
            if not chase.ok:
                continue
            # 收盘回到结构内 → 假突破，本策略不做（留给 S06/S07）
            if direction == "long" and bclose <= level:
                continue
            if direction == "short" and bclose >= level:
                continue

            # 确认根 = ctx.idx：回踩不破
            crow = ctx.df_15m.iloc[ctx.idx]
            cclose = float(crow["close"])
            clow, chigh = float(crow["low"]), float(crow["high"])
            rv_now = rvol_at(ctx.df_15m, ctx.idx)
            if direction == "long":
                # 回踩触及突破位附近且收盘仍在外；回踩量 < 突破量
                near = clow <= level * 1.002
                held = cclose > level
                vol_ok = float(crow["volume"]) < float(brow["volume"]) * 1.05
                if not (near and held and vol_ok):
                    # 或再次放量延续
                    cont = cclose > level and rv_now is not None and rv_now >= thr and cclose > bclose
                    if not cont:
                        continue
                    evidence_extra = ["延续放量确认"]
                else:
                    evidence_extra = ["回踩不破确认"]
            else:
                near = chigh >= level * 0.998
                held = cclose < level
                vol_ok = float(crow["volume"]) < float(brow["volume"]) * 1.05
                if not (near and held and vol_ok):
                    cont = cclose < level and rv_now is not None and rv_now >= thr and cclose < bclose
                    if not cont:
                        continue
                    evidence_extra = ["延续放量确认"]
                else:
                    evidence_extra = ["回踩不破确认"]

            mtf_ok, mtf_note = _mtf_bias(ctx, direction)
            if not mtf_ok:
                continue

            sd = base_gates(ctx)
            if not sd.ok and sd.reason in ("t3_depth_missing", "depth_insufficient", "spread_too_wide", "platform_halt"):
                continue

            entry = cclose
            stop, target = structure_stop_target(
                entry=entry, direction=direction, structure_level=level, atr=atr_at(ctx.df_15m, ctx.idx)
            )
            rr = check_rr(entry=entry, stop=stop, target=target, direction=direction,
                          fee_pct=ctx.fee_pct, slip_pct=ctx.slip_pct)
            if not rr.ok:
                continue

            out.append(V2Signal(
                signal_type="S01",
                market_cap_tier=ctx.market_cap_tier,
                symbol=ctx.symbol,
                direction=direction,
                status="entry_ready",
                trigger_idx=break_idx,
                trigger_time=bar_ts(ctx.df_15m, break_idx),
                confirm_idx=ctx.idx,
                confirm_time=ctx.ts(),
                entry_idx=ctx.idx,
                entry_time=ctx.ts(),
                entry_price=entry,
                stop_price=stop,
                target_price=target,
                structure_level=level,
                rvol=rv_break,
                risk_r=tier_param(ctx.market_cap_tier, "risk_r"),
                evidence=[
                    f"突破位={level:.6g}",
                    f"突破RVOL={rv_break:.2f}",
                    mtf_note,
                    *evidence_extra,
                    *rr.evidence,
                ],
                data_flags={**chase.metrics, **rr.metrics, "break_idx": break_idx},
            ))
            return out  # 同根只取最近一个有效 S01
    return out
