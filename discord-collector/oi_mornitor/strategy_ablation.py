"""阶段 2：单策略消融。不增加新指标，只测试过滤条件对亏损交易的贡献。

过滤假设待验证，不是已证明有效的规则。
"""
from __future__ import annotations

import itertools
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable, Iterable

from oi_mornitor.pattern_pause import PAUSED_BOTTOM_KINDS, is_paused_kind
from oi_mornitor.trade_diagnostics import summarize_diagnostics
from oi_mornitor.trade_leverage import audit_assumptions

# 具名过滤（可组合）
FILTER_DROP_DOUBLE_BOTTOM = "drop_double_bottom"
FILTER_COMPLETE_LIQUIDITY = "complete_liquidity_only"
FILTER_HTF_ALIGNED = "htf_aligned"
FILTER_4H_DIRECTION = "htf_4h_direction"
FILTER_OI = "oi_filter"


def _kind(r: dict[str, Any]) -> str:
    return str(r.get("kind") or r.get("signal_kind") or "").strip()


def _side(r: dict[str, Any]) -> str:
    s = str(r.get("side") or "").lower()
    if s in ("bull", "long"):
        return "long"
    if s in ("bear", "short"):
        return "short"
    return s


def _regime(r: dict[str, Any], key: str = "regime4h") -> str:
    v = r.get(key) or r.get("regime_4h") or r.get("regime4H")
    if isinstance(v, dict):
        return str(v.get("label") or "")
    return str(v or "")


def _oi_status(r: dict[str, Any]) -> str:
    v = r.get("oiStatus") or r.get("oi_status") or r.get("oiChange")
    if v is None and r.get("oi_unavailable"):
        return "oi_unavailable"
    if v is None and "oi" not in r and r.get("oiChange") is None:
        return "oi_unavailable"
    return str(v or "unknown")


def passes_drop_double_bottom(r: dict[str, Any]) -> bool:
    return _kind(r) not in PAUSED_BOTTOM_KINDS and "二次探底" not in str(r.get("typeLabel") or r.get("type_label") or "")


def passes_complete_liquidity(r: dict[str, Any]) -> bool:
    """只保留完整流动性扫荡（sweep+reclaim）。非 sweep 信号原样通过。"""
    k = _kind(r)
    if k not in ("liquidity_sweep", "liquidity_reversal_strict", "liquidity_reversal"):
        return True
    if r.get("complete") or r.get("sweep_reclaim_choch"):
        return True
    flags = r.get("liquidityFlags") or (r.get("opportunity") or {}).get("feature_flags") or {}
    if isinstance(flags, dict) and flags.get("sweep") and flags.get("reclaim"):
        return True
    # 旧结构信号 liquidity_sweep 本身已要求收回前高之下，视为有 reclaim；无 CHoCH 标记时仍算「完整掠夺形态」的弱代理
    if k == "liquidity_sweep" and r.get("defense"):
        return True
    return False


def passes_htf_aligned(r: dict[str, Any]) -> bool:
    flags = (r.get("opportunity") or {}).get("feature_flags") if isinstance(r.get("opportunity"), dict) else {}
    if isinstance(flags, dict) and flags.get("htf_aligned") is not None:
        return bool(flags.get("htf_aligned"))
    if r.get("htfAligned") is not None:
        return bool(r.get("htfAligned"))
    r4 = _regime(r, "regime4h")
    side = _side(r)
    if not r4 or r4 in ("unknown", ""):
        r["htfFilter"] = "htf_unavailable"
        return True  # 无 4h 数据时不静默丢弃，记 unavailable
    if side == "long":
        return r4 == "trend_up"
    if side == "short":
        return r4 == "trend_down"
    return False


def passes_4h_direction(r: dict[str, Any]) -> bool:
    """4h 方向过滤：与 HTF 对齐类似，但对底部做多在 4h 下跌时明确拒绝（假设闸）。"""
    from oi_mornitor.pattern_pause import bottom_long_forbidden_by_4h_downtrend

    r4 = _regime(r, "regime4h")
    if not r4:
        r["htfFilter"] = "htf_unavailable"
        return True
    if _side(r) == "long" and (
        _kind(r) in PAUSED_BOTTOM_KINDS or "二次探底" in str(r.get("typeLabel") or "")
    ):
        if bottom_long_forbidden_by_4h_downtrend(r4):
            return False
    return passes_htf_aligned(r)


def passes_oi_filter(r: dict[str, Any]) -> bool:
    st = _oi_status(r)
    if st in ("oi_unavailable", "unknown", ""):
        r["oiFilter"] = "oi_unavailable"
        return True
    if st == "adverse":
        return False
    return True


FILTERS: dict[str, Callable[[dict[str, Any]], bool]] = {
    FILTER_DROP_DOUBLE_BOTTOM: passes_drop_double_bottom,
    FILTER_COMPLETE_LIQUIDITY: passes_complete_liquidity,
    FILTER_HTF_ALIGNED: passes_htf_aligned,
    FILTER_4H_DIRECTION: passes_4h_direction,
    FILTER_OI: passes_oi_filter,
}

FILTER_LABELS = {
    FILTER_DROP_DOUBLE_BOTTOM: "删除底部二次探底",
    FILTER_COMPLETE_LIQUIDITY: "只保留完整流动性扫荡",
    FILTER_HTF_ALIGNED: "只保留 HTF 方向一致",
    FILTER_4H_DIRECTION: "4h 方向过滤",
    FILTER_OI: "OI 过滤（无数据则 oi_unavailable 放行）",
}


def apply_filters(rows: Iterable[dict[str, Any]], names: Iterable[str]) -> list[dict[str, Any]]:
    fns = [FILTERS[n] for n in names if n in FILTERS]
    out: list[dict[str, Any]] = []
    for r in rows:
        if all(fn(r) for fn in fns):
            out.append(r)
    return out


def _metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    settled = [
        r
        for r in rows
        if str(r.get("outcome") or "") in ("take_profit", "stop_loss", "flat")
    ]
    s = summarize_diagnostics(settled)
    pnls = []
    for r in settled:
        try:
            if r.get("pnlPct") is not None:
                pnls.append(float(r["pnlPct"]))
        except (TypeError, ValueError):
            pass
    losses = [r for r in settled if str(r.get("outcome")) == "stop_loss" or (r.get("pnlPct") is not None and float(r["pnlPct"]) < 0)]
    return {
        "n": s.get("n", len(settled)),
        "expectancy": s.get("expectancy"),
        "profitFactor": s.get("profitFactor"),
        "payoffRatio": s.get("payoffRatio"),
        "avgWin": s.get("avgWin"),
        "avgLoss": s.get("avgLoss"),
        "tp1HitRate": s.get("tp1HitRate"),
        "tp2HitRate": s.get("tp2HitRate"),
        "liquidationCount": s.get("liquidationCount"),
        "losingTrades": len(losses),
        "totalPnl": round(sum(pnls), 4) if pnls else 0.0,
        "winRate": (lambda w, n: round(w / n, 4) if n else None)(
            sum(1 for r in settled if str(r.get("outcome")) == "take_profit"),
            len([r for r in settled if str(r.get("outcome")) in ("take_profit", "stop_loss")]),
        ),
    }


def contribution_report(
    rows: list[dict[str, Any]],
    *,
    filter_names: list[str] | None = None,
    combinations: bool = True,
) -> dict[str, Any]:
    """比较各过滤及组合：剔除了多少笔、其中多少亏损、期望值/PF 如何变。"""
    names = list(filter_names or FILTERS.keys())
    baseline = _metrics(list(rows))
    experiments: list[dict[str, Any]] = [
        {"id": "baseline", "label": "全量（无额外过滤）", "filters": [], **baseline}
    ]
    combos: list[tuple[str, ...]] = [(n,) for n in names]
    if combinations and len(names) > 1:
        for k in range(2, len(names) + 1):
            combos.extend(itertools.combinations(names, k))
    # 限制组合数量，避免爆炸
    if len(combos) > 40:
        combos = combos[:40]

    base_loss_keys = {_trade_key(r) for r in rows if _is_loss(r)}
    for combo in combos:
        kept = apply_filters(rows, combo)
        m = _metrics(kept)
        dropped = [r for r in rows if _trade_key(r) not in {_trade_key(x) for x in kept}]
        dropped_loss = sum(1 for r in dropped if _is_loss(r))
        dropped_win = sum(1 for r in dropped if str(r.get("outcome")) == "take_profit")
        experiments.append({
            "id": "+".join(combo),
            "label": " + ".join(FILTER_LABELS.get(x, x) for x in combo),
            "filters": list(combo),
            "dropped": len(dropped),
            "droppedLosing": dropped_loss,
            "droppedWinning": dropped_win,
            "losingRemovedShare": (round(dropped_loss / len(base_loss_keys), 4) if base_loss_keys else None),
            **m,
        })
    return {
        "baseline": baseline,
        "experiments": experiments,
        "note": "重点是哪些条件排除了亏损交易，不是寻找收益最高的参数。过滤为假设，须样本外验证。",
        "assumptions": audit_assumptions(),
        "oiUnavailableCount": sum(1 for r in rows if _oi_status(r) == "oi_unavailable"),
    }


def _trade_key(r: dict[str, Any]) -> str:
    return "|".join(
        str(r.get(k) or "")
        for k in ("symbol", "signalAt", "kind", "side", "interval")
    )


def _is_loss(r: dict[str, Any]) -> bool:
    if str(r.get("outcome")) == "stop_loss":
        return True
    try:
        return r.get("pnlPct") is not None and float(r["pnlPct"]) < 0
    except (TypeError, ValueError):
        return False


def load_trades_payload(path: Path) -> list[dict[str, Any]]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]
    if isinstance(raw, dict):
        for k in ("items", "trades", "rows"):
            v = raw.get(k)
            if isinstance(v, list):
                return [x for x in v if isinstance(x, dict)]
    return []


def write_report(report: dict[str, Any], dest: Path) -> Path:
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return dest
