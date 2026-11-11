#!/usr/bin/env python3
"""Read-only research export: attach agentDecision to stats rows (JSONL on stdout).

See docs/signals-and-decision-logic.md §10.4.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

_PKG = Path(__file__).resolve().parents[1]
if str(_PKG.parent) not in sys.path:
    sys.path.insert(0, str(_PKG.parent))

os.environ.setdefault("OI_AGENT_DECISION_ENABLED", "1")

from oi_mornitor.agent_decision import attach_agent_decision, strip_pa_klines_from_alert
from oi_mornitor.pattern_alert_stats import is_headline_win_rate_excluded, list_alert_stats


def fetch_klines(base: str, symbol: str, interval: str, end_ms: int, limit: int = 200) -> list:
    q = urllib.parse.urlencode({"symbol": symbol, "interval": interval, "limit": limit, "endTime": end_ms})
    with urllib.request.urlopen(f"{base.rstrip('/')}/api/patterns/klines?{q}", timeout=120) as resp:
        data = json.loads(resp.read().decode())
    if not data.get("ok"):
        return []
    return data.get("klines") or data.get("rows") or []


def main() -> int:
    ap = argparse.ArgumentParser(description="Export pattern_alert_stats rows with agentDecision (research only).")
    ap.add_argument("--oi-base", default="http://127.0.0.1:8765")
    ap.add_argument("--start-ms", type=int, default=0)
    ap.add_argument("--end-ms", type=int, default=2**63 - 1)
    ap.add_argument("--limit", type=int, default=0, help="max rows (0 = all in range)")
    args = ap.parse_args()
    n = 0
    for row in list_alert_stats():
        if is_headline_win_rate_excluded(row):
            continue
        sat = int(row.get("signalAt") or 0)
        if sat < args.start_ms or sat > args.end_ms:
            continue
        sym = str(row.get("tradeSymbol") or row.get("symbol") or "")
        iv = str(row.get("interval") or "15m")
        if not sym:
            continue
        kl = fetch_klines(args.oi_base, sym, iv, sat + 3_600_000)
        alert = dict(row)
        dec = attach_agent_decision(alert, klines=kl)
        strip_pa_klines_from_alert(alert)
        out = {
            **{k: row[k] for k in ("key", "signalAt", "outcome", "movePct", "pnlPct", "maxProfitPct") if k in row},
            "agentDecision": dec,
        }
        print(json.dumps(out, ensure_ascii=False))
        n += 1
        if args.limit and n >= args.limit:
            break
    print(f"# exported={n}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
