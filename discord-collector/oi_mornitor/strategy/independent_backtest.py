"""把三个独立策略的候选单送入同一套结算（自有 SL/TP/超时），产出可诊断明细。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.pattern_settle import settle_signal_batch
from oi_mornitor.pattern_settle_profile import SettlePlan
from oi_mornitor.strategy.decision_layer import (
    collect_independent_signals,
    combined_equity_disclaimer,
    dedupe_overlapping_trades,
)
from oi_mornitor.trade_diagnostics import summarize_diagnostics


def _plan_from_trade(t: dict[str, Any], *, verify_delay_ms: int) -> SettlePlan:
    entry = float(t["entry"])
    sl = float(t["slPrice"])
    tp1 = float(t.get("tp1Price") or entry)
    tp2 = float(t.get("tp2Price") or tp1)
    weights = tuple(t.get("batchWeights") or (0.30, 0.30, 0.40))
    if len(weights) < 3:
        weights = (weights + (0.0, 0.0, 0.0))[:3]
    risk = max(abs(entry - sl), entry * 0.001)
    tp1_r = abs(entry - tp1) / risk if risk else 1.5
    tp2_r = abs(entry - tp2) / risk if risk else 3.0
    return SettlePlan(
        profile_id=str(t.get("strategy") or "independent"),
        sl_price=sl,
        tp1_price=tp1,
        tp2_price=tp2,
        batch_weights=(float(weights[0]), float(weights[1]), float(weights[2])),
        runner_trail_pct=7.0 if weights[2] else 0.0,
        verify_delay_ms=verify_delay_ms,
        risk_r=risk,
        tp1_r=tp1_r,
        tp2_r=tp2_r,
    )


def _bars_from_df(df, start_ms: int | None = None) -> list[dict[str, float]]:
    out: list[dict[str, float]] = []
    if df is None or len(df) == 0:
        return out
    ts_col = "open_time" if "open_time" in df.columns else ("ts" if "ts" in df.columns else None)
    for i in range(len(df)):
        row = df.iloc[i]
        ts = int(row[ts_col]) if ts_col else i
        if start_ms is not None and ts < start_ms - 60_000:
            continue
        out.append({
            "ts": ts,
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
        })
    return out


def settle_independent_trade(
    trade: dict[str, Any],
    bars: list[dict[str, float]],
    *,
    fee_pct_per_side: float = 0.06,
    slippage_pct_per_side: float = 0.03,
    bar_ms: int = 3_600_000,
) -> dict[str, Any]:
    entry = float(trade["entry"])
    side = str(trade.get("side") or "bull")
    timeout = int(trade.get("timeoutBars") or 24)
    # 入场按下一根开盘：signal_at 取入场柱开盘
    if trade.get("signalAt"):
        signal_at = int(trade["signalAt"])
    elif "open_time" in trade:
        signal_at = int(trade["open_time"])
    else:
        # 用第一根 >= 0 的 bar；调用方应填 signalAt
        signal_at = int(bars[0]["ts"]) if bars else 0
    verify_ms = timeout * bar_ms
    plan = _plan_from_trade(trade, verify_delay_ms=verify_ms)
    settled = settle_signal_batch(
        side=side,
        entry=entry,
        symbol=str(trade.get("symbol") or ""),
        signal_at_ms=signal_at,
        bars=bars,
        plan=plan,
        verify_delay_ms=verify_ms,
        now_ms=signal_at + verify_ms,
        fee_pct_per_side=fee_pct_per_side,
        slippage_pct_per_side=slippage_pct_per_side,
    )
    row = {**trade, **settled, "signalAt": signal_at}
    return row


def run_independent_on_frames(
    df_1h,
    df_4h=None,
    *,
    symbol: str = "",
    sl_profile: str = "structure",
    dispatch: bool = True,
    dedupe: bool = True,
    fee_pct_per_side: float = 0.06,
    slippage_pct_per_side: float = 0.03,
) -> dict[str, Any]:
    raw = collect_independent_signals(
        df_1h, df_4h, symbol=symbol, sl_profile=sl_profile, dispatch=dispatch
    )
    # 填 signalAt
    ts_col = "open_time" if df_1h is not None and "open_time" in df_1h.columns else None
    for t in raw:
        eb = int(t.get("entry_bar") or (int(t.get("bar_index") or 0) + 1))
        if ts_col is not None and eb < len(df_1h):
            t["signalAt"] = int(df_1h.iloc[eb][ts_col])
            t["entry"] = float(df_1h.iloc[eb]["open"])
    kept, dropped = (dedupe_overlapping_trades(raw) if dedupe else (raw, []))
    bars = _bars_from_df(df_1h)
    settled = [settle_independent_trade(t, bars, fee_pct_per_side=fee_pct_per_side, slippage_pct_per_side=slippage_pct_per_side) for t in kept]
    by_strategy: dict[str, list] = {}
    for r in settled:
        by_strategy.setdefault(str(r.get("strategy")), []).append(r)
    reports = {k: summarize_diagnostics(v) for k, v in by_strategy.items()}
    return {
        "items": settled,
        "droppedOverlap": dropped,
        "byStrategy": reports,
        "combined": summarize_diagnostics(settled),
        "combinedDisclaimer": combined_equity_disclaimer(),
        "validated": False,
    }
