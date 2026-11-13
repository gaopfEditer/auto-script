"""V2 / 并行回测入口：写 json + md。不在导入时跑重活。"""
from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

import pandas as pd

from oi_mornitor.backtest.sequoia_pipeline import resolve_klines_root
from oi_mornitor.backtest_kline_store import BacktestKlineStore
from oi_mornitor.backtest_trade_config import OI_BT_FEE_PCT, OI_BT_SLIPPAGE_PCT
from oi_mornitor.strategy.short_term_v1.runner import resolve_universe
from oi_mornitor.strategy.short_term_v2.engine import collect_signals_on_frames, merge_v2_symbol_results
from oi_mornitor.strategy.short_term_v2.parallel import merge_parallel_results, run_parallel_on_frames
from oi_mornitor.strategy.short_term_v2.params import (
    BATCH1_STRATEGIES,
    RESEARCH_DISCLAIMER,
    STRATEGY_VERSION,
    defaults_dict,
)
from oi_mornitor.strategy.short_term_v2.quality_gate import DEFAULT_GATE_MODE, DEFAULT_MIN_SCORE_TIER

_PKG = Path(__file__).resolve().parents[2]
_OUT_ROOT = _PKG / "data" / "short_term_v2"


def _ensure_out(out: Path | None = None) -> Path:
    if out is None:
        stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
        dest = _OUT_ROOT / stamp
    else:
        dest = Path(out)
    dest.mkdir(parents=True, exist_ok=True)
    return dest


def _load_df(store: BacktestKlineStore, symbol: str, interval: str) -> pd.DataFrame:
    path = store.parquet_root / symbol.upper() / f"{interval}.parquet"
    if not path.is_file():
        return pd.DataFrame()
    return pd.read_parquet(path)


def _slice(df: pd.DataFrame, start_ms: int | None, end_ms: int | None) -> pd.DataFrame:
    if df is None or len(df) == 0 or "open_time" not in df.columns:
        return df if df is not None else pd.DataFrame()
    t = df["open_time"].astype("int64")
    if t.max() < 1e12:
        t = t * 1000
        df = df.copy()
        df["open_time"] = t
    m = pd.Series(True, index=df.index)
    if start_ms:
        m &= t >= int(start_ms)
    if end_ms:
        m &= t <= int(end_ms)
    return df.loc[m].reset_index(drop=True)


def _write_outputs(dest: Path, payload: dict[str, Any], *, params: dict[str, Any]) -> None:
    summary = {
        **payload,
        "writtenAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "params": params,
    }
    (dest / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    counts = payload.get("counts") or {}
    stats = payload.get("stats") or (payload.get("v2") or {}).get("stats") or {}
    lines = [
        f"# 短线策略 {STRATEGY_VERSION.upper()} 摘要",
        "",
        RESEARCH_DISCLAIMER,
        "",
        f"- 写出时间：{summary['writtenAt']}",
        f"- 模式：{payload.get('mode') or 'v2_only'}",
        f"- 信号总数：{counts.get('total') or counts.get('combined')}",
        f"- 成交/模拟：{counts.get('traded') or counts.get('v2Traded')}",
        f"- 净收益合计%：{stats.get('netReturnSumPct')}",
        f"- 期望%：{stats.get('expectancyPct')}",
        f"- 胜率：{stats.get('winRate')}",
        f"- PF：{stats.get('profitFactor')}",
        "",
        "## 按策略计数",
        "",
        "```json",
        json.dumps(counts.get("byType") or counts, ensure_ascii=False, indent=2),
        "```",
        "",
    ]
    (dest / "summary.md").write_text("\n".join(lines), encoding="utf-8")


def run_short_term_v2(
    *,
    symbols: Sequence[str] | None = None,
    universe: str = "crypto_no_equity",
    start_ms: int | None = None,
    end_ms: int | None = None,
    strategies: Sequence[str] | None = None,
    include_batch2: bool = False,
    fee_pct: float | None = None,
    slippage_pct: float | None = None,
    out_dir: Path | None = None,
    root: Path | None = None,
    dry_run: bool = False,
    limit_bars: int = 0,
    parallel_v1: bool = False,
    v1_experiment: str = "E",
    equity: float = 10_000.0,
    quality_gate: bool = True,
    min_score_tier: str = DEFAULT_MIN_SCORE_TIER,
    gate_mode: str = DEFAULT_GATE_MODE,
) -> dict[str, Any]:
    fee = OI_BT_FEE_PCT if fee_pct is None else float(fee_pct)
    slip = OI_BT_SLIPPAGE_PCT if slippage_pct is None else float(slippage_pct)
    dest = _ensure_out(out_dir)
    t0 = time.time()
    strat = list(strategies) if strategies else list(BATCH1_STRATEGIES)
    min_tier = str(min_score_tier or DEFAULT_MIN_SCORE_TIER).strip().upper() or DEFAULT_MIN_SCORE_TIER
    gmode = str(gate_mode or DEFAULT_GATE_MODE).strip().lower() or DEFAULT_GATE_MODE

    if dry_run:
        if parallel_v1:
            from oi_mornitor.strategy.short_term_v2.synthetic import tiny_parallel_fixture

            merged = tiny_parallel_fixture(fee_pct=fee, slip_pct=slip, equity=equity)
        else:
            from oi_mornitor.strategy.short_term_v2.synthetic import tiny_v2_fixture

            merged = tiny_v2_fixture(fee_pct=fee, slip_pct=slip)
        merged["dryRun"] = True
        merged["elapsed_sec"] = round(time.time() - t0, 3)
        merged["out_dir"] = str(dest)
        _write_outputs(dest, merged, params={
            "dryRun": True,
            "parallelV1": parallel_v1,
            "strategies": strat,
            "feePct": fee,
            "slippagePct": slip,
        })
        return merged

    store = BacktestKlineStore(root=resolve_klines_root(root))
    syms = resolve_universe(symbols, universe=universe, root=root)
    df_btc_15 = _slice(_load_df(store, "BTCUSDT", "15m"), start_ms, end_ms)
    df_btc_4h = _slice(_load_df(store, "BTCUSDT", "4h"), start_ms, end_ms)
    results: list[dict[str, Any]] = []
    print(f"[stv2] symbols={syms} strategies={strat} parallel_v1={parallel_v1}", flush=True)
    for i, sym in enumerate(syms, 1):
        df15 = _slice(_load_df(store, sym, "15m"), start_ms, end_ms)
        if limit_bars and len(df15) > limit_bars:
            df15 = df15.iloc[-int(limit_bars):].reset_index(drop=True)
        df5 = _slice(_load_df(store, sym, "5m"), start_ms, end_ms)
        df1 = _slice(_load_df(store, sym, "1h"), start_ms, end_ms)
        df4 = _slice(_load_df(store, sym, "4h"), start_ms, end_ms)
        if df15 is None or len(df15) < 100:
            print(f"[stv2] {i}/{len(syms)} {sym}: 15m 不足，跳过", flush=True)
            continue
        print(
            f"[stv2] {i}/{len(syms)} {sym}: 15m={len(df15)} 开始 "
            f"quality_gate={quality_gate} mode={gmode} min_score>={min_tier}",
            flush=True,
        )
        t1 = time.time()
        if parallel_v1:
            rec = run_parallel_on_frames(
                symbol=sym,
                df_15m=df15,
                df_5m=df5 if len(df5) else None,
                df_1h=df1 if len(df1) else None,
                df_4h=df4 if len(df4) else None,
                df_btc_15m=df_btc_15 if len(df_btc_15) else None,
                df_btc_4h=df_btc_4h if len(df_btc_4h) else None,
                v1_experiment=v1_experiment,
                v2_strategies=strat,
                include_batch2=include_batch2,
                equity=equity,
                fee_pct=fee,
                slippage_pct=slip,
                quality_gate=quality_gate,
                min_score_tier=min_tier,
                gate_mode=gmode,
            )
        else:
            rec = collect_signals_on_frames(
                symbol=sym,
                df_15m=df15,
                df_1h=df1 if len(df1) else None,
                df_4h=df4 if len(df4) else None,
                df_btc_15m=df_btc_15 if len(df_btc_15) else None,
                strategies=strat,
                include_batch2=include_batch2,
                fee_pct=fee,
                slip_pct=slip,
                quality_gate=quality_gate,
                min_score_tier=min_tier,
                gate_mode=gmode,
            )
        results.append(rec)
        print(f"[stv2] {sym}: 完成 {round(time.time() - t1, 1)}s", flush=True)

    if parallel_v1:
        merged = merge_parallel_results(results)
    else:
        merged = merge_v2_symbol_results(results)
    merged.update({
        "symbols": syms,
        "universe": universe,
        "startMs": start_ms,
        "endMs": end_ms,
        "elapsed_sec": round(time.time() - t0, 3),
        "out_dir": str(dest),
        "paramsSnapshot": defaults_dict(),
    })
    _write_outputs(dest, merged, params={
        "strategies": strat,
        "includeBatch2": include_batch2,
        "parallelV1": parallel_v1,
        "v1Experiment": v1_experiment,
        "feePct": fee,
        "slippagePct": slip,
        "universe": universe,
        "qualityGate": quality_gate,
        "minScoreTier": min_tier,
        "qualityGateMode": gmode,
        "setupTf": "15m",
    })
    return merged
