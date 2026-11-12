"""用修正后的路径与费用账本结算一笔决策，并写出事件日志。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.backtest_engine_v2.alignment import acceptance_timing, to_ms
from oi_mornitor.backtest_engine_v2.costs import add_leg, new_ledger, reconcile_ledger
from oi_mornitor.backtest_engine_v2.structure import structure_broken_on_close
from oi_mornitor.strategy.short_term_v1.exits import init_exit_state, step_bar, take_profit_payload
from oi_mornitor.strategy.short_term_v1.params import BREAKEVEN_AFTER_TP1, TIMEOUT_BARS_5M


def _tp_levels(tp_hits: list[dict[str, Any]]) -> set[float]:
    out: set[float] = set()
    for h in tp_hits:
        if h.get("r_level") is not None:
            try:
                out.add(float(h["r_level"]))
            except (TypeError, ValueError):
                pass
        reason = str(h.get("reason") or "")
        if reason.startswith("tp_") and reason.endswith("R"):
            try:
                out.add(float(reason[3:-1]))
            except (TypeError, ValueError):
                pass
    return out


def map_exit_flags(state, *, exit_reason: str | None) -> dict[str, Any]:
    levels = _tp_levels(list(state.tp_hits or []))
    tp1 = any(abs(x - 1.0) < 1e-9 or (0.799 <= x <= 0.801) for x in levels) or 1.0 in levels
    # 各档第一固定目标都记入 tp1；第二档（2R 或 1.5/1.8）记入 tp2
    tp2 = any(x >= 1.5 for x in levels)
    # 若第一档就是 0.8R（C/D），也视为 TP1
    if any(abs(x - 0.8) < 1e-9 for x in levels):
        tp1 = True
    reason = str(exit_reason or state.exit_reason or "")
    initial_sl = reason == "stop_loss" and not tp1
    runner = bool(tp2 and reason in ("trail_giveback", "atr_trail", "structure_break"))
    return {
        "exit_reason": reason or None,
        "exitReason": reason or None,
        "tp1Hit": bool(tp1),
        "tp2Hit": bool(tp2),
        "runnerActivated": runner,
        "initialSlHit": initial_sl,
        "tpLevels": sorted(levels),
    }


def run_exit_path_v2(
    bars: list[dict[str, float]],
    *,
    side: str,
    entry: float,
    stop: float,
    tier: str = "A",
    per_tier_targets: bool = True,
    timeout_bars: int = TIMEOUT_BARS_5M,
    breakeven_after_tp1: bool = BREAKEVEN_AFTER_TP1,
    structure_level: float | None = None,
    entry_requested: float | None = None,
    qty: float = 0.0,
    fee_pct: float = 0.06,
    slippage_pct: float = 0.03,
) -> tuple[Any, dict[str, Any], list[dict[str, Any]]]:
    """路径判定仍走 V1 step_bar（含同柱先止损）；结构破坏现在会传入。

    成交账本与路径分离：触发用原始 OHLC，平仓成交价再加出场滑点。
    出场状态机参数本阶段不改。
    """
    targets = take_profit_payload(tier, per_tier=per_tier_targets)
    state = init_exit_state(side=side, entry=entry, stop=stop)
    ledger = new_ledger(
        side=side,
        entry_requested=float(entry_requested if entry_requested is not None else entry),
        entry_filled=float(entry),
        qty=float(qty or 0.0),
        fee_pct=fee_pct,
        slippage_pct=slippage_pct,
    )
    events: list[dict[str, Any]] = []
    booked = 0

    def _book_new_hits(bar_ts: int | None) -> None:
        nonlocal booked
        hits = list(state.tp_hits or [])
        while booked < len(hits):
            h = hits[booked]
            booked += 1
            frac = float(h.get("closed") or 0.0)
            raw = float(h.get("price"))
            reason = str(h.get("reason") or "exit")
            ts = int(bar_ts) if bar_ts is not None else None
            leg = add_leg(ledger, reason=reason, raw_price=raw, frac=frac, ts=ts)
            events.append({
                "type": reason,
                "ts": ts,
                "rawPrice": raw,
                "exitFilled": leg["exitFilled"],
                "frac": frac,
                "r": h.get("r"),
                "rLevel": h.get("r_level"),
                "entryFeeUsdt": leg["entryFeeUsdt"],
                "exitFeeUsdt": leg["exitFeeUsdt"],
                "exitSlipUsdt": leg["exitSlipUsdt"],
                "netUsdt": leg["netUsdt"],
            })

    for bar in bars:
        broken = structure_broken_on_close(bar, side=side, structure_level=structure_level)
        step_bar(
            state,
            bar,
            targets=targets,
            tier=tier,
            timeout_bars=timeout_bars,
            breakeven_after_tp1=breakeven_after_tp1,
            structure_broken=broken,
            structure_stop=structure_level,
        )
        _book_new_hits(int(bar["ts"]) if bar.get("ts") is not None else None)
        if state.done:
            break

    if not state.done and state.remaining > 1e-12 and bars:
        last = bars[-1]
        from oi_mornitor.strategy.short_term_v1.exits import price_to_r, _is_short

        px = float(last["close"])
        frac = float(state.remaining)
        r = price_to_r(px, entry=state.entry, stop=state.initial_stop, is_short=_is_short(state.side))
        state.realized_r += r * frac
        state.realized_frac += frac
        state.remaining = 0.0
        state.done = True
        state.exit_reason = "data_end"
        state.exit_price = px
        state.tp_hits.append({"reason": "data_end", "price": px, "r": r, "closed": frac})
        _book_new_hits(int(last["ts"]) if last.get("ts") is not None else None)

    ledger["reconcileIssues"] = reconcile_ledger(ledger)
    flags = map_exit_flags(state, exit_reason=state.exit_reason)
    return state, ledger, events, flags


def attach_settlement(
    row: dict[str, Any],
    *,
    bars: list[dict[str, float]],
    timeline: dict[str, int],
    entry_requested: float | None,
    fee_pct: float,
    slippage_pct: float,
    per_tier: bool,
) -> dict[str, Any]:
    if row.get("skipped") or row.get("entry") is None or row.get("stop_loss") is None or row.get("direction") is None:
        row["outcome"] = "skipped"
        row["events"] = row.get("events") or []
        return row

    side = str(row["direction"])
    state, ledger, events, flags = run_exit_path_v2(
        bars,
        side=side,
        entry=float(row["entry"]),
        stop=float(row["stop_loss"]),
        tier=str(row.get("tier") or "A"),
        per_tier_targets=per_tier,
        structure_level=(float(row["structure_level"]) if row.get("structure_level") is not None else None),
        entry_requested=entry_requested,
        qty=float(row.get("position_qty") or 0.0),
        fee_pct=fee_pct,
        slippage_pct=slippage_pct,
    )
    fill_at = timeline["fillAt"]
    row.update(timeline)
    row["entryRequested"] = ledger["entryRequested"]
    row["entryFilled"] = ledger["entryFilled"]
    row["entryAt"] = fill_at
    if bars:
        held = int(state.bars_held or 0)
        exit_i = min(max(held - 1, 0), len(bars) - 1)
        row["exitAt"] = int(bars[exit_i]["ts"])
    row["exit_price_raw"] = state.exit_price
    last_leg = (ledger["legs"] or [None])[-1]
    row["exit_price"] = last_leg["exitFilled"] if last_leg else state.exit_price
    row["realized_r"] = state.realized_r
    row["realized_r_path"] = state.realized_r  # 路径原始触发价上的 R，不含出场滑点与手续费
    row["remaining"] = state.remaining
    row["tp_hits"] = state.tp_hits
    row["mfe_r"] = state.mfe_r
    row["mae_r"] = state.mae_r
    row["mfeR"] = state.mfe_r
    row["maeR"] = state.mae_r
    row["bars_held"] = state.bars_held
    row["holdMs"] = int(state.bars_held or 0) * 5 * 60 * 1000
    row["moved_to_breakeven"] = state.moved_to_breakeven
    row.update(flags)
    row["outcome"] = flags["exit_reason"] or "open"
    row["pnlPctGross"] = ledger["pnlPctGross"]
    row["pnlPct"] = ledger["pnlPctNet"]
    row["pnlUsdtGross"] = ledger["grossUsdt"]
    row["pnlUsdt"] = ledger["netUsdt"]
    row["feeUsdt"] = ledger["feeUsdtTotal"]
    row["exitSlipUsdt"] = ledger["exitSlipUsdt"]
    row["feeLedger"] = ledger
    evs = [
        {
            "type": "signal_confirmed",
            "ts": timeline["signalCloseAt"],
            "signalOpenAt": timeline["signalOpenAt"],
        },
        {
            "type": "fill",
            "ts": fill_at,
            "entryRequested": ledger["entryRequested"],
            "entryFilled": ledger["entryFilled"],
            "feeUsdt": ledger.get("legs") and ledger["legs"][0]["entryFeeUsdt"] if ledger.get("legs") else None,
        },
        *events,
    ]
    if flags["exit_reason"]:
        evs.append({"type": "position_closed", "ts": row.get("exitAt"), "reason": flags["exit_reason"]})
    row["events"] = evs
    row["timingIssues"] = acceptance_timing({**row, "path_bars": [{"ts": b["ts"]} for b in bars]})
    row["feeReconcileIssues"] = ledger.get("reconcileIssues") or []
    try:
        risk_pct = abs(float(row["entry"]) - float(row["stop_loss"])) / float(row["entry"]) * 100.0
        row["riskPctPrice"] = risk_pct
        row["mfePct"] = state.mfe_r * risk_pct
        row["maePct"] = state.mae_r * risk_pct
        if risk_pct:
            row["realized_r_net"] = float(row["pnlPct"]) / risk_pct
        else:
            row["realized_r_net"] = None
    except (TypeError, ValueError, ZeroDivisionError):
        row["realized_r_net"] = None
    return row
