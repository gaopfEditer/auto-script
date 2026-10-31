#!/usr/bin/env python3
"""Sequoia 回测 CLI：币圈 / 美股合约双轨道持久化流水线（不推 TG）。"""
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
    parser = argparse.ArgumentParser(
        description="Sequoia 回测（crypto 5%/20x · us_equity 5%/10x；接入胜率结算流水线）"
    )
    parser.add_argument(
        "--mode",
        choices=("pipeline", "fixed", "both"),
        default="pipeline",
        help="pipeline=5m结算; fixed=固定止损超时; both=流水线+固定矩阵",
    )
    parser.add_argument(
        "--track",
        "--asset-class",
        dest="track",
        default="crypto",
        choices=("crypto", "us_equity", "us", "both"),
        help="crypto | us_equity(us) | both（分两次跑并合并摘要）",
    )
    parser.add_argument("--symbols", default="", help="逗号分隔；空=该轨道默认宇宙")
    parser.add_argument("--interval", default="1h")
    parser.add_argument("--klines-dir", default="", help="backtest_klines 根（含 parquet/）")
    parser.add_argument("--strategies", default="", help="逗号分隔策略 ID；空=全部")
    parser.add_argument("--warmup", type=int, default=80)
    parser.add_argument(
        "--stop",
        type=float,
        default=None,
        help="固定止损%%；默认跟轨道（均为 5）",
    )
    parser.add_argument("--hold-bars", type=int, default=None)
    parser.add_argument("--leverage", type=float, default=None, help="报告杠杆；默认 crypto=20 us=10")
    parser.add_argument("--margin-cny", type=float, default=None)
    parser.add_argument("--limit-bars", type=int, default=0)
    parser.add_argument("--json-out", default="", help="额外写出；默认 data/sequoia_backtest/<track>/")
    parser.add_argument(
        "--profile",
        default="baseline",
        help="baseline|filtered（filtered=leaders_htf：BTC/ETH+4h确认+12h冷却+缩量过滤+5x）",
    )
    parser.add_argument(
        "--filter",
        dest="filter_alias",
        default="",
        help="过滤别名；leaders_htf 等价 --profile filtered（保留 baseline --track crypto）",
    )
    parser.add_argument("--record-stats", action="store_true", help="写入 pattern_alert_stats（不推 TG）")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
    )

    from oi_mornitor.backtest.sequoia_pipeline import (
        default_major_symbols,
        normalize_track,
        resolve_klines_root,
        run_sequoia_pipeline,
        track_defaults,
    )
    from oi_mornitor.strategy_sequoia.filters import profile_params_dict, resolve_filter_profile
    from oi_mornitor.strategy_sequoia.registry import chinese_catalog

    root = resolve_klines_root(args.klines_dir or None)
    tracks = ["crypto", "us_equity"] if args.track == "both" else [normalize_track(args.track)]
    strat = tuple(x.strip() for x in args.strategies.split(",") if x.strip()) or None
    user_symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    profile_raw = args.filter_alias.strip() or args.profile
    fp = resolve_filter_profile(profile_raw)

    print("策略目录:", json.dumps(chinese_catalog(), ensure_ascii=False), file=sys.stderr)
    print(f"K线根: {root}", file=sys.stderr)
    print(f"profile={fp.name} filter={profile_params_dict(fp).get('htf_rule_doc')}", file=sys.stderr)

    summaries: list[dict] = []

    for tr in tracks:
        td = track_defaults(tr)
        use_filter = tr == "crypto" and fp.name == "filtered"
        fp_tr = fp if use_filter else resolve_filter_profile("baseline")
        sl = float(args.stop) if args.stop is not None else (
            float(fp_tr.sl_pct) if use_filter else float(td["sl_pct"])
        )
        hold = int(args.hold_bars) if args.hold_bars is not None else (
            int(fp_tr.hold_bars) if use_filter else int(td["hold_bars"])
        )
        lev = float(args.leverage) if args.leverage is not None else (
            float(fp_tr.leverage) if use_filter else float(td["leverage"])
        )
        margin = float(args.margin_cny) if args.margin_cny is not None else float(td["margin_cny"])
        univ = fp_tr.universe if use_filter else "majors"
        symbols = user_symbols or default_major_symbols(
            root, track=tr, interval=args.interval, universe=univ
        )

        print(
            f"track={tr} profile={fp_tr.name} universe={fp_tr.universe_label if use_filter else univ} "
            f"mode={args.mode} TF={args.interval} SL={sl}% hold={hold} "
            f"lev={lev}x 保证金={margin} 符号数={len(symbols)} TG=关",
            file=sys.stderr,
        )

        if args.mode == "fixed":
            from oi_mornitor.backtest.sequoia_pipeline import _load_signal_df, _run_fixed_stop_quick
            from oi_mornitor.backtest_kline_store import BacktestKlineStore
            from oi_mornitor.strategy_sequoia.registry import resolve_strategy_ids

            store = BacktestKlineStore(root=root)
            ids = resolve_strategy_ids(strat)
            dfs = {}
            for sym in symbols:
                df = _load_signal_df(store, sym, args.interval)
                if args.limit_bars and len(df) > args.limit_bars:
                    df = df.iloc[-args.limit_bars :].reset_index(drop=True)
                if not df.empty:
                    dfs[sym] = df
            htf_dfs = {}
            if use_filter and fp_tr.htf_confirm:
                for sym, df in list(dfs.items()):
                    hdf = _load_signal_df(store, sym, fp_tr.htf_interval)
                    if not hdf.empty:
                        htf_dfs[sym] = hdf
            matrix = _run_fixed_stop_quick(
                dfs,
                interval=args.interval,
                strategy_ids=ids,
                sl_pct=sl,
                hold_bars=hold,
                warmup=args.warmup,
                leverage=lev,
                margin_cny=margin,
                filter_profile=fp_tr if use_filter else None,
                htf_dfs=htf_dfs or None,
            )
            # recompute margin with track leverage
            from oi_mornitor.backtest.sequoia_pipeline import leverage_report

            for row in matrix:
                # matrix already used SEQUOIA_BT_LEVERAGE inside _run_fixed_stop_quick via leverage_report default
                pass
            # Rebuild matrix leverage with correct lev
            matrix2 = []
            for sid in ids:
                from oi_mornitor.strategy_sequoia.registry import STRATEGY_META

                # rerun report is already embedded; patch fields using row avg
                row = next((r for r in matrix if r["strategy_id"] == sid), None)
                if not row:
                    continue
                # adjust margin fields to track leverage
                avg = float(row.get("avg_trade_pct") or 0)
                mdd = float(row.get("max_dd_pct") or 0)
                row = dict(row)
                row["avg_margin_pnl_cny"] = round(avg / 100.0 * lev * margin, 2)
                row["dd_x_leverage_pct"] = round(mdd * lev, 1)
                row["blowup_risk_20x"] = (mdd * lev) >= 100.0
                row["leverage"] = lev
                row["track"] = tr
                matrix2.append(row)
            out = {
                "mode": "fixed",
                "track": tr,
                "profile": fp_tr.name,
                "universe_label": fp_tr.universe_label if use_filter else ("majors" if tr == "crypto" else "us_equity"),
                "filter": profile_params_dict(fp_tr),
                "klines_root": str(root),
                "interval": args.interval,
                "sl_pct": sl,
                "leverage": lev,
                "margin_cny": margin,
                "matrix": matrix2,
                "telegram": False,
            }
            out_key = fp_tr.out_subdir if use_filter else tr
            out_dir = Path(__file__).resolve().parents[1] / "data" / "sequoia_backtest" / out_key
            out_dir.mkdir(parents=True, exist_ok=True)
            path = out_dir / "fixed_matrix_latest.json"
            path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"wrote {path}", file=sys.stderr)
            for row in matrix2:
                flag = "⚠DD×lev≥100%" if row.get("blowup_risk_20x") else "ok"
                print(
                    f"[{tr}/{row['strategy_cn']}/{row['stop']}] trades={row['trades']} "
                    f"win={row['winrate']}% avg={row['avg_trade_pct']}% "
                    f"maxDD={row['max_dd_pct']}% DD×{lev:g}={row['dd_x_leverage_pct']}% "
                    f"均保证金≈{row['avg_margin_pnl_cny']}元 {flag}",
                    file=sys.stderr,
                )
            summaries.append(out)
            continue

        result = run_sequoia_pipeline(
            symbols=symbols,
            interval=args.interval,
            strategy_ids=strat,
            track=tr,
            sl_pct=sl,
            hold_bars=hold,
            warmup=args.warmup,
            klines_root=root,
            record_stats=args.record_stats,
            limit_bars=args.limit_bars,
            include_fixed_matrix=(args.mode == "both"),
            leverage=lev,
            margin_cny=margin,
            profile=fp_tr.name,
            filter_profile=fp_tr,
        )
        if args.json_out and len(tracks) == 1:
            Path(args.json_out).write_text(
                json.dumps(result.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            print(f"wrote {args.json_out}", file=sys.stderr)

        lev_info = result.leverage
        print(f"=== Sequoia [{tr}] 流水线（SL={sl}% / 报告{lev:g}x）===", file=sys.stderr)
        print(f"symbols={len(result.symbols)} items={len(result.items)}", file=sys.stderr)
        print(
            f"{lev:g}x示意: 均价涨跌={lev_info.get('avg_price_pct')}% → 均保证金≈{lev_info.get('avg_margin_pnl_cny')}元/"
            f"{margin:g}元 | maxDD={lev_info.get('max_dd_price_pct')}% → DD×{lev:g}={lev_info.get('dd_x_leverage_pct')}% "
            f"{'⚠易打穿' if lev_info.get('blowup_risk') else 'ok'}",
            file=sys.stderr,
        )
        for sid, block in result.by_strategy.items():
            L = block.get("leverage") or {}
            print(
                f"  {block.get('type_label')}: n={block.get('count')} "
                f"win={L.get('win_rate')}% avg={L.get('avg_price_pct')}% "
                f"DD×{lev:g}={L.get('dd_x_leverage_pct')}% blowup={L.get('blowup_risk')}",
                file=sys.stderr,
            )
        if result.fixed_stop_matrix:
            print(f"=== [{tr}] 固定止损+超时对照 ===", file=sys.stderr)
            for row in result.fixed_stop_matrix:
                print(
                    f"  {row['strategy_cn']}: trades={row['trades']} win={row['winrate']}% "
                    f"avg={row['avg_trade_pct']}% DD×lev≈{row['dd_x_leverage_pct']}%",
                    file=sys.stderr,
                )
        print(f"out_dir={result.out_dir} elapsed={result.elapsed_sec}s TG=关", file=sys.stderr)
        summaries.append(
            {
                "track": tr,
                "out_dir": result.out_dir,
                "item_count": len(result.items),
                "leverage": result.leverage,
                "by_strategy": {
                    k: {
                        "type_label": v.get("type_label"),
                        "count": v.get("count"),
                        "leverage": v.get("leverage"),
                    }
                    for k, v in result.by_strategy.items()
                },
                "fixed_stop_matrix": result.fixed_stop_matrix,
                "telegram": False,
            }
        )

    print(json.dumps({"tracks": summaries, "telegram": False}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
