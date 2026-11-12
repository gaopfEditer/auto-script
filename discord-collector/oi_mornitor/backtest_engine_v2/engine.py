"""V2 回测循环：复用 V1 信号与决策，只替换对齐、4H 已收盘、结算与摘要。"""
from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.backtest_engine_v2.alignment import (
    INTERVAL_MS,
    execution_path,
    last_closed_idx,
    signal_timeline,
    to_ms,
)
from oi_mornitor.backtest_engine_v2.settle import attach_settlement
from oi_mornitor.backtest_engine_v2.summarize import breakdown_v2, skip_counts, summarize_v2
from oi_mornitor.market_regime import classify_trend_regime
from oi_mornitor.strategy.short_term_v1.abort import AbortContext
from oi_mornitor.strategy.short_term_v1.ablation import flags_for
from oi_mornitor.strategy.short_term_v1.atr import atr_at
from oi_mornitor.strategy.short_term_v1.decision import build_decision
from oi_mornitor.strategy.short_term_v1.engine import (
    _bar_ts,
    _next_open,
    _oi_status,
    collect_setup_candidates,
    decide_candidate,
    release_expired_risks,
    sort_candidates_by_time,
)
from oi_mornitor.strategy.short_term_v1.fills import FILL_RULES_ZH
from oi_mornitor.strategy.short_term_v1.params import (
    DEFAULT_EQUITY,
    PRICE_PROXY_NOTE,
    RESEARCH_DISCLAIMER,
    TIMEOUT_BARS_5M,
)
from oi_mornitor.strategy.short_term_v1.patterns import filter_paused_candidates, try_collect_existing_patterns
from oi_mornitor.strategy.short_term_v1.tiers import classify_tier, is_equity_token
from oi_mornitor.symbol_aliases import human_base_asset, normalize_usdt_symbol
from oi_mornitor.trade_diagnostics import audit_assumptions
from oi_mornitor.trade_leverage import leverage_for_symbol


def _closed_regime(df: pd.DataFrame | None, asof_ts: int, interval: str) -> str | None:
    idx = last_closed_idx(df, asof_ts, interval)
    if df is None or idx is None:
        return None
    return classify_trend_regime(df, end_idx=idx, tf=interval).label


def run_on_frames_v2(
    *,
    symbol: str,
    df_15m: pd.DataFrame,
    df_5m: pd.DataFrame | None = None,
    df_1h: pd.DataFrame | None = None,
    df_4h: pd.DataFrame | None = None,
    df_btc_15m: pd.DataFrame | None = None,
    df_btc_4h: pd.DataFrame | None = None,
    experiment: str = "E",
    equity: float = DEFAULT_EQUITY,
    fee_pct: float = 0.06,
    slippage_pct: float = 0.03,
    start_idx: int = 60,
    vol_30d_quote: float | None = None,
    depth: float | None = None,
    liq_events: list[dict[str, Any]] | None = None,
    funding_series: list | None = None,
    cvd_col: str = "cvd",
    include_existing_patterns: bool | None = None,
) -> dict[str, Any]:
    flags = flags_for(experiment)
    sym = normalize_usdt_symbol(symbol) or symbol
    tier_info = classify_tier(sym, vol_30d_quote=vol_30d_quote, depth=depth, df=df_15m)
    candidates: list[dict[str, Any]] = []
    notes: dict[str, Any] = {
        "tier": tier_info.to_dict(),
        "experiment": flags.to_dict(),
        "engine": "backtest_engine_v2",
        "phase": 1,
    }

    if flags.include_existing_patterns if include_existing_patterns is None else include_existing_patterns:
        pats, pnote = try_collect_existing_patterns(
            df_15m, symbol=sym, exclude_paused=flags.exclude_paused_kinds
        )
        notes["existingPatterns"] = pnote
        for p in pats:
            p.setdefault("accepted", True)
            p.setdefault("setup", p.get("kind") or "existing_pattern")
            p.setdefault("direction", "long" if str(p.get("side") or "") in ("bull", "long") else (
                "short" if str(p.get("side") or "") in ("bear", "short") else p.get("direction")
            ))
        candidates.extend(pats)

    if flags.sweep_cvd_absorption:
        setups = collect_setup_candidates(
            df_15m,
            symbol=sym,
            df_btc=df_btc_15m,
            start_idx=start_idx,
            cvd_col=cvd_col,
            liq_events=liq_events,
            liq_available=liq_events is not None,
        )
        candidates.extend(setups)
        notes["setupsScanned"] = True
    else:
        notes["setupsScanned"] = False

    if flags.exclude_paused_kinds:
        candidates = filter_paused_candidates(candidates, exclude_paused=True)

    candidates = sort_candidates_by_time(candidates, df_15m)
    decisions: list[dict[str, Any]] = []
    open_positions: list[tuple[int, float]] = []
    n = len(df_15m) if df_15m is not None else 0

    for cand in candidates:
        idx = int(cand.get("confirm_idx") or cand.get("bar_index") or cand.get("barIndex") or 0)
        if idx < 0 or (n and idx >= n - 1):
            if not cand.get("accepted", True):
                dec = build_decision(
                    symbol=sym, tier=tier_info.tier, setup=str(cand.get("setup") or ""),
                    direction=cand.get("direction"), entry=None,
                    structure_level=cand.get("structure_level"), atr_15m=None,
                    market_regime="", evidence=list(cand.get("evidence") or []),
                    data_flags=dict(cand.get("data_flags") or {}),
                    force_skip=str(cand.get("skip_reason") or "incomplete"),
                    per_tier=flags.per_tier_params, kind=cand.get("kind"),
                )
                decisions.append(dec.to_dict())
            continue
        ts = _bar_ts(df_15m, idx) or 0
        timeline = signal_timeline(ts, signal_tf="15m")
        confirm_ts = timeline["signalCloseAt"]
        fill_ts = timeline["fillAt"]
        open_positions = release_expired_risks(open_positions, ts)
        open_risks = [risk for _, risk in open_positions]
        r4 = _closed_regime(df_4h, confirm_ts, "4h")
        btc_r4 = _closed_regime(df_btc_4h, confirm_ts, "4h")
        if btc_r4 is None and human_base_asset(sym) == "BTC" and r4:
            btc_r4 = r4
        atr = atr_at(df_15m, idx)
        nxt, _entry_bar = _next_open(df_15m, int(cand.get("confirm_idx") or idx))
        oi_st, oi_ok, oi_chg = _oi_status(df_15m, idx)
        spike = False
        spike_pct = None
        if idx >= 3:
            c0 = float(df_15m.iloc[idx - 3]["close"])
            c1 = float(df_15m.iloc[idx]["close"])
            if c0 > 0:
                spike_pct = (c1 - c0) / c0
                spike = spike_pct >= 0.08
        high, low, close, op = (
            float(df_15m.iloc[idx]["high"]),
            float(df_15m.iloc[idx]["low"]),
            float(df_15m.iloc[idx]["close"]),
            float(df_15m.iloc[idx]["open"]),
        )
        rng = max(high - low, 1e-12)
        upper_wick = (high - max(close, op)) / rng
        ctx = AbortContext(
            symbol=sym,
            tier=tier_info.tier,
            direction=cand.get("direction"),
            is_btc=human_base_asset(sym) == "BTC",
            btc_regime_4h=btc_r4,
            alt_spike=spike and human_base_asset(sym) != "BTC",
            alt_spike_pct=spike_pct if human_base_asset(sym) != "BTC" else None,
            oi_available=oi_ok,
            oi_change_pct=oi_chg,
            price_range_atr=(rng / atr) if atr else None,
            is_breakout=str(cand.get("setup") or "") == "breakout_pullback",
            breakout_volume_ok=(cand.get("data_flags") or {}).get("pullback_volume") != "expansion" if cand.get("setup") == "breakout_pullback" else None,
            depth=tier_info.depth,
            depth_available=not tier_info.depth_missing,
            funding_available=funding_series is not None,
            funding_rate=None,
            upper_wick_ratio=upper_wick,
            is_equity=is_equity_token(sym) or tier_info.is_equity_token,
        )
        dec = decide_candidate(
            cand, flags=flags, tier_info=tier_info, df_15m=df_15m, df_4h=df_4h,
            df_btc_4h=df_btc_4h, entry_open=nxt, atr_15m=atr, regime_4h=r4 or btc_r4,
            abort_ctx=ctx, equity=equity, open_risks=open_risks,
            fee_pct=fee_pct, slippage_pct=slippage_pct,
        )
        bars = [] if dec.skipped else execution_path(df_5m if df_5m is not None and len(df_5m) else None, fill_ts, limit=TIMEOUT_BARS_5M + 8)
        if not dec.skipped and not bars and df_15m is not None:
            # 没有 5m 时，从下一根已收盘 15m 开始（仍不得用信号柱本身）
            from oi_mornitor.backtest_engine_v2.alignment import first_bar_idx_at_or_after, bars_from

            j = first_bar_idx_at_or_after(df_15m, fill_ts)
            bars = bars_from(df_15m, j, limit=max(8, TIMEOUT_BARS_5M // 3)) if j is not None else []
            bars = [b for b in bars if int(b["ts"]) >= fill_ts]
        row = dec.to_dict()
        row["signalAt"] = ts
        row["leverage"] = leverage_for_symbol(sym)
        row["regime4hClosed"] = r4
        row["btcRegime4hClosed"] = btc_r4
        row = attach_settlement(
            row,
            bars=bars,
            timeline=timeline,
            entry_requested=float(nxt) if nxt is not None else None,
            fee_pct=fee_pct,
            slippage_pct=slippage_pct,
            per_tier=flags.per_tier_params,
        )
        decisions.append(row)
        if (not dec.skipped) and dec.risk_percent and (not row.get("skipped")):
            if row.get("exitAt") is not None:
                exit_ts = int(row["exitAt"])
            else:
                exit_ts = int(fill_ts) + int(TIMEOUT_BARS_5M) * INTERVAL_MS["5m"]
            open_positions.append((exit_ts, float(dec.risk_percent)))

    accepted = [d for d in decisions if not d.get("skipped")]
    skipped = [d for d in decisions if d.get("skipped")]
    summary = summarize_v2(accepted, starting_equity=equity)
    return {
        "symbol": sym,
        "engine": "backtest_engine_v2",
        "experiment": flags.to_dict(),
        "tier": tier_info.to_dict(),
        "items": decisions,
        "accepted": accepted,
        "skipped": skipped,
        "skipCounts": skip_counts(skipped),
        "summary": summary,
        "bySetup": breakdown_v2(accepted, "setup", starting_equity=equity),
        "byTier": breakdown_v2(accepted, "tier", starting_equity=equity),
        "byRegime": breakdown_v2(accepted, "market_regime", starting_equity=equity),
        "notes": notes,
        "fillRules": (
            "V2：15m 收盘后确认，下一根 15m 开盘加一次入场滑点成交；"
            "5m 路径从成交时刻开盘柱开始，成交前 K 线不进入路径；"
            "出场按路径原始触发价再加一次不利滑点；双边各收一次手续费，入场滑点不重复扣除。"
            "4H 环境只用已收盘柱。结构破坏按收盘穿越结构位接通。"
        ),
        "priceProxyNote": PRICE_PROXY_NOTE,
        "disclaimer": RESEARCH_DISCLAIMER,
        "assumptions": audit_assumptions() | {
            "engine": "backtest_engine_v2",
            "entrySlippageOnce": True,
            "exitSlippageOnce": True,
            "feeBothSides": True,
            "fundingModeled": False,
            "fourHourUsesClosedBarsOnly": True,
            "pathStartsAtFill": True,
        },
    }


def merge_symbol_results_v2(results: list[dict[str, Any]], *, experiment: str, equity: float) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    all_decisions: list[dict[str, Any]] = []
    for r in results:
        items.extend(r.get("accepted") or [])
        skipped.extend(r.get("skipped") or [])
        all_decisions.extend(r.get("items") or [])
    flags = flags_for(experiment)
    summary = summarize_v2(items, starting_equity=equity)
    timing_n = sum(1 for t in items if t.get("timingIssues"))
    fee_n = sum(1 for t in items if t.get("feeReconcileIssues"))
    return {
        "engine": "backtest_engine_v2",
        "experiment": flags.to_dict(),
        "summary": summary,
        "bySymbol": breakdown_v2(items, "symbol", starting_equity=equity),
        "bySetup": breakdown_v2(items, "setup", starting_equity=equity),
        "byTier": breakdown_v2(items, "tier", starting_equity=equity),
        "byRegime": breakdown_v2(items, "market_regime", starting_equity=equity),
        "items": items,
        "skipped": skipped,
        "skippedCount": len(skipped),
        "skipCounts": skip_counts(skipped),
        "itemCount": len(items),
        "acceptance": {
            "timingIssueTrades": timing_n,
            "feeReconcileIssueTrades": fee_n,
            "pathBeforeFillAllowed": False,
            "passed": timing_n == 0 and fee_n == 0,
        },
        "disclaimer": RESEARCH_DISCLAIMER,
        "assumptions": (results[0].get("assumptions") if results else {}) or {},
        "fillRules": results[0].get("fillRules") if results else "",
        "priceProxyNote": PRICE_PROXY_NOTE,
        "allDecisions": all_decisions,
    }
