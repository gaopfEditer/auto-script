#!/usr/bin/env python3
"""短线策略 V1 回测入口。参数是研究起点，不是已验证盈利承诺。

在 discord-collector 目录、项目虚拟环境下：

  PYTHONPATH=. oi_mornitor/venv/bin/python -m oi_mornitor.scripts.run_short_term_strategy_v1 --help

  PYTHONPATH=. oi_mornitor/venv/bin/python -m oi_mornitor.scripts.run_short_term_strategy_v1 --dry-run

  PYTHONPATH=. oi_mornitor/venv/bin/python -m oi_mornitor.scripts.run_short_term_strategy_v1 \\
      --symbols BTCUSDT,ETHUSDT --start 2026-05-01 --end 2026-11-01 \\
      --experiment E --fee 0.06 --slippage 0.03 \\
      --out oi_mornitor/data/short_term_v1/my-run

实验 A–E 为同一引擎上的开关。默认宇宙为加密货币、不含美股代币。
二次探底默认暂停；射击之星（含连续走平）默认启用。
现货 K 线仅作永续价格代理。不要一次跑数月超大规模除非你自己要。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
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
                # 用户在 Asia/Hong_Kong；按本地朴素时间理解
                from zoneinfo import ZoneInfo

                dt = dt.replace(tzinfo=ZoneInfo("Asia/Hong_Kong"))
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    raise argparse.ArgumentTypeError(f"无法解析日期: {raw}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m oi_mornitor.scripts.run_short_term_strategy_v1",
        description="短线策略 V1 回测（研究框架，非盈利承诺）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            "  python -m oi_mornitor.scripts.run_short_term_strategy_v1 --dry-run\n"
            "  python -m oi_mornitor.scripts.run_short_term_strategy_v1 "
            "--symbols BTCUSDT,ETHUSDT --start 2026-05-01 --end 2026-11-01 --experiment E\n"
            "\n"
            "实验: A 形态+均线+Vegas; B +BTC环境; C +OI/资金费/清算; "
            "D +扫单收回/CVD/吸收; E 完整分档参数。\n"
            "结果默认写到 oi_mornitor/data/short_term_v1/<日期时间>/（summary.json + summary.md）。\n"
            "K 线是合约价格代理；二次探底默认暂停，射击之星默认启用。"
        ),
    )
    p.add_argument("--symbols", default="", help="逗号分隔，如 BTCUSDT,ETHUSDT。默认主流加密、不含美股代币")
    p.add_argument("--universe", default="crypto_no_equity",
                   choices=("crypto_no_equity", "majors", "majors_sol", "btc_eth", "btc_eth_sol"),
                   help="币种宇宙（默认加密、排除美股代币）")
    p.add_argument("--start", default=None, help="开始日期 YYYY-MM-DD（按香港时区）或毫秒时间戳")
    p.add_argument("--end", default=None, help="结束日期 YYYY-MM-DD 或毫秒时间戳")
    p.add_argument("--experiment", default="E", choices=list("ABCDE"), help="消融实验 A–E，默认完整 V1（E）")
    p.add_argument("--fee", type=float, default=None, help="单边手续费 %%（默认 OI_BT_FEE_PCT=0.06）")
    p.add_argument("--slippage", type=float, default=None, help="单边滑点 %%（默认 0.03；超过上限则未成交跳过）")
    p.add_argument("--equity", type=float, default=10000.0, help="账户权益 USDT，用于仓位换算（默认 10000）")
    p.add_argument("--out", type=Path, default=None, help="输出目录（默认 data/short_term_v1/<时间戳>/）")
    p.add_argument("--dry-run", action="store_true", help="用合成夹具跑通引擎，不读本地数月 K 线")
    p.add_argument("--limit-bars", type=int, default=0, help="每个品种最多使用末尾 N 根 15m（0=不限制）")
    args = p.parse_args(argv)

    from oi_mornitor.strategy.short_term_v1.runner import run_short_term_v1

    symbols = [s.strip().upper() for s in (args.symbols or "").split(",") if s.strip()] or None
    try:
        start_ms = _parse_ms(args.start)
        end_ms = _parse_ms(args.end)
    except argparse.ArgumentTypeError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    result = run_short_term_v1(
        symbols=symbols,
        universe=args.universe,
        start_ms=start_ms,
        end_ms=end_ms,
        experiment=args.experiment,
        fee_pct=args.fee,
        slippage_pct=args.slippage,
        equity=args.equity,
        out_dir=args.out,
        dry_run=bool(args.dry_run),
        limit_bars=int(args.limit_bars or 0),
    )
    summary = result.get("summary") or {}
    print(result.get("disclaimer") or "")
    print(json.dumps({
        "experiment": (result.get("experiment") or {}).get("id"),
        "dryRun": result.get("dryRun"),
        "symbols": result.get("symbols"),
        "itemCount": result.get("itemCount", len(result.get("items") or [])),
        "skippedCount": result.get("skippedCount"),
        "netPnlPct": summary.get("netPnlPct", summary.get("totalPnlPct")),
        "profitFactor": summary.get("profitFactor"),
        "expectancy": summary.get("expectancy"),
        "maxDrawdownPct": summary.get("maxDrawdownPct"),
        "out": result.get("out_dir"),
        "elapsed_sec": result.get("elapsed_sec"),
    }, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
