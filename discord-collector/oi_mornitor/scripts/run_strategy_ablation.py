#!/usr/bin/env python3
"""阶段 2 消融：对已有结构回测/交易明细跑过滤贡献报告。

  python -m oi_mornitor.scripts.run_strategy_ablation path/to/trades.json -o ablation_report.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="过滤条件消融贡献报告")
    p.add_argument("input", type=Path)
    p.add_argument("-o", "--out", type=Path, default=Path("ablation_report.json"))
    p.add_argument("--no-combos", action="store_true", help="只跑单过滤，不跑组合")
    args = p.parse_args(argv)

    from oi_mornitor.strategy_ablation import contribution_report, load_trades_payload, write_report

    rows = load_trades_payload(args.input)
    if not rows:
        print("没有交易记录", file=sys.stderr)
        return 2
    report = contribution_report(rows, combinations=not args.no_combos)
    write_report(report, args.out)
    print(json.dumps({
        "baseline": report["baseline"],
        "nExperiments": len(report["experiments"]),
        "out": str(args.out),
        "note": report["note"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
