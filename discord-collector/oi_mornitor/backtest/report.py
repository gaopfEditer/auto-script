"""回测汇总：按 kind / 周期 / 分组统计事件数、胜率、平均 R、最大回撤。"""
from __future__ import annotations

from collections import defaultdict
from typing import Any


def _max_dd(pnls: list[float]) -> float:
    eq = 0.0
    peak = 0.0
    dd = 0.0
    for x in pnls:
        eq += x
        peak = max(peak, eq)
        dd = min(dd, eq - peak)
    return dd


def summarize_trades(trades: list[dict[str, Any]]) -> dict[str, Any]:
    if not trades:
        return {
            "n": 0,
            "win_rate": 0.0,
            "avg_r": 0.0,
            "avg_pnl_pct": 0.0,
            "max_dd": 0.0,
        }
    wins = sum(1 for t in trades if float(t.get("pnl_r") or 0) > 0)
    pnls = [float(t.get("pnl_pct") or 0) for t in trades]
    rs = [float(t.get("pnl_r") or 0) for t in trades]
    return {
        "n": len(trades),
        "win_rate": wins / len(trades) * 100.0,
        "avg_r": sum(rs) / len(rs),
        "avg_pnl_pct": sum(pnls) / len(pnls),
        "max_dd": _max_dd(pnls),
    }


def group_tables(all_trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for t in all_trades:
        buckets[(str(t.get("kind") or ""), str(t.get("tf") or ""), str(t.get("group_tag") or "plain"))].append(t)
    rows: list[dict[str, Any]] = []
    for (kind, tf, group), items in sorted(buckets.items()):
        stat = summarize_trades(items)
        rows.append({"kind": kind, "tf": tf, "group": group, **stat})
    return rows


def score_buckets(trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
    bins = [(0, 40, "0-40"), (40, 50, "40-50"), (50, 65, "50-65"), (65, 101, "65+")]
    out: list[dict[str, Any]] = []
    for lo, hi, label in bins:
        items = [t for t in trades if lo <= float(t.get("score_tf") or 0) < hi]
        out.append({"bucket": label, **summarize_trades(items)})
    return out


def markdown_table(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "_无样本_"
    cols = list(rows[0].keys())
    lines = [
        "| " + " | ".join(cols) + " |",
        "| " + " | ".join("---" for _ in cols) + " |",
    ]
    for r in rows:
        cells = []
        for c in cols:
            v = r[c]
            if isinstance(v, float):
                cells.append(f"{v:.2f}")
            else:
                cells.append(str(v))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)
