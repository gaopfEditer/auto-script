#!/usr/bin/env python3
"""Aggregate settled pattern_alert_stats by agentDecision.expectancyKey (read-only research)."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

_PKG = Path(__file__).resolve().parents[1]
if str(_PKG.parent) not in sys.path:
    sys.path.insert(0, str(_PKG.parent))

from oi_mornitor.expectancy_combo import aggregate_expectancy_from_stats, save_expectancy_table
from oi_mornitor.pattern_alert_stats import list_alert_stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print summary only")
    args = ap.parse_args()
    rows = list_alert_stats()
    payload = aggregate_expectancy_from_stats(rows)
    print(f"combos={len(payload.get('rows') or [])}")
    if not args.dry_run:
        path = save_expectancy_table(payload)
        print(f"wrote {path}")
    else:
        for r in (payload.get("rows") or [])[:20]:
            print(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
