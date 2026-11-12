#!/usr/bin/env python3
"""对本地 Parquet/CSV K 线跑三个独立策略（非标签）。

示例：
  python -m oi_mornitor.scripts.run_independent_strategies \\
      --symbol BTCUSDT --df1h path/1h.csv --df4h path/4h.csv -o indep_out
CSV 需含 open_time,open,high,low,close,volume（可选 oi）。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


def _load(path: Path) -> pd.DataFrame:
    if path.suffix.lower() in {".parquet", ".pq"}:
        return pd.read_parquet(path)
    return pd.read_csv(path)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="独立策略回测")
    p.add_argument("--symbol", default="BTCUSDT")
    p.add_argument("--df1h", type=Path, required=True)
    p.add_argument("--df4h", type=Path, default=None)
    p.add_argument("--sl-profile", default="structure", choices=("structure", "atr"))
    p.add_argument("--no-dispatch", action="store_true", help="三个策略都跑（仍会去重叠）")
    p.add_argument("-o", "--out", type=Path, default=Path("independent_out"))
    args = p.parse_args(argv)

    from oi_mornitor.strategy.independent_backtest import run_independent_on_frames
    from oi_mornitor.trade_diagnostics import auditor_report_text, export_trades

    df1 = _load(args.df1h)
    df4 = _load(args.df4h) if args.df4h else None
    result = run_independent_on_frames(
        df1,
        df4,
        symbol=args.symbol,
        sl_profile=args.sl_profile,
        dispatch=not args.no_dispatch,
    )
    args.out.mkdir(parents=True, exist_ok=True)
    export_trades(result["items"], dest_dir=args.out, stem="independent_trades")
    (args.out / "independent_summary.json").write_text(
        json.dumps({k: v for k, v in result.items() if k != "items"}, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    print(auditor_report_text(result["combined"]))
    print(result["combinedDisclaimer"])
    print("byStrategy:", json.dumps(result["byStrategy"], ensure_ascii=False, indent=2, default=str)[:2000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
