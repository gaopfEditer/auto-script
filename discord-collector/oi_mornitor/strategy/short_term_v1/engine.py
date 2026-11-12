"""短线策略 V1 引擎：机会 → 过滤 → 决策 → 仓位/成交 → 分批出场。同一内核，消融靠开关。"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable

import numpy as np
import pandas as pd

from oi_mornitor.market_regime import classify_trend_regime
from oi_mornitor.strategy.decision_layer import walk_forward_windows
from oi_mornitor.strategy.short_term_v1.ablation import (
    ExperimentFlags,
    flags_for,
    passes_btc_regime_filter,
    passes_oi_funding_liq_confirm,
)
from oi_mornitor.strategy.short_term_v1.abort import (
    AbortContext,
    blocking_hits,
    evaluate_aborts,
    first_block_reason,
    size_down_hits,
)
from oi_mornitor.strategy.short_term_v1.atr import atr_at
from oi_mornitor.strategy.short_term_v1.decision import TradeDecision, build_decision
from oi_mornitor.strategy.short_term_v1.exits import run_exit_path
from oi_mornitor.strategy.short_term_v1.fills import FILL_RULES_ZH, apply_entry_fill
from oi_mornitor.strategy.short_term_v1.params import (
    BREAKEVEN_AFTER_TP1,
    D_SLIPPAGE_BUFFER_PCT,
    DEFAULT_EQUITY,
    PRICE_PROXY_NOTE,
    RESEARCH_DISCLAIMER,
    TIMEOUT_BARS_5M,
    risk_percent_for,
)
from oi_mornitor.strategy.short_term_v1.patterns import (
    filter_paused_candidates,
    try_collect_existing_patterns,
)
from oi_mornitor.strategy.short_term_v1.setups import (
    evaluate_absorption,
    evaluate_breakout_pullback,
    evaluate_liquidation_exhaustion,
    evaluate_liquidity_sweep_reclaim,
    evaluate_relative_strength,
)
from oi_mornitor.strategy.short_term_v1.sizing import size_trade
from oi_mornitor.strategy.short_term_v1.tiers import classify_tier, is_equity_token
from oi_mornitor.symbol_aliases import human_base_asset, normalize_usdt_symbol
from oi_mornitor.trade_diagnostics import summarize_diagnostics
from oi_mornitor.trade_leverage import audit_assumptions, leverage_for_symbol


def _align_idx(df: pd.DataFrame | None, ts: int, ts_col: str = "open_time") -> int | None:
    if df is None or len(df) == 0 or ts_col not in df.columns:
        return None
    times = df[ts_col].to_numpy(dtype="int64", copy=False)
    if times.size == 0:
        return None
    if int(times[-1]) < 1e12 and ts > 1e12:
        times = times * 1000
    j = int(np.searchsorted(times, int(ts), side="right") - 1)
    return j if j >= 0 else None


def _bar_ts(df: pd.DataFrame, idx: int, ts_col: str = "open_time") -> int | None:
    if df is None or idx < 0 or idx >= len(df) or ts_col not in df.columns:
        return None
    t = int(df.iloc[idx][ts_col])
    return t * 1000 if t < 1e12 else t


def candidate_event_ts(df_15m: pd.DataFrame | None, cand: dict[str, Any]) -> int:
    idx = int(cand.get("confirm_idx") or cand.get("bar_index") or cand.get("barIndex") or 0)
    return int(_bar_ts(df_15m, idx) or 0) if df_15m is not None else 0


def sort_candidates_by_time(candidates: list[dict[str, Any]], df_15m: pd.DataFrame | None) -> list[dict[str, Any]]:
    """形态与 setup 按信号时间混排，避免先处理完全部旧形态再占满风险额度。"""
    return sorted(
        candidates,
        key=lambda c: (
            candidate_event_ts(df_15m, c),
            int(c.get("confirm_idx") or c.get("bar_index") or c.get("barIndex") or 0),
            str(c.get("setup") or c.get("kind") or ""),
            str(c.get("direction") or ""),
        ),
    )


def release_expired_risks(open_positions: list[tuple[int, float]], now_ts: int) -> list[tuple[int, float]]:
    """exit_ts <= now_ts 的仓位已结束，释放其风险占用。"""
    return [pos for pos in open_positions if pos[0] > now_ts]


def _oi_status(df: pd.DataFrame, idx: int) -> tuple[str, bool, float | None]:
    if df is None or "oi" not in df.columns or idx < 1:
        return "oi_unavailable", False, None
    try:
        c, p = float(df.iloc[idx]["oi"]), float(df.iloc[idx - 1]["oi"])
    except (TypeError, ValueError):
        return "oi_unavailable", False, None
    if not (c > 0 and p > 0):
        return "oi_unavailable", False, None
    chg = (c - p) / p
    if abs(chg) < 0.005:
        return "pending", True, chg
    return "confirmed", True, chg


def _next_open(df: pd.DataFrame, idx: int) -> tuple[float | None, int | None]:
    if idx + 1 >= len(df):
        return None, None
    return float(df.iloc[idx + 1]["open"]), idx + 1


def _bars_from(df: pd.DataFrame, start_idx: int, limit: int | None = None) -> list[dict[str, float]]:
    if df is None or len(df) == 0:
        return []
    start = max(0, int(start_idx))
    end = len(df) if limit is None else min(len(df), start + max(0, int(limit)))
    if start >= end:
        return []
    sl = df.iloc[start:end]
    opens = sl["open"].to_numpy(dtype=float, copy=False)
    highs = sl["high"].to_numpy(dtype=float, copy=False)
    lows = sl["low"].to_numpy(dtype=float, copy=False)
    closes = sl["close"].to_numpy(dtype=float, copy=False)
    if "open_time" in sl.columns:
        tss = sl["open_time"].to_numpy(dtype="int64", copy=False)
    else:
        tss = np.arange(start, end, dtype="int64")
    return [
        {"ts": int(ts), "open": float(o), "high": float(h), "low": float(l), "close": float(c)}
        for ts, o, h, l, c in zip(tss, opens, highs, lows, closes)
    ]


def collect_setup_candidates(
    df_15m: pd.DataFrame,
    *,
    symbol: str,
    df_btc: pd.DataFrame | None = None,
    start_idx: int = 60,
    cvd_col: str = "cvd",
    liq_events: list[dict[str, Any]] | None = None,
    liq_available: bool = False,
) -> list[dict[str, Any]]:
    """在 15m 上扫描五类机会。CVD / 清算缺失时对应形态带 skip 标记（不 silently 当作检出）。"""
    if df_15m is None or len(df_15m) < start_idx + 3:
        return []
    out: list[dict[str, Any]] = []
    n = len(df_15m)
    last: dict[str, int] = {}
    liq = liq_events if liq_available else None
    for i in range(start_idx, n - 1):
        for side in ("long", "short"):
            if i - last.get(f"sweep_{side}", -99) < 3:
                continue
            r = evaluate_liquidity_sweep_reclaim(df_15m, idx=i, side=side)
            if r.accepted or r.skip_reason == "sweep_without_reclaim":
                out.append({"symbol": symbol, "source": "setup", **r.to_dict()})
                if r.accepted:
                    last[f"sweep_{side}"] = i
        for side in ("long", "short"):
            if i - last.get(f"pb_{side}", -99) < 4:
                continue
            r = evaluate_breakout_pullback(df_15m, idx=i, side=side)
            if r.accepted or r.skip_reason == "wick_only_breakout":
                out.append({"symbol": symbol, "source": "setup", **r.to_dict()})
                if r.accepted:
                    last[f"pb_{side}"] = i
        if i - last.get("abs", -99) >= 4:
            r = evaluate_absorption(df_15m, idx=i, cvd_col=cvd_col)
            out.append({"symbol": symbol, "source": "setup", **r.to_dict()})
            if r.accepted:
                last["abs"] = i
        if i - last.get("rs", -99) >= 6:
            r = evaluate_relative_strength(df_15m, df_btc, idx=i)
            if r.accepted or r.skip_reason in ("laggard_no_long", "btc_series_missing"):
                out.append({"symbol": symbol, "source": "setup", **r.to_dict()})
                if r.accepted:
                    last["rs"] = i
        if i - last.get("liq", -99) >= 6:
            r = evaluate_liquidation_exhaustion(df_15m, idx=i, liq_events=liq)
            out.append({"symbol": symbol, "source": "setup", **r.to_dict()})
            if r.accepted:
                last["liq"] = i
    return out


def _max_drawdown(pnls: list[float]) -> float | None:
    if not pnls:
        return None
    eq = 0.0
    peak = 0.0
    dd = 0.0
    for p in pnls:
        eq += p
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    return round(dd, 6)


def _summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    settled = [
        r for r in rows
        if str(r.get("outcome") or r.get("exit_reason") or "") not in ("", "pending", "skipped")
        and not r.get("skipped")
    ]
    # 把出场状态机字段对齐到诊断摘要
    norm: list[dict[str, Any]] = []
    pnls: list[float] = []
    for r in settled:
        row = dict(r)
        reason = str(row.get("exit_reason") or row.get("outcome") or "")
        if reason == "stop_loss" or reason == "liquidation":
            row["outcome"] = "stop_loss"
        elif reason.startswith("tp_") or reason in ("trail_giveback", "atr_trail", "structure_break", "timeout"):
            row.setdefault("outcome", "take_profit" if (row.get("realized_r") or 0) > 0 else "flat")
            if (row.get("realized_r") or 0) > 0:
                row["outcome"] = "take_profit"
                row["tp1Hit"] = True
        if row.get("pnlPct") is None and row.get("realized_r") is not None:
            # 用已实现 R × 初始风险% 作价格变动近似，再按杠杆在诊断里处理
            try:
                risk = abs(float(row["entry"]) - float(row["stop_loss"])) / float(row["entry"]) * 100.0
                row["pnlPct"] = float(row["realized_r"]) * risk
            except (TypeError, ValueError, ZeroDivisionError):
                pass
        if row.get("pnlPct") is not None:
            try:
                pnls.append(float(row["pnlPct"]))
            except (TypeError, ValueError):
                pass
        norm.append(row)
    diag = summarize_diagnostics(norm)
    total = round(sum(pnls), 6) if pnls else 0.0
    n = len(norm)
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gw, gl = sum(wins), abs(sum(losses))
    pf = (gw / gl) if gl > 0 else (None if gw <= 0 else None)
    exp = (sum(pnls) / n) if n else None
    wr = (len(wins) / n) if n else None
    diag.update({
        "totalPnlPct": total,
        "netPnlPct": total,
        "expectancy": round(exp, 6) if exp is not None else diag.get("expectancy"),
        "profitFactor": round(pf, 4) if pf is not None else diag.get("profitFactor"),
        "maxDrawdownPct": _max_drawdown(pnls),
        "winRate": round(wr, 4) if wr is not None else None,
        "nSettled": n,
        "total": n,
        "expectancyR": round(exp, 6) if exp is not None else diag.get("expectancy"),
    })
    return diag


def _breakdown(rows: list[dict[str, Any]], key: str) -> dict[str, Any]:
    buckets: dict[str, list] = defaultdict(list)
    for r in rows:
        if r.get("skipped"):
            continue
        buckets[str(r.get(key) or "unknown")].append(r)
    return {k: _summarize(v) | {"n": len(v)} for k, v in buckets.items()}


def decide_candidate(
    cand: dict[str, Any],
    *,
    flags: ExperimentFlags,
    tier_info,
    df_15m: pd.DataFrame,
    df_4h: pd.DataFrame | None,
    df_btc_4h: pd.DataFrame | None,
    entry_open: float | None,
    atr_15m: float | None,
    regime_4h: str | None,
    abort_ctx: AbortContext,
    equity: float,
    open_risks: list[float],
    fee_pct: float,
    slippage_pct: float,
) -> TradeDecision:
    symbol = str(cand.get("symbol") or tier_info.symbol)
    setup = str(cand.get("setup") or cand.get("kind") or "")
    direction = cand.get("direction")
    evidence = list(cand.get("evidence") or [])
    data_flags = dict(cand.get("data_flags") or {})
    kind = str(cand.get("kind") or setup)

    # 暂停形态（二次探底默认；射击之星默认不暂停）
    if flags.exclude_paused_kinds:
        from oi_mornitor.strategy.short_term_v1.patterns import honor_pause

        if honor_pause(kind, cand.get("typeLabel") or cand.get("type_label")):
            return build_decision(
                symbol=symbol, tier=tier_info.tier, setup=setup, direction=direction,
                entry=entry_open, structure_level=cand.get("structure_level"),
                atr_15m=atr_15m, market_regime=str(regime_4h or ""),
                evidence=evidence, data_flags=data_flags, kind=kind,
                force_skip="paused_kind",
                per_tier=flags.per_tier_params,
            )

    if not cand.get("accepted", True) and cand.get("skip_reason"):
        return build_decision(
            symbol=symbol, tier=tier_info.tier, setup=setup, direction=direction,
            entry=entry_open, structure_level=cand.get("structure_level"),
            atr_15m=atr_15m, market_regime=str(regime_4h or ""),
            evidence=evidence, data_flags=data_flags, kind=kind,
            force_skip=str(cand["skip_reason"]),
            per_tier=flags.per_tier_params,
        )

    if tier_info.skipped:
        return build_decision(
            symbol=symbol, tier=tier_info.tier, setup=setup, direction=direction,
            entry=entry_open, structure_level=cand.get("structure_level"),
            atr_15m=atr_15m, market_regime=str(regime_4h or ""),
            evidence=evidence + tier_info.evidence, data_flags=data_flags | {"depth_missing": tier_info.depth_missing},
            kind=kind, force_skip=tier_info.skip_reason or "tier_skipped",
            per_tier=flags.per_tier_params,
        )

    hits = evaluate_aborts(abort_ctx)
    block = first_block_reason(hits)
    data_flags["aborts"] = [h.to_dict() for h in hits if h.triggered or h.data_missing]
    if block:
        return build_decision(
            symbol=symbol, tier=tier_info.tier, setup=setup, direction=direction,
            entry=entry_open, structure_level=cand.get("structure_level"),
            atr_15m=atr_15m, market_regime=str(regime_4h or ""),
            evidence=evidence + [block], data_flags=data_flags, kind=kind,
            force_skip=blocking_hits(hits)[0].rule,
            per_tier=flags.per_tier_params,
        )

    ok_btc, why_btc = passes_btc_regime_filter(
        flags=flags,
        direction=direction,
        btc_regime_4h=abort_ctx.btc_regime_4h,
        is_btc=human_base_asset(symbol) == "BTC",
    )
    if not ok_btc:
        return build_decision(
            symbol=symbol, tier=tier_info.tier, setup=setup, direction=direction,
            entry=entry_open, structure_level=cand.get("structure_level"),
            atr_15m=atr_15m, market_regime=str(regime_4h or ""),
            evidence=evidence + [why_btc], data_flags=data_flags, kind=kind,
            force_skip=why_btc, per_tier=flags.per_tier_params,
        )

    if flags.oi_funding_liq_confirm:
        ok_c, why_c, cflags = passes_oi_funding_liq_confirm(
            flags=flags,
            oi_status=abort_ctx.oi_change_pct is not None and ("confirmed" if abort_ctx.oi_available else None) or (
                "oi_unavailable" if not abort_ctx.oi_available else "pending"
            ),
            oi_available=abort_ctx.oi_available,
            funding_ok=None if not abort_ctx.funding_available else (
                False if abort_ctx.funding_rate is not None and abs(abort_ctx.funding_rate) >= 0.0005
                and (
                    (direction in ("long", "bull") and abort_ctx.funding_rate > 0)
                    or (direction in ("short", "bear") and abort_ctx.funding_rate < 0)
                )
                else True
            ),
            funding_available=abort_ctx.funding_available,
            liq_ok=None if not abort_ctx.__dict__.get("liq_available", False) else True,
            liq_available=bool(abort_ctx.__dict__.get("liq_available", False)),
        )
        data_flags.update(cflags)
        if not ok_c:
            return build_decision(
                symbol=symbol, tier=tier_info.tier, setup=setup, direction=direction,
                entry=entry_open, structure_level=cand.get("structure_level"),
                atr_15m=atr_15m, market_regime=str(regime_4h or ""),
                evidence=evidence + [why_c], data_flags=data_flags, kind=kind,
                force_skip=why_c, per_tier=flags.per_tier_params,
            )

    fill = apply_entry_fill(
        entry_open or 0.0,
        side=str(direction or "long"),
        slippage_pct=slippage_pct,
        fee_pct=fee_pct,
    )
    if fill.unfilled or fill.filled is None:
        return build_decision(
            symbol=symbol, tier=tier_info.tier, setup=setup, direction=direction,
            entry=entry_open, structure_level=cand.get("structure_level"),
            atr_15m=atr_15m, market_regime=str(regime_4h or ""),
            evidence=evidence + [fill.reason or "unfilled"], data_flags=data_flags, kind=kind,
            force_skip=fill.reason or "unfilled", per_tier=flags.per_tier_params,
        )

    slip_buf = D_SLIPPAGE_BUFFER_PCT if (tier_info.tier == "D" and flags.per_tier_params) else 0.0
    dec = build_decision(
        symbol=symbol,
        tier=tier_info.tier,
        setup=setup,
        direction=direction,
        entry=fill.filled,
        structure_level=cand.get("structure_level") or cand.get("sweep_extreme"),
        atr_15m=atr_15m,
        market_regime=str(regime_4h or ""),
        evidence=evidence,
        nearby_liquidity=str(cand.get("liquidity_level") or cand.get("structure_level") or ""),
        volume_confirmed=cand.get("data_flags", {}).get("close_bos") or cand.get("data_flags", {}).get("pullback_volume") == "contraction",
        oi_status="confirmed" if abort_ctx.oi_available else "oi_unavailable",
        data_flags=data_flags,
        kind=kind,
        per_tier=flags.per_tier_params,
        slippage_buffer_pct=slip_buf,
    )
    if dec.skipped or dec.entry is None or dec.stop_loss is None:
        return dec

    sd_mult = 0.5 if size_down_hits(hits) else 1.0
    sz = size_trade(
        entry=dec.entry,
        stop=dec.stop_loss,
        tier=tier_info.tier,
        equity=equity,
        per_tier=flags.per_tier_params,
        open_risk_percents=open_risks,
        size_down_mult=sd_mult,
    )
    if sz.skipped:
        dec.skipped = True
        dec.skip_reason = sz.skip_reason
        dec.evidence = list(dec.evidence) + [sz.skip_reason or "size_skip"]
        return dec
    dec.position_qty = sz.qty
    dec.risk_percent = sz.risk_percent
    return dec


def settle_decision(
    dec: TradeDecision,
    bars_5m: list[dict[str, float]],
    *,
    fee_pct: float,
    slippage_pct: float,
    per_tier: bool,
) -> dict[str, Any]:
    row = dec.to_dict()
    if dec.skipped or dec.entry is None or dec.stop_loss is None or dec.direction is None:
        row["outcome"] = "skipped"
        return row
    state = run_exit_path(
        bars_5m,
        side=dec.direction,
        entry=dec.entry,
        stop=dec.stop_loss,
        tier=dec.tier,
        per_tier_targets=per_tier,
        breakeven_after_tp1=BREAKEVEN_AFTER_TP1,
        timeout_bars=TIMEOUT_BARS_5M,
    )
    row["exit_reason"] = state.exit_reason
    row["exit_price"] = state.exit_price
    if bars_5m:
        row["entryAt"] = int(bars_5m[0]["ts"])
        held = int(state.bars_held or 0)
        exit_i = min(max(held - 1, 0), len(bars_5m) - 1)
        row["exitAt"] = int(bars_5m[exit_i]["ts"])
    row["realized_r"] = state.realized_r
    row["remaining"] = state.remaining
    row["tp_hits"] = state.tp_hits
    row["mfe_r"] = state.mfe_r
    row["mae_r"] = state.mae_r
    row["bars_held"] = state.bars_held
    row["moved_to_breakeven"] = state.moved_to_breakeven
    row["outcome"] = state.exit_reason or "open"
    # 净价格变动 %：已实现 R × 初始风险% ，再扣双边费用滑点（近似）
    try:
        risk_pct = abs(dec.entry - dec.stop_loss) / dec.entry * 100.0
        raw = float(state.realized_r) * risk_pct
        from oi_mornitor.strategy.short_term_v1.fills import net_price_move

        row["pnlPctGross"] = raw
        row["pnlPct"] = net_price_move(raw, fee_pct=fee_pct, slippage_pct=slippage_pct)
        row["mfePct"] = state.mfe_r * risk_pct
        row["maePct"] = state.mae_r * risk_pct
    except (TypeError, ValueError, ZeroDivisionError):
        pass
    row["leverage"] = leverage_for_symbol(dec.symbol)
    if row.get("outcome") == "stop_loss":
        pass
    elif str(row.get("exit_reason") or "").startswith("tp_") or row.get("exit_reason") in (
        "trail_giveback", "atr_trail", "structure_break"
    ):
        if (row.get("realized_r") or 0) > 0:
            row["outcome"] = "take_profit"
            row["tp1Hit"] = any(str(h.get("reason") or "").startswith("tp_") for h in state.tp_hits)
    return row


def run_on_frames(
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
    notes: dict[str, Any] = {"tier": tier_info.to_dict(), "experiment": flags.to_dict()}

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
    open_positions: list[tuple[int, float]] = []  # (exit_ts, risk_percent)
    n = len(df_15m) if df_15m is not None else 0

    for cand in candidates:
        idx = int(cand.get("confirm_idx") or cand.get("bar_index") or cand.get("barIndex") or 0)
        if idx < 0 or (n and idx >= n - 1):
            # 已拒绝的扫描结果仍记录
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
        open_positions = release_expired_risks(open_positions, ts)
        open_risks = [risk for _, risk in open_positions]
        idx4 = _align_idx(df_4h, ts)
        r4 = None
        if df_4h is not None and idx4 is not None:
            r4 = classify_trend_regime(df_4h, end_idx=idx4, tf="4h").label
        btc_r4 = None
        if df_btc_4h is not None:
            bi = _align_idx(df_btc_4h, ts)
            if bi is not None:
                btc_r4 = classify_trend_regime(df_btc_4h, end_idx=bi, tf="4h").label
        elif human_base_asset(sym) == "BTC" and r4:
            btc_r4 = r4
        atr = atr_at(df_15m, idx)
        nxt, entry_bar = _next_open(df_15m, int(cand.get("confirm_idx") or idx))
        oi_st, oi_ok, oi_chg = _oi_status(df_15m, idx)
        # 简易暴涨：近 3 根 15m 涨幅
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
        exec_df = df_5m if df_5m is not None and len(df_5m) else df_15m
        start_exec = 0
        if exec_df is not None and "open_time" in exec_df.columns and ts:
            al = _align_idx(exec_df, ts)
            start_exec = (al + 1) if al is not None else 0
        elif entry_bar is not None and exec_df is df_15m:
            start_exec = entry_bar
        row = settle_decision(
            dec,
            _bars_from(exec_df, start_exec, limit=TIMEOUT_BARS_5M + 8) if not dec.skipped else [],
            fee_pct=fee_pct,
            slippage_pct=slippage_pct,
            per_tier=flags.per_tier_params,
        )
        row["signalAt"] = ts
        row["leverage"] = leverage_for_symbol(sym)
        decisions.append(row)
        if (not dec.skipped) and dec.risk_percent and (not row.get("skipped")):
            if row.get("exitAt") is not None:
                exit_ts = int(row["exitAt"])
            else:
                exit_ts = int(ts) + int(TIMEOUT_BARS_5M) * 5 * 60 * 1000
            open_positions.append((exit_ts, float(dec.risk_percent)))

    accepted = [d for d in decisions if not d.get("skipped")]
    skipped = [d for d in decisions if d.get("skipped")]
    summary = _summarize(accepted)
    return {
        "symbol": sym,
        "experiment": flags.to_dict(),
        "tier": tier_info.to_dict(),
        "items": decisions,
        "accepted": accepted,
        "skipped": skipped,
        "summary": summary,
        "bySetup": _breakdown(accepted, "setup"),
        "byTier": _breakdown(accepted, "tier"),
        "byRegime": _breakdown(accepted, "market_regime"),
        "notes": notes,
        "fillRules": FILL_RULES_ZH,
        "priceProxyNote": PRICE_PROXY_NOTE,
        "disclaimer": RESEARCH_DISCLAIMER,
        "assumptions": audit_assumptions(),
        "walkForwardWindows": (
            walk_forward_windows(int(df_15m.iloc[0]["open_time"]), int(df_15m.iloc[-1]["open_time"]))
            if df_15m is not None and len(df_15m) and "open_time" in df_15m.columns
            else []
        ),
    }


def merge_symbol_results(results: list[dict[str, Any]], *, experiment: str) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for r in results:
        items.extend(r.get("accepted") or [])
        skipped.extend(r.get("skipped") or [])
        # 也保留未通过的决策便于审计（不进盈亏）
    flags = flags_for(experiment)
    summary = _summarize(items)
    return {
        "experiment": flags.to_dict(),
        "summary": summary,
        "bySymbol": _breakdown(items, "symbol"),
        "bySetup": _breakdown(items, "setup"),
        "byTier": _breakdown(items, "tier"),
        "byRegime": _breakdown(items, "market_regime"),
        "itemCount": len(items),
        "skippedCount": len(skipped),
        "items": items,
        "skipped": skipped[:500],
        "skippedTruncated": len(skipped) > 500,
        "fillRules": FILL_RULES_ZH,
        "priceProxyNote": PRICE_PROXY_NOTE,
        "disclaimer": RESEARCH_DISCLAIMER,
        "assumptions": audit_assumptions(),
        "optimizationTarget": (
            "单笔净期望转正；盈亏比不长期低于 1；利润因子样本外 > 1；"
            "更少更高质量的交易。不是 55% 胜率目标。"
        ),
    }
