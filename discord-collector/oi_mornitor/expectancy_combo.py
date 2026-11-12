"""Conditional expectancy keys + aggregation from settled pattern_alert_stats."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from oi_mornitor.env_parse import env_int

EXPECTANCY_MIN_N = env_int("OI_AGENT_DECISION_EXPECTANCY_MIN_N", 5, min_val=1, max_val=500)
_DATA = Path(__file__).resolve().parent / "data"
_TABLE_PATH = _DATA / "agent_decision_expectancy.json"


def build_expectancy_key(decision: dict[str, Any], alert: dict[str, Any]) -> str:
    """Bucket: mcap × decision groups × side × interval (for later table joins)."""
    mcap = str(alert.get("mcapTier") or alert.get("mcap_tier") or "t3").lower()
    side = str(alert.get("side") or "").lower() or "na"
    iv = str(alert.get("interval") or "").lower() or "na"
    grp = decision.get("primaryGroup") or "none"
    tags = decision.get("groups", {})
    b_tags = ",".join(sorted((tags.get("B") or {}).get("tags") or []))[:120]
    a_tags = ",".join(sorted((tags.get("A") or {}).get("tags") or []))[:80]
    return f"{mcap}|{grp}|{side}|{iv}|B:{b_tags}|A:{a_tags}"


def evidence_sufficient(sample_n: int, *, min_n: int | None = None) -> bool:
    return int(sample_n) >= int(min_n if min_n is not None else EXPECTANCY_MIN_N)


def aggregate_expectancy_from_stats(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Minimal hook: win/loss counts per expectancyKey on settled rows."""
    buckets: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        dec = r.get("agentDecision")
        if not isinstance(dec, dict):
            continue
        out = str(r.get("outcome") or "").lower()
        if out not in ("win", "loss"):
            continue
        key = str(dec.get("expectancyKey") or build_expectancy_key(dec, r))
        buckets[key].append(1.0 if out == "win" else 0.0)
    table: list[dict[str, Any]] = []
    for key, wins in sorted(buckets.items()):
        n = len(wins)
        wr = sum(wins) / n if n else None
        table.append(
            {
                "comboKey": key,
                "n": n,
                "winRate": round(wr, 4) if wr is not None else None,
                "evidenceSufficient": evidence_sufficient(n),
            }
        )
    return {"generatedAt": __import__("time").time(), "rows": table}


def save_expectancy_table(payload: dict[str, Any]) -> Path:
    _DATA.mkdir(parents=True, exist_ok=True)
    _TABLE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return _TABLE_PATH


def build_feature_combo_key(flags: dict) -> str:
    """机会评估特征组合键，供消融与条件期望表使用。"""
    from oi_mornitor.opportunity_score import feature_combo_key

    return feature_combo_key(flags or {})


def aggregate_expectancy_from_feature_flags(rows: list[dict]) -> dict:
    """按 featureFlags / opportunity.feature_flags 聚合期望值与利润因子（非胜率权重）。"""
    from collections import defaultdict

    buckets: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        flags = r.get("featureFlags")
        if not isinstance(flags, dict):
            opp = r.get("opportunity")
            flags = (opp or {}).get("feature_flags") if isinstance(opp, dict) else None
        if not isinstance(flags, dict):
            key = str(r.get("expectancyKey") or r.get("comboKey") or "")
            if not key:
                continue
        else:
            key = build_feature_combo_key(flags)
        try:
            pnl = float(r["pnlPct"]) if r.get("pnlPct") is not None else None
        except (TypeError, ValueError):
            pnl = None
        if pnl is None:
            out = str(r.get("outcome") or "").lower()
            if out not in ("take_profit", "stop_loss", "win", "loss"):
                continue
            pnl = 1.0 if out in ("take_profit", "win") else -1.0
        buckets[key].append(pnl)
    table = []
    for key, pnls in sorted(buckets.items()):
        n = len(pnls)
        wins = [x for x in pnls if x > 0]
        losses = [x for x in pnls if x < 0]
        gw, gl = sum(wins), abs(sum(losses))
        table.append({
            "comboKey": key,
            "n": n,
            "expectancy": round(sum(pnls) / n, 4) if n else None,
            "profitFactor": round(gw / gl, 4) if gl > 0 else None,
            "winRate": round(len(wins) / n, 4) if n else None,
            "evidenceSufficient": evidence_sufficient(n),
            "weightsAreTrained": False,
        })
    return {"generatedAt": __import__("time").time(), "rows": table, "note": "特征组合的条件期望；权重未经训练，不可当作胜率。"}
