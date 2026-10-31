#!/usr/bin/env python3
"""短线 DCA 回测 CLI：Mode A NLV翻转 / B TD9只做多 / C 共振计分。"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description="短线 DCA 回测（TD9/Vegas/形态/NLV）")
    parser.add_argument("--universe", default="majors", help="majors|t1|t2|t3|all_tiers")
    parser.add_argument("--symbols", default="", help="逗号分隔；空=按 universe")
    parser.add_argument("--interval", default="1h")
    parser.add_argument("--mode", default="nlv_flip", help="nlv_flip|td9_long|confluence 或 a|b|c")
    parser.add_argument("--exit-plan", default="scaled", help="Mode A: fixed_2r|fixed_3r|scaled")
    parser.add_argument("--leverage", type=float, default=None)
    parser.add_argument("--limit-bars", type=int, default=0)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
    )

    from oi_mornitor.backtest.dca_pipeline import dca_options, run_dca_pipeline

    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()] or None
    print("options:", json.dumps(dca_options(), ensure_ascii=False)[:500], file=sys.stderr)
    res = run_dca_pipeline(
        symbols=symbols,
        interval=args.interval,
        universe=args.universe,
        mode=args.mode,
        leverage=args.leverage,
        limit_bars=args.limit_bars,
        exit_plan=args.exit_plan,
    )
    d = res.to_dict()
    summary = {
        "category": d.get("categoryLabel"),
        "mode": d.get("mode"),
        "modeLabel": d.get("modeLabel"),
        "universe": d.get("universe"),
        "exit_plan": d.get("exit_plan"),
        "interval": d.get("interval"),
        "symbols": d.get("symbols"),
        "item_count": d.get("item_count"),
        "summary": d.get("summary"),
        "confluenceStats": d.get("confluenceStats"),
        "by_kind": {
            k: {"count": v.get("count"), "summary": v.get("summary")}
            for k, v in (d.get("by_kind") or {}).items()
        },
        "elapsed_sec": d.get("elapsed_sec"),
        "out_dir": d.get("out_dir"),
        "pineSource": d.get("pineSource"),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
