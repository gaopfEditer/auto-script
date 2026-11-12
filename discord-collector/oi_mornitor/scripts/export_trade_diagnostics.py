#!/usr/bin/env python3
"""从结构回测 job JSON 或 trades JSON 导出 CSV/JSON 诊断 + 杠杆审计报告。

用法（在 discord-collector 目录，PYTHONPATH=.）：
  python -m oi_mornitor.scripts.export_trade_diagnostics path/to/job.json -o ./diag_out
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="导出交易诊断明细与审计报告")
    p.add_argument("input", type=Path, help="结构回测 job.json 或 {items:[...]} / 列表")
    p.add_argument("-o", "--out", type=Path, default=Path("trade_diagnostics_out"))
    p.add_argument("--stem", default="trade_diagnostics")
    args = p.parse_args(argv)

    raw = json.loads(args.input.read_text(encoding="utf-8"))
    if isinstance(raw, list):
        rows = raw
    elif isinstance(raw, dict):
        rows = raw.get("items") or raw.get("trades") or raw.get("rows") or []
    else:
        print("无法解析输入", file=sys.stderr)
        return 2
    from oi_mornitor.trade_diagnostics import auditor_report_text, export_trades, summarize_diagnostics

    paths = export_trades(list(rows), dest_dir=args.out, stem=args.stem)
    summary = summarize_diagnostics(list(rows))
    print(auditor_report_text(summary))
    for k, v in paths.items():
        print(f"{k}: {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
