"""V2 摘要：正确映射出场字段，并同时给出价格%合计（对照）与账户权益口径。"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from oi_mornitor.backtest_engine_v2.equity import build_equity_curve


def _pf(wins: list[float], losses: list[float]) -> float | None:
    gw, gl = sum(x for x in wins if x > 0), abs(sum(x for x in losses if x < 0))
    if gl > 0:
        return round(gw / gl, 4)
    return None


def summarize_v2(rows: list[dict[str, Any]], *, starting_equity: float) -> dict[str, Any]:
    settled = [r for r in rows if not r.get("skipped") and r.get("pnlPct") is not None]
    n = len(settled)
    pnls = [float(r["pnlPct"]) for r in settled]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    usdt = [float(r["pnlUsdt"]) for r in settled if r.get("pnlUsdt") is not None]
    equity = build_equity_curve(settled, starting_equity=starting_equity)
    exit_reasons: dict[str, int] = {}
    for r in settled:
        k = str(r.get("exitReason") or r.get("exit_reason") or "unknown")
        exit_reasons[k] = exit_reasons.get(k, 0) + 1
    wr = (len(wins) / n) if n else None
    exp = (sum(pnls) / n) if n else None
    # 价格%合计的滚动回撤（仅对照，不是账户回撤）
    eq = 0.0
    peak = 0.0
    dd = 0.0
    for p in pnls:
        eq += p
        peak = max(peak, eq)
        dd = max(dd, peak - eq)

    def _rate(key: str) -> float | None:
        if not n:
            return None
        return round(sum(1 for r in settled if r.get(key)) / n, 4)

    return {
        "n": n,
        "nSettled": n,
        "total": n,
        "winRate": round(wr, 4) if wr is not None else None,
        "priceMoveSumPct": round(sum(pnls), 6) if pnls else 0.0,
        "priceMoveExpectancyPct": round(exp, 6) if exp is not None else None,
        "priceMoveProfitFactor": _pf(wins, losses),
        "priceMoveMaxDrawdownPct": round(dd, 6),
        "priceMoveSumNote": "逐笔价格净变动百分比之和，只作与 V1 对照，不是账户净值。",
        "netPnlUsdt": equity["netPnlUsdt"],
        "netReturnPct": equity["netReturnPct"],
        "endingEquity": equity["endingEquity"],
        "maxDrawdownUsdt": equity["maxDrawdownUsdt"],
        "maxDrawdownPct": equity["maxDrawdownPct"],
        "expectancyR": equity["expectancyR"],
        "profitFactorR": equity["profitFactorR"],
        "avgWinR": equity["avgWinR"],
        "avgLossR": equity["avgLossR"],
        "profitFactor": equity["profitFactorR"],
        "expectancy": equity["expectancyR"],
        "netPnlPct": equity["netReturnPct"],
        "tp1HitRate": _rate("tp1Hit"),
        "tp2HitRate": _rate("tp2Hit"),
        "runnerActivationRate": _rate("runnerActivated"),
        "initialSlHitRate": _rate("initialSlHit"),
        "exitReasons": exit_reasons,
        "timingIssueCount": sum(1 for r in settled if r.get("timingIssues")),
        "feeReconcileIssueCount": sum(1 for r in settled if r.get("feeReconcileIssues")),
        "equity": equity,
        "sumPnlUsdt": round(sum(usdt), 6) if usdt else 0.0,
    }


def breakdown_v2(rows: list[dict[str, Any]], key: str, *, starting_equity: float) -> dict[str, Any]:
    buckets: dict[str, list] = defaultdict(list)
    for r in rows:
        if r.get("skipped"):
            continue
        buckets[str(r.get(key) or "unknown")].append(r)
    return {k: summarize_v2(v, starting_equity=starting_equity) | {"n": len(v)} for k, v in buckets.items()}


def skip_counts(skipped: list[dict[str, Any]]) -> dict[str, Any]:
    by_reason: dict[str, int] = {}
    by_setup_reason: dict[str, int] = {}
    for r in skipped:
        reason = str(r.get("skip_reason") or r.get("skipReason") or "unknown")
        setup = str(r.get("setup") or r.get("kind") or "unknown")
        by_reason[reason] = by_reason.get(reason, 0) + 1
        key = f"{setup}|{reason}"
        by_setup_reason[key] = by_setup_reason.get(key, 0) + 1
    return {"n": len(skipped), "byReason": by_reason, "bySetupReason": by_setup_reason}
