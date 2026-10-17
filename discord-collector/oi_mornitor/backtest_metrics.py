"""回测扩展统计：R 倍数、成本后净值、分组维度。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.pattern_alert_stats import summarize


def _risk_r_from_item(it: dict[str, Any]) -> float | None:
    try:
        entry = float(it.get("entry") or 0)
    except (TypeError, ValueError):
        return None
    if entry <= 0:
        return None
    sl = it.get("slPrice")
    try:
        sl_f = float(sl) if sl is not None else None
    except (TypeError, ValueError):
        sl_f = None
    if sl_f is None or sl_f <= 0:
        return None
    side = str(it.get("side") or "").lower()
    if side in ("short", "bear"):
        return max(sl_f - entry, entry * 0.001)
    return max(entry - sl_f, entry * 0.001)


def _signed_r(it: dict[str, Any]) -> float | None:
    risk = _risk_r_from_item(it)
    entry = float(it.get("entry") or 0)
    if risk is None or entry <= 0:
        return None
    try:
        move = float(it.get("netMovePct") if it.get("netMovePct") is not None else it.get("movePct") or 0)
    except (TypeError, ValueError):
        return None
    return move / (risk / entry * 100.0)


def summarize_backtest_extended(items: list[dict[str, Any]]) -> dict[str, Any]:
    base = summarize(_pseudo_rows(items))
    settled = [
        it
        for it in items
        if str(it.get("outcome") or "") in ("take_profit", "stop_loss")
    ]
    rs: list[float] = []
    gross_wins = 0.0
    gross_losses = 0.0
    max_consec_loss = 0
    cur_loss = 0
    equity = 100.0
    peak = equity
    max_dd = 0.0
    for it in sorted(settled, key=lambda x: int(x.get("signalAt") or 0)):
        r = _signed_r(it)
        if r is not None:
            rs.append(r)
        try:
            pnl = float(it.get("pnlPct") or 0)
        except (TypeError, ValueError):
            pnl = 0.0
        if pnl > 0:
            gross_wins += pnl
            cur_loss = 0
        elif pnl < 0:
            gross_losses += abs(pnl)
            cur_loss += 1
            max_consec_loss = max(max_consec_loss, cur_loss)
        equity *= 1.0 + pnl / 100.0
        peak = max(peak, equity)
        dd = (peak - equity) / peak * 100.0 if peak > 0 else 0.0
        max_dd = max(max_dd, dd)
    expectancy = sum(rs) / len(rs) if rs else None
    pf = (gross_wins / gross_losses) if gross_losses > 1e-9 else None
    base["expectancyR"] = round(expectancy, 3) if expectancy is not None else None
    base["profitFactor"] = round(pf, 3) if pf is not None else None
    base["maxConsecutiveLosses"] = max_consec_loss
    base["maxDrawdownPct"] = round(max_dd, 3)
    return base


def _pseudo_rows(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "outcome": it.get("outcome"),
            "movePct": it.get("movePct"),
            "pnlPct": it.get("pnlPct"),
            "stepPct": it.get("stepPct") or 5.0,
            "tradeSymbol": it.get("symbol"),
            "symbol": it.get("symbol"),
            "observation_only": it.get("observation_only"),
        }
        for it in items
    ]


def summarize_by_dimensions(
    items: list[dict[str, Any]],
    *,
    key_fields: tuple[str, ...] = ("typeLabel", "interval", "mcapTier"),
) -> list[dict[str, Any]]:
    groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    for it in items:
        key = tuple(str(it.get(f) or "—") for f in key_fields)
        groups.setdefault(key, []).append(it)
    out: list[dict[str, Any]] = []
    for key, bucket in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        s = summarize_backtest_extended(bucket)
        row = {"count": len(bucket), **s}
        for i, f in enumerate(key_fields):
            row[f] = key[i]
        out.append(row)
    return out
