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
