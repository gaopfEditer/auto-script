#!/usr/bin/env python3
"""短线策略 V2 回测入口（可与 V1 并行）。

  PYTHONPATH=. python -m oi_mornitor.scripts.run_short_term_strategy_v2 --dry-run
  PYTHONPATH=. python -m oi_mornitor.scripts.run_short_term_strategy_v2 --dry-run --parallel-v1
  PYTHONPATH=. python -m oi_mornitor.scripts.run_short_term_strategy_v2 \\
      --symbols BTCUSDT,ETHUSDT --start 2026-05-01 --end 2026-11-01 --parallel-v1
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path


def _parse_ms(raw: str | None) -> int | None:
    if not raw:
        return None
    s = str(raw).strip()
    if not s:
        return None
    if s.isdigit():
        v = int(s)
        return v * 1000 if v < 1e12 else v
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            dt = datetime.strptime(s, fmt)
            if dt.tzinfo is None:
                from zoneinfo import ZoneInfo

                dt = dt.replace(tzinfo=ZoneInfo("Asia/Hong_Kong"))
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    raise argparse.ArgumentTypeError(f"无法解析日期: {raw}")


def main(argv: list[str] | None = None) -> int:
    from oi_mornitor.strategy.short_term_v2.params import BATCH1_STRATEGIES, STRATEGY_IDS

    p = argparse.ArgumentParser(
        prog="python -m oi_mornitor.scripts.run_short_term_strategy_v2",
        description="短线策略 V2（独立于 V1；可选并行）",
    )
    p.add_argument("--symbols", default="", help="逗号分隔，如 BTCUSDT,ETHUSDT")
    p.add_argument("--universe", default="crypto_no_equity",
                   choices=("crypto_no_equity", "majors", "majors_sol", "btc_eth", "btc_eth_sol"))
    p.add_argument("--start", default=None)
    p.add_argument("--end", default=None)
    p.add_argument("--strategies", default=",".join(BATCH1_STRATEGIES),
                   help=f"逗号分隔策略编号，默认第一批。可选 {','.join(STRATEGY_IDS)}")
    p.add_argument("--include-batch2", action="store_true", help="附加第二批 stub 扫描")
    p.add_argument("--parallel-v1", action="store_true", help="同一数据上同步跑 V1 + V2")
    p.add_argument("--v1-experiment", default="E", choices=list("ABCDE"))
    p.add_argument("--fee", type=float, default=None)
    p.add_argument("--slippage", type=float, default=None)
    p.add_argument("--equity", type=float, default=10000.0)
    p.add_argument("--out", type=Path, default=None)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--limit-bars", type=int, default=0)
    p.add_argument(
        "--quality-gate",
        dest="quality_gate",
        action="store_true",
        default=True,
        help="入场需多周期共振 OR 评分≥min-score-tier（默认开）",
    )
    p.add_argument(
        "--no-quality-gate",
        dest="quality_gate",
        action="store_false",
        help="关闭质量闸（对比基线用）",
    )
    p.add_argument(
        "--min-score-tier",
        default="B",
        choices=("A", "B", "C", "D"),
        help="综合评分最低档，默认 B",
    )
    p.add_argument(
        "--gate-mode",
        default="and",
        choices=("and", "or"),
        help="and=15m+共振且评分达标（默认）；or=共振或评分",
    )
    args = p.parse_args(argv)

    from oi_mornitor.strategy.short_term_v2.runner import run_short_term_v2

    symbols = [s.strip().upper() for s in (args.symbols or "").split(",") if s.strip()] or None
    strategies = [s.strip().upper() for s in (args.strategies or "").split(",") if s.strip()]
    try:
        start_ms = _parse_ms(args.start)
        end_ms = _parse_ms(args.end)
    except argparse.ArgumentTypeError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    result = run_short_term_v2(
        symbols=symbols,
        universe=args.universe,
        start_ms=start_ms,
        end_ms=end_ms,
        strategies=strategies,
        include_batch2=args.include_batch2,
        fee_pct=args.fee,
        slippage_pct=args.slippage,
        out_dir=args.out,
        dry_run=args.dry_run,
        limit_bars=args.limit_bars,
        parallel_v1=args.parallel_v1,
        v1_experiment=args.v1_experiment,
        equity=args.equity,
        quality_gate=bool(args.quality_gate),
        min_score_tier=args.min_score_tier,
        gate_mode=args.gate_mode,
    )
    print(json.dumps({
        "out_dir": result.get("out_dir"),
        "counts": result.get("counts"),
        "stats": result.get("stats") or (result.get("v2") or {}).get("stats"),
        "elapsed_sec": result.get("elapsed_sec"),
        "dryRun": result.get("dryRun"),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
