#!/usr/bin/env python3
"""短线回测基础设施 V2 入口（第一阶段）。不改出场策略，不覆盖 V1 基准结果。

  PYTHONPATH=. oi_mornitor/venv/bin/python -u -m oi_mornitor.scripts.run_backtest_engine_v2 \
      --symbols BTCUSDT,ETHUSDT --start 2026-05-01 --end 2026-11-01 \
      --experiment E --fee 0.06 --slippage 0.03 \
      --out oi_mornitor/data/short_term_v2/phase1
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
    p = argparse.ArgumentParser(
        prog="python -m oi_mornitor.scripts.run_backtest_engine_v2",
        description="短线回测基础设施 V2（第一阶段：对齐、费用、已收盘 4H、字段与权益口径）",
    )
    p.add_argument("--symbols", default="", help="逗号分隔，如 BTCUSDT,ETHUSDT")
    p.add_argument("--universe", default="crypto_no_equity",
                   choices=("crypto_no_equity", "majors", "majors_sol", "btc_eth", "btc_eth_sol"))
    p.add_argument("--start", default=None, help="开始日期 YYYY-MM-DD（香港时区）或毫秒时间戳")
    p.add_argument("--end", default=None, help="结束日期 YYYY-MM-DD 或毫秒时间戳")
    p.add_argument("--experiment", default="E", choices=list("ABCDE"))
    p.add_argument("--fee", type=float, default=None, help="单边手续费 %%")
    p.add_argument("--slippage", type=float, default=None, help="单边滑点 %%")
    p.add_argument("--equity", type=float, default=10000.0)
    p.add_argument("--out", type=Path, default=None)
    p.add_argument("--limit-bars", type=int, default=0)
    args = p.parse_args(argv)

    from oi_mornitor.backtest_engine_v2.runner import run_backtest_engine_v2

    symbols = [s.strip().upper() for s in str(args.symbols).split(",") if s.strip()] or None
    merged = run_backtest_engine_v2(
        symbols=symbols,
        universe=args.universe,
        start_ms=_parse_ms(args.start),
        end_ms=_parse_ms(args.end),
        experiment=args.experiment,
        fee_pct=args.fee,
        slippage_pct=args.slippage,
        equity=args.equity,
        out_dir=args.out,
        limit_bars=args.limit_bars,
    )
    acc = merged.get("acceptance") or {}
    s = merged.get("summary") or {}
    print(json.dumps({
        "engine": "backtest_engine_v2",
        "itemCount": merged.get("itemCount"),
        "skippedCount": merged.get("skippedCount"),
        "netReturnPct": s.get("netReturnPct"),
        "maxDrawdownPct": s.get("maxDrawdownPct"),
        "expectancyR": s.get("expectancyR"),
        "profitFactorR": s.get("profitFactorR"),
        "winRate": s.get("winRate"),
        "priceMoveSumPct": s.get("priceMoveSumPct"),
        "tp1HitRate": s.get("tp1HitRate"),
        "tp2HitRate": s.get("tp2HitRate"),
        "initialSlHitRate": s.get("initialSlHitRate"),
        "exitReasons": s.get("exitReasons"),
        "acceptance": acc,
        "out": merged.get("out_dir"),
        "elapsed_sec": merged.get("elapsed_sec"),
    }, ensure_ascii=False, indent=2))
    return 0 if acc.get("passed") else 2


if __name__ == "__main__":
    sys.exit(main())
