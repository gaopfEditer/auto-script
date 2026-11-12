"""把 V1 引擎接到本地 K 线库，写出 json + 摘要。不在导入时跑重回测。"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

import pandas as pd

from oi_mornitor.backtest.sequoia_pipeline import resolve_klines_root
from oi_mornitor.backtest_kline_store import BacktestKlineStore
from oi_mornitor.backtest_trade_config import OI_BT_FEE_PCT, OI_BT_SLIPPAGE_PCT
from oi_mornitor.strategy.short_term_v1.ablation import flags_for
from oi_mornitor.strategy.short_term_v1.engine import merge_symbol_results, run_on_frames
from oi_mornitor.strategy.short_term_v1.params import (
    DEFAULT_EQUITY,
    PRICE_PROXY_NOTE,
    RESEARCH_DISCLAIMER,
    defaults_dict,
)
from oi_mornitor.strategy.short_term_v1.tiers import is_equity_token
from oi_mornitor.symbol_aliases import normalize_usdt_symbol

_PKG = Path(__file__).resolve().parents[2]
_OUT_ROOT = _PKG / "data" / "short_term_v1"

DEFAULT_UNIVERSE_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "UNIUSDT"]


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


def resolve_universe(
    symbols: Sequence[str] | None,
    *,
    universe: str = "crypto_no_equity",
    root: Path | None = None,
    interval: str = "15m",
) -> list[str]:
    store = BacktestKlineStore(root=resolve_klines_root(root))
    if symbols:
        raw = [normalize_usdt_symbol(s) or str(s).upper() for s in symbols if str(s).strip()]
    else:
        u = (universe or "crypto_no_equity").lower()
        if u in ("majors", "btc_eth"):
            raw = ["BTCUSDT", "ETHUSDT"]
        elif u in ("majors_sol", "btc_eth_sol"):
            raw = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        else:
            raw = list(DEFAULT_UNIVERSE_SYMBOLS)
    out: list[str] = []
    for s in raw:
        if is_equity_token(s) and universe not in ("equity", "all_including_equity"):
            continue
        path = store.parquet_root / s / f"{interval}.parquet"
        if path.is_file():
            out.append(s)
        else:
            # 仍列入，引擎会得到空帧
            out.append(s)
    return out


def run_short_term_v1(
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
    dry_run: bool = False,
    limit_bars: int = 0,
) -> dict[str, Any]:
    fee = OI_BT_FEE_PCT if fee_pct is None else float(fee_pct)
    slip = OI_BT_SLIPPAGE_PCT if slippage_pct is None else float(slippage_pct)
    flags = flags_for(experiment)
    dest = _ensure_out(out_dir)
    t0 = time.time()

    if dry_run:
        from oi_mornitor.strategy.short_term_v1.synthetic import tiny_fixture_result

        merged = tiny_fixture_result(experiment=flags.id, fee_pct=fee, slippage_pct=slip, equity=equity)
        merged["dryRun"] = True
        merged["elapsed_sec"] = round(time.time() - t0, 3)
        merged["out_dir"] = str(dest)
        _write_outputs(dest, merged, params={
            "dryRun": True, "experiment": flags.id, "feePct": fee, "slippagePct": slip,
        })
        return merged

    store = BacktestKlineStore(root=resolve_klines_root(root))
    syms = resolve_universe(symbols, universe=universe, root=root)
    df_btc_15 = _slice(_load_df(store, "BTCUSDT", "15m"), start_ms, end_ms)
    df_btc_4h = _slice(_load_df(store, "BTCUSDT", "4h"), start_ms, end_ms)
    results: list[dict[str, Any]] = []
    missing: list[str] = []
    print(
        f"[stv1] symbols={syms} experiment={flags.id} fee={fee} slip={slip} "
        f"klines={store.parquet_root}",
        flush=True,
    )
    for i, sym in enumerate(syms, 1):
        df15 = _slice(_load_df(store, sym, "15m"), start_ms, end_ms)
        if limit_bars and len(df15) > limit_bars:
            df15 = df15.iloc[-int(limit_bars):].reset_index(drop=True)
        df5 = _slice(_load_df(store, sym, "5m"), start_ms, end_ms)
        df1 = _slice(_load_df(store, sym, "1h"), start_ms, end_ms)
        df4 = _slice(_load_df(store, sym, "4h"), start_ms, end_ms)
        if df15 is None or len(df15) < 80:
            missing.append(sym)
            print(f"[stv1] {i}/{len(syms)} {sym}: 15m 不足，跳过", flush=True)
            continue
        print(
            f"[stv1] {i}/{len(syms)} {sym}: 15m={len(df15)} 5m={len(df5) if df5 is not None else 0} 开始",
            flush=True,
        )
        t1 = time.time()
        rec = run_on_frames(
            symbol=sym,
            df_15m=df15,
            df_5m=df5 if len(df5) else None,
            df_1h=df1 if len(df1) else None,
            df_4h=df4 if len(df4) else None,
            df_btc_15m=df_btc_15 if len(df_btc_15) else None,
            df_btc_4h=df_btc_4h if len(df_btc_4h) else None,
            experiment=flags.id,
            equity=equity,
            fee_pct=fee,
            slippage_pct=slip,
        )
        results.append(rec)
        print(
            f"[stv1] {sym}: 完成 {round(time.time() - t1, 1)}s "
            f"入场={len(rec.get('accepted') or [])} 跳过={len(rec.get('skipped') or [])}",
            flush=True,
        )
    merged = merge_symbol_results(results, experiment=flags.id)
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
        "dryRun": False,
    })
    _write_outputs(dest, merged, params={
        "symbols": syms, "universe": universe, "startMs": start_ms, "endMs": end_ms,
        "experiment": flags.id, "feePct": fee, "slippagePct": slip, "equity": equity,
    })
    return merged


def _write_outputs(dest: Path, payload: dict[str, Any], *, params: dict[str, Any]) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    body = dict(payload)
    body["params"] = params
    (dest / "summary.json").write_text(json.dumps(body, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    # 最新指针
    latest = _OUT_ROOT
    latest.mkdir(parents=True, exist_ok=True)
    (latest / "latest_summary.json").write_text(
        json.dumps(body, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    md = _markdown_summary(body)
    (dest / "summary.md").write_text(md, encoding="utf-8")


def _markdown_summary(body: dict[str, Any]) -> str:
    s = body.get("summary") or {}
    exp = (body.get("experiment") or {})
    lines = [
        "# 短线策略 V1 回测摘要",
        "",
        RESEARCH_DISCLAIMER,
        "",
        f"- 实验：{exp.get('id', '')} · {exp.get('label', '')}",
        f"- 笔数：{s.get('nSettled', s.get('n', 0))}（跳过 {body.get('skippedCount', 0)}）",
        f"- 净收益（价格变动%合计）：{s.get('netPnlPct', s.get('totalPnlPct'))}",
        f"- 利润因子：{s.get('profitFactor')}",
        f"- 单笔期望：{s.get('expectancy')}",
        f"- 最大回撤（同口径累计%）：{s.get('maxDrawdownPct')}",
        f"- 胜率（仅作参考，不是优化目标）：{s.get('winRate')}",
        f"- 耗时：{body.get('elapsed_sec')}s",
        "",
        PRICE_PROXY_NOTE,
        "",
        f"成交规则：{body.get('fillRules', '')}",
        "",
        "二次探底默认暂停；射击之星（含连续走平）默认启用，须过情境闸。美股代币默认排除。",
        "",
        "参数是研究起点。请做滚动样本外，不要把某段牛市曲线当成策略已验证。",
    ]
    return "\n".join(lines) + "\n"
