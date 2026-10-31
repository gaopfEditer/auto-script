#!/usr/bin/env python3
"""NLV（新高/新低末端+放量）回测 CLI：5% SL / 20x，不推 TG。"""
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
    parser = argparse.ArgumentParser(description="NLV 回测（5% SL · 20x · closed-bar → next open）")
    parser.add_argument("--universe", default="majors", help="majors|t1|t2|t3|all_tiers")
    parser.add_argument("--symbols", default="", help="逗号分隔；空=按 universe")
    parser.add_argument("--interval", default="1h")
    parser.add_argument("--kinds", default="", help="rev_vol_buy,rev_vol_sell；空=全部")
    parser.add_argument("--stop", type=float, default=None, help="固定止损%%，默认 5")
    parser.add_argument("--leverage", type=float, default=None, help="报告杠杆，默认 20")
    parser.add_argument("--limit-bars", type=int, default=0)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
    )

    from oi_mornitor.backtest.nlv_pipeline import nlv_options, run_nlv_pipeline

    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()] or None
    kinds = [k.strip() for k in args.kinds.split(",") if k.strip()] or None
    print("options:", json.dumps(nlv_options(), ensure_ascii=False)[:400], file=sys.stderr)
    res = run_nlv_pipeline(
        symbols=symbols,
        interval=args.interval,
        universe=args.universe,
        sl_pct=args.stop,
        leverage=args.leverage,
        limit_bars=args.limit_bars,
        kinds=kinds,
    )
    d = res.to_dict()
    summary = {
        "category": d.get("categoryLabel"),
        "universe": d.get("universe"),
        "interval": d.get("interval"),
        "symbols": d.get("symbols"),
        "item_count": d.get("item_count"),
        "summary": d.get("summary"),
        "leverage": d.get("leverage"),
        "by_kind": {k: {"count": v.get("count"), "summary": v.get("summary")} for k, v in (d.get("by_kind") or {}).items()},
        "elapsed_sec": d.get("elapsed_sec"),
        "out_dir": d.get("out_dir"),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
