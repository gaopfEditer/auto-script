#!/usr/bin/env python3
"""一键跑 A_pure_oi / B_oi_pattern / C_kol_pattern 三路对比回测。"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from oi_mornitor.backtest_three_way import discover_oi_history, run_three_way


def main() -> int:
    parser = argparse.ArgumentParser(description="OI 三路对比回测")
    parser.add_argument("--discover-only", action="store_true", help="仅盘点 OI/K 线，不跑回测")
    parser.add_argument("--skip-c", action="store_true", help="跳过 C_kol_pattern")
    parser.add_argument("--max-mentions", type=int, default=None, help="C 臂最多 mention 数（调试）")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
    )

    if args.discover_only:
        disc = discover_oi_history()
        print(json.dumps(disc, ensure_ascii=False, indent=2))
        return 0 if disc.get("status") == "ready" else 2

    result = run_three_way(skip_c=args.skip_c, max_mentions=args.max_mentions)
    # 控制台摘要
    print("=== 三路回测摘要 ===")
    print(f"params: fee={result['params']['fee_pct_per_side']}% slip={result['params']['slippage_pct_per_side']}%")
    print(f"kline_end: {result['params']['kline_coverage_end']}")
    print(f"allowlist: {result['params']['allowlist']} (临时)")
    for name, arm in result["arms"].items():
        if arm["status"] == "blocked":
            print(f"  {name}: BLOCKED — {arm.get('blocked_reason')}")
        elif arm["status"] == "empty":
            print(f"  {name}: EMPTY — {arm.get('blocked_reason') or '无信号'}")
        else:
            print(
                f"  {name}: signals={arm['signals']} settled={arm['settled']} "
                f"win_rate={arm['win_rate']} expectancy_pct={arm['expectancy_pct']} "
                f"expectancy_r={arm['expectancy_r']}"
            )
    print(f"summary: {result.get('summary_path')}")
    print(f"elapsed: {result.get('elapsed_sec')}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
