#!/usr/bin/env python3
"""公开数据逐根回测：现有形态 + 新模块 + 随机对照。"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from oi_mornitor.backtest.replay import replay_symbol_tf, resonate_from_scores
from oi_mornitor.backtest.report import group_tables, markdown_table, score_buckets, summarize_trades
from oi_mornitor.backtest.vision import load_history
from oi_mornitor.signal_log import insert_outcome, insert_signal


DEFAULT_SYMBOLS = "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT"
DEFAULT_TFS = "15m,1h,4h"


def _parse_date(s: str) -> date:
    y, m, d = (int(x) for x in s.split("-"))
    return date(y, m, d)


def main() -> int:
    parser = argparse.ArgumentParser(description="OI 信号逐根回测（公开数据，无密钥）")
    parser.add_argument("--symbols", default=DEFAULT_SYMBOLS)
    parser.add_argument("--tfs", default=DEFAULT_TFS)
    parser.add_argument("--start", default="2026-07-01")
    parser.add_argument("--end", default="2026-10-01")
    parser.add_argument("--out", default="")
    parser.add_argument("--log-db", default="")
    args = parser.parse_args()

    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    tfs = [s.strip() for s in args.tfs.split(",") if s.strip()]
    start = _parse_date(args.start)
    end = _parse_date(args.end)

    all_trades: list[dict] = []
    random_trades: list[dict] = []
    scores_by_sym: dict[str, dict[str, list]] = {}
    sources: dict[str, str] = {}

    for sym in symbols:
        scores_by_sym[sym] = {}
        for tf in list(tfs) + ["1d"]:
            klines, src = load_history(sym, tf, start, end)
            sources[f"{sym}:{tf}"] = src
            print(f"加载 {sym} {tf} n={len(klines)} src={src}", file=sys.stderr)
            result = replay_symbol_tf(klines, symbol=sym, tf=tf, exchange=src)
            scores_by_sym[sym][tf] = result["bar_scores"]
            if tf == "1d":
                continue
            all_trades.extend(result["trades"])
            random_trades.extend(result["random_trades"])
            if args.log_db:
                for tr in result["trades"]:
                    sid = insert_signal(
                        {
                            "symbol": sym,
                            "exchange": src or "binance_um",
                            "tf": tf,
                            "bar_open_ts": tr.get("bar_close_ts") or 0,
                            "bar_close_ts": tr.get("bar_close_ts") or 0,
                            "side": tr.get("side"),
                            "family": tr.get("family"),
                            "kind": tr.get("kind"),
                            "price_close": tr.get("entry"),
                            "score_tf": tr.get("score_tf"),
                            "tags": {"group": tr.get("group_tag")},
                        },
                        db_path=args.log_db,
                    )
                    if sid:
                        insert_outcome(sid, tr, db_path=args.log_db)

    # 日线过滤：把 1d 分数并入共振
    res_rows: list[dict] = []
    for sym, by_tf in scores_by_sym.items():
        res_rows.extend(resonate_from_scores(by_tf))

    kind_table = group_tables(all_trades)
    rand_stat = summarize_trades(random_trades)
    real_stat = summarize_trades(all_trades)
    v_oi = summarize_trades([t for t in all_trades if t.get("group_tag") == "v_oi"])
    plain = summarize_trades([t for t in all_trades if t.get("group_tag") == "plain"])
    buckets = score_buckets(all_trades)
    res_stat = summarize_trades(
        [
            {
                "pnl_r": 1 if (r.get("grade") == "A") else (-1 if r.get("grade") == "C" else 0),
                "pnl_pct": float(r.get("resonance_r") or 0),
                "kind": r.get("kind"),
                "tf": "res",
                "group_tag": r.get("grade"),
                "score_tf": r.get("resonance_r"),
            }
            for r in res_rows
            if r.get("reject_reason") is None
        ]
    )

    report = {
        "sources": sources,
        "overall": real_stat,
        "random": rand_stat,
        "group_v_oi": v_oi,
        "group_plain": plain,
        "by_kind_tf_group": kind_table,
        "score_buckets": buckets,
        "resonance_count": len(res_rows),
        "resonance_pass": res_stat,
    }

    md = [
        "# OI 信号回测结果",
        "",
        f"区间 {args.start} ~ {args.end}；品种 {', '.join(symbols)}；周期 {', '.join(tfs)}。",
        "",
        "## 总体 vs 随机入场",
        "",
        markdown_table(
            [
                {"set": "signals", **real_stat},
                {"set": "random", **rand_stat},
                {"set": "v_oi", **v_oi},
                {"set": "plain", **plain},
            ]
        ),
        "",
        "## 按分数分桶",
        "",
        markdown_table(buckets),
        "",
        "## 按 kind / 周期 / 分组",
        "",
        markdown_table(kind_table),
        "",
        "## 数据来源",
        "",
        "```json",
        json.dumps(sources, ensure_ascii=False, indent=2),
        "```",
        "",
    ]
    text = "\n".join(md)
    out_path = Path(args.out) if args.out else Path(__file__).resolve().parents[1] / "docs" / "signal-backtest.md"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8")
    json_path = out_path.with_suffix(".json")
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(text)
    print(f"\n已写入 {out_path} 与 {json_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
