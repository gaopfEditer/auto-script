"""独立于价格变动百分比合计的账户权益、回撤与 R 统计。"""
from __future__ import annotations

from typing import Any


def build_equity_curve(
    trades: list[dict[str, Any]],
    *,
    starting_equity: float,
) -> dict[str, Any]:
    """按成交时间顺序累加逐笔净美元盈亏。仓位仍按传入的起始权益计，不在途中改风险口径。"""
    settled = [
        t for t in trades
        if not t.get("skipped") and t.get("pnlUsdt") is not None
    ]
    settled = sorted(settled, key=lambda t: (int(t.get("exitAt") or t.get("entryAt") or 0), str(t.get("symbol") or "")))
    equity = float(starting_equity)
    peak = equity
    max_dd = 0.0
    max_dd_pct = 0.0
    points: list[dict[str, Any]] = [{
        "ts": None,
        "equity": round(equity, 6),
        "pnlUsdt": 0.0,
        "drawdownUsdt": 0.0,
        "drawdownPct": 0.0,
        "symbol": None,
    }]
    rs: list[float] = []
    for t in settled:
        pnl = float(t["pnlUsdt"])
        equity += pnl
        peak = max(peak, equity)
        dd = peak - equity
        dd_pct = (dd / peak * 100.0) if peak else 0.0
        max_dd = max(max_dd, dd)
        max_dd_pct = max(max_dd_pct, dd_pct)
        t["equityAfter"] = round(equity, 6)
        t["equityPnlUsdt"] = pnl
        rnet = t.get("realized_r_net")
        if rnet is not None:
            try:
                rs.append(float(rnet))
            except (TypeError, ValueError):
                pass
        elif t.get("realized_r") is not None:
            rs.append(float(t["realized_r"]))
        points.append({
            "ts": t.get("exitAt") or t.get("entryAt"),
            "symbol": t.get("symbol"),
            "setup": t.get("setup"),
            "equity": round(equity, 6),
            "pnlUsdt": round(pnl, 6),
            "drawdownUsdt": round(dd, 6),
            "drawdownPct": round(dd_pct, 6),
        })
    net = equity - float(starting_equity)
    net_pct = (net / starting_equity * 100.0) if starting_equity else 0.0
    wins = [x for x in rs if x > 0]
    losses = [x for x in rs if x < 0]
    gw, gl = sum(wins), abs(sum(losses))
    pf_r = (gw / gl) if gl > 0 else None
    exp_r = (sum(rs) / len(rs)) if rs else None
    return {
        "startingEquity": starting_equity,
        "endingEquity": round(equity, 6),
        "netPnlUsdt": round(net, 6),
        "netReturnPct": round(net_pct, 6),
        "maxDrawdownUsdt": round(max_dd, 6),
        "maxDrawdownPct": round(max_dd_pct, 6),
        "n": len(settled),
        "expectancyR": round(exp_r, 6) if exp_r is not None else None,
        "profitFactorR": round(pf_r, 4) if pf_r is not None else None,
        "avgWinR": round(sum(wins) / len(wins), 6) if wins else None,
        "avgLossR": round(sum(losses) / len(losses), 6) if losses else None,
        "curve": points,
        "sizingNote": "仓位按起始权益与止损距离计算；本权益曲线只累加已实现净盈亏，不把价格变动百分比相加当作净值。",
    }
