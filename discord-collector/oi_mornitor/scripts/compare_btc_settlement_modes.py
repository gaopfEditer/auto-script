#!/usr/bin/env python3
"""输出 AI BTC 15m 结算对照表（composite trail vs protect）。

用法:
  cd discord-collector
  PYTHONPATH=. python3 oi_mornitor/scripts/compare_btc_settlement_modes.py
  PYTHONPATH=. python3 oi_mornitor/scripts/compare_btc_settlement_modes.py --fixture /path/to/trades.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from oi_mornitor.btc_1h_backtest import run_from_fixture
from oi_mornitor.strategy.tight_sl_15m import SETTLEMENT_LABELS


def _row(label: str, s: dict) -> str:
    wr = s.get("win_rate")
    tp_wr = s.get("tp_sl_settle_win_rate")
    return (
        f"| {label} | {s.get('count', 0)} | {s.get('wins', 0)}/{s.get('losses', 0)} | "
        f"{s.get('gross_pct_sum', 0):.2f} | {s.get('fee_pct_sum', 0):.2f} | {s.get('net_pct_sum', 0):.2f} | "
        f"{tp_wr if tp_wr is not None else '—'} | {s.get('expired_ratio', 0):.2f} | {s.get('avg_giveback_r', 0):.3f} |"
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", type=str, default=None, help="含 trades[] 的 JSON")
    ap.add_argument("--json", action="store_true", help="仅输出 JSON")
    args = ap.parse_args()
    payload = run_from_fixture(args.fixture)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    print(f"fixture: {payload.get('fixture')}")
    print(f"笔数: {payload.get('trade_count')}")
    h = payload.get("horizon") or {}
    print(
        f"horizon（不经 TP/SL）: +1h {h.get('h1_win_rate')} | +4h {h.get('h4_win_rate')} | +8h {h.get('h8_win_rate')}"
    )
    print()
    print("| 模式 | 笔数 | 盈/亏 | 毛% | 费% | 净% | SL/TP结算胜率 | 到期占比 | 均回吐R |")
    print("|------|------|-------|-----|-----|-----|---------------|----------|---------|")
    for mode, s in (payload.get("settlements") or {}).items():
        label = SETTLEMENT_LABELS.get(mode, mode)
        print(_row(label, s))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
