"""V2 回测入口：写出摘要、逐笔 CSV、事件日志与权益曲线。不覆盖 V1 的 my-run。"""
from __future__ import annotations

import csv
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

import pandas as pd

from oi_mornitor.backtest.sequoia_pipeline import resolve_klines_root
from oi_mornitor.backtest_engine_v2.alignment import INTERVAL_MS
from oi_mornitor.backtest_engine_v2.engine import merge_symbol_results_v2, run_on_frames_v2
from oi_mornitor.backtest_kline_store import BacktestKlineStore
from oi_mornitor.backtest_trade_config import OI_BT_FEE_PCT, OI_BT_SLIPPAGE_PCT
from oi_mornitor.strategy.short_term_v1.ablation import flags_for
from oi_mornitor.strategy.short_term_v1.params import (
    DEFAULT_EQUITY,
    PRICE_PROXY_NOTE,
    RESEARCH_DISCLAIMER,
    defaults_dict,
)
from oi_mornitor.strategy.short_term_v1.runner import _load_df, _slice, resolve_universe

_PKG = Path(__file__).resolve().parents[2]
_OUT_ROOT = _PKG / "data" / "short_term_v2"

# 4H/1H 需要足够已收盘历史才能算均线，不能从样本起点切开。
WARMUP_MS = 90 * 24 * 60 * 60 * 1000


def _ensure_out(out: Path | None = None) -> Path:
    if out is None:
        stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
        dest = _OUT_ROOT / stamp
    else:
        dest = Path(out)
    dest.mkdir(parents=True, exist_ok=True)
    return dest


def _slice_htf(df: pd.DataFrame, start_ms: int | None, end_ms: int | None) -> pd.DataFrame:
    warm_start = (int(start_ms) - WARMUP_MS) if start_ms else None
    return _slice(df, warm_start, end_ms)


def _write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            out = {}
            for k in fields:
                v = r.get(k)
                if isinstance(v, (list, dict)):
                    v = json.dumps(v, ensure_ascii=False, default=str)
                out[k] = v
            w.writerow(out)


def write_artifacts(dest: Path, payload: dict[str, Any], *, params: dict[str, Any]) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    body = dict(payload)
    # 摘要里不塞全部跳过明细，完整跳过见 skip_counts + skipped.csv
    slim = dict(body)
    skipped = list(slim.get("skipped") or [])
    slim["skipped"] = skipped[:0]  # 计数在 skippedCount / skipCounts
    slim["skippedTruncated"] = False
    slim["skippedFullCount"] = len(skipped)
    slim["params"] = params
    items = list(slim.get("items") or [])
    # 摘要 json 去掉超长 events/path 以控制体积；完整记录在 CSV
    slim_items = []
    for it in items:
        row = {k: v for k, v in it.items() if k not in ("events", "path_bars", "feeLedger")}
        row["eventCount"] = len(it.get("events") or [])
        slim_items.append(row)
    slim["items"] = slim_items
    if "allDecisions" in slim:
        del slim["allDecisions"]
    if slim.get("summary", {}).get("equity"):
        curve = slim["summary"]["equity"].get("curve") or []
        slim["summary"] = dict(slim["summary"])
        slim["summary"]["equity"] = {k: v for k, v in slim["summary"]["equity"].items() if k != "curve"}
        slim["summary"]["equityPointCount"] = len(curve)
    (dest / "summary.json").write_text(json.dumps(slim, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    (dest / "summary.md").write_text(_markdown(slim), encoding="utf-8")

    trade_fields = [
        "symbol", "setup", "kind", "direction", "tier", "market_regime",
        "signalAt", "signalOpenAt", "signalCloseAt", "fillAt", "entryAt", "exitAt",
        "entryRequested", "entryFilled", "entry", "stop_loss", "structure_level",
        "exit_price_raw", "exit_price", "exit_reason", "exitReason",
        "tp1Hit", "tp2Hit", "runnerActivated", "initialSlHit",
        "realized_r", "realized_r_net", "pnlPctGross", "pnlPct", "pnlUsdtGross", "pnlUsdt",
        "feeUsdt", "exitSlipUsdt", "risk_percent", "position_qty", "leverage",
        "mfe_r", "mae_r", "bars_held", "holdMs", "equityAfter",
        "timingIssues", "feeReconcileIssues",
    ]
    _write_csv(dest / "trades.csv", items, trade_fields)

    events: list[dict[str, Any]] = []
    for it in items:
        for ev in it.get("events") or []:
            events.append({
                "symbol": it.get("symbol"),
                "setup": it.get("setup"),
                "direction": it.get("direction"),
                "signalAt": it.get("signalAt"),
                **ev,
            })
    ev_fields = [
        "symbol", "setup", "direction", "signalAt", "type", "ts",
        "entryRequested", "entryFilled", "rawPrice", "exitFilled", "frac", "r", "rLevel",
        "entryFeeUsdt", "exitFeeUsdt", "exitSlipUsdt", "netUsdt", "feeUsdt", "reason",
    ]
    _write_csv(dest / "events.csv", events, ev_fields)

    skipped_fields = ["symbol", "setup", "kind", "direction", "signalAt", "skip_reason", "market_regime"]
    _write_csv(dest / "skipped.csv", skipped, skipped_fields)

    curve = ((payload.get("summary") or {}).get("equity") or {}).get("curve") or []
    _write_csv(dest / "equity.csv", curve, ["ts", "symbol", "setup", "equity", "pnlUsdt", "drawdownUsdt", "drawdownPct"])

    recon = []
    for it in items:
        ledger = it.get("feeLedger") or {}
        recon.append({
            "symbol": it.get("symbol"),
            "signalAt": it.get("signalAt"),
            "entryRequested": ledger.get("entryRequested"),
            "entryFilled": ledger.get("entryFilled"),
            "grossUsdt": ledger.get("grossUsdt"),
            "exitSlipUsdt": ledger.get("exitSlipUsdt"),
            "feeUsdtTotal": ledger.get("feeUsdtTotal"),
            "netUsdt": ledger.get("netUsdt"),
            "pnlPctGross": ledger.get("pnlPctGross"),
            "pnlPctNet": ledger.get("pnlPctNet"),
            "issues": ledger.get("reconcileIssues") or it.get("feeReconcileIssues") or [],
        })
    _write_csv(dest / "fee_ledger.csv", recon, [
        "symbol", "signalAt", "entryRequested", "entryFilled", "grossUsdt", "exitSlipUsdt",
        "feeUsdtTotal", "netUsdt", "pnlPctGross", "pnlPctNet", "issues",
    ])


def _markdown(body: dict[str, Any]) -> str:
    s = body.get("summary") or {}
    acc = body.get("acceptance") or {}
    exp = body.get("experiment") or {}
    lines = [
        "# 短线回测基础设施 V2（第一阶段）",
        "",
        RESEARCH_DISCLAIMER,
        "",
        "本阶段只修正对齐、费用、已收盘 4H、字段映射与权益口径，不改出场状态机参数，也不增加过滤器。",
        "",
        f"- 实验：{exp.get('id', '')} · {exp.get('label', '')}",
        f"- 笔数：{s.get('nSettled', s.get('n', 0))}（跳过 {body.get('skippedCount', 0)}）",
        f"- 账户净值收益：{s.get('netReturnPct')}%（起始权益见 params，期末 {s.get('endingEquity')}）",
        f"- 账户最大回撤：{s.get('maxDrawdownPct')}% / {s.get('maxDrawdownUsdt')} USDT",
        f"- 单笔期望 R：{s.get('expectancyR')}  利润因子（R）：{s.get('profitFactorR')}",
        f"- 胜率（仅参考）：{s.get('winRate')}",
        f"- 对照：价格变动百分比合计 {s.get('priceMoveSumPct')}（不是净值）",
        f"- TP1 / TP2 / 初始止损命中率：{s.get('tp1HitRate')} / {s.get('tp2HitRate')} / {s.get('initialSlHitRate')}",
        f"- Runner 激活（先打到 TP2 再跟踪/结构/ATR 离场）：{s.get('runnerActivationRate')}",
        f"- 出场原因：{json.dumps(s.get('exitReasons') or {}, ensure_ascii=False)}",
        f"- 验收：成交前路径问题 {acc.get('timingIssueTrades', s.get('timingIssueCount'))} 笔，费用对账问题 {acc.get('feeReconcileIssueTrades', s.get('feeReconcileIssueCount'))} 笔，通过={acc.get('passed')}",
        f"- 耗时：{body.get('elapsed_sec')}s",
        "",
        PRICE_PROXY_NOTE,
        "",
        f"成交规则：{body.get('fillRules', '')}",
        "",
        "完整逐笔见 trades.csv，事件见 events.csv，权益见 equity.csv，费用账本见 fee_ledger.csv。",
    ]
    return "\n".join(lines) + "\n"


def run_backtest_engine_v2(
    *,
    symbols: Sequence[str] | None = None,
    universe: str = "crypto_no_equity",
    start_ms: int | None = None,
    end_ms: int | None = None,
    experiment: str = "E",
    fee_pct: float | None = None,
    slippage_pct: float | None = None,
    equity: float = DEFAULT_EQUITY,
    out_dir: Path | None = None,
    root: Path | None = None,
    limit_bars: int = 0,
) -> dict[str, Any]:
    fee = OI_BT_FEE_PCT if fee_pct is None else float(fee_pct)
    slip = OI_BT_SLIPPAGE_PCT if slippage_pct is None else float(slippage_pct)
    flags = flags_for(experiment)
    dest = _ensure_out(out_dir)
    t0 = time.time()
    store = BacktestKlineStore(root=resolve_klines_root(root))
    syms = resolve_universe(symbols, universe=universe, root=root)
    df_btc_15 = _slice(_load_df(store, "BTCUSDT", "15m"), start_ms, end_ms)
    df_btc_4h = _slice_htf(_load_df(store, "BTCUSDT", "4h"), start_ms, end_ms)
    results: list[dict[str, Any]] = []
    missing: list[str] = []
    print(
        f"[stv2] symbols={syms} experiment={flags.id} fee={fee} slip={slip} "
        f"klines={store.parquet_root}",
        flush=True,
    )
    for i, sym in enumerate(syms, 1):
        df15 = _slice(_load_df(store, sym, "15m"), start_ms, end_ms)
        if limit_bars and len(df15) > limit_bars:
            df15 = df15.iloc[-int(limit_bars):].reset_index(drop=True)
        exec_end = (int(end_ms) + 48 * 5 * 60 * 1000) if end_ms else end_ms
        df5 = _slice(_load_df(store, sym, "5m"), start_ms, exec_end)
        # 5m 向窗口结束后多留超时长度，避免临近截止的成交路径被截断。
        df1 = _slice_htf(_load_df(store, sym, "1h"), start_ms, end_ms)
        df4 = _slice_htf(_load_df(store, sym, "4h"), start_ms, end_ms)
        if df15 is None or len(df15) < 80:
            missing.append(sym)
            print(f"[stv2] {i}/{len(syms)} {sym}: 15m 不足，跳过", flush=True)
            continue
        print(
            f"[stv2] {i}/{len(syms)} {sym}: 15m={len(df15)} 5m={len(df5) if df5 is not None else 0} 开始",
            flush=True,
        )
        t1 = time.time()
        rec = run_on_frames_v2(
            symbol=sym,
            df_15m=df15,
            df_5m=df5 if df5 is not None and len(df5) else None,
            df_1h=df1 if df1 is not None and len(df1) else None,
            df_4h=df4 if df4 is not None and len(df4) else None,
            df_btc_15m=df_btc_15 if df_btc_15 is not None and len(df_btc_15) else None,
            df_btc_4h=df_btc_4h if df_btc_4h is not None and len(df_btc_4h) else None,
            experiment=flags.id,
            equity=equity,
            fee_pct=fee,
            slippage_pct=slip,
        )
        results.append(rec)
        print(
            f"[stv2] {sym}: 完成 {round(time.time() - t1, 1)}s "
            f"入场={len(rec.get('accepted') or [])} 跳过={len(rec.get('skipped') or [])}",
            flush=True,
        )
    merged = merge_symbol_results_v2(results, experiment=flags.id, equity=equity)
    merged.update({
        "symbols": syms,
        "missingOrShort": missing,
        "universe": universe,
        "startMs": start_ms,
        "endMs": end_ms,
        "feePct": fee,
        "slippagePct": slip,
        "equity": equity,
        "elapsed_sec": round(time.time() - t0, 3),
        "out_dir": str(dest),
        "klines_root": str(store.parquet_root),
        "defaults": defaults_dict(),
    })
    write_artifacts(dest, merged, params={
        "symbols": syms, "universe": universe, "startMs": start_ms, "endMs": end_ms,
        "experiment": flags.id, "feePct": fee, "slippagePct": slip, "equity": equity,
        "engine": "backtest_engine_v2",
    })
    print(
        f"[stv2] 验收 passed={merged.get('acceptance', {}).get('passed')} "
        f"timing={merged.get('acceptance', {}).get('timingIssueTrades')} "
        f"fee={merged.get('acceptance', {}).get('feeReconcileIssueTrades')} "
        f"out={dest}",
        flush=True,
    )
    return merged
