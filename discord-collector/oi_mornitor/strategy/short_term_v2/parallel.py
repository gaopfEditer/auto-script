"""V1 + V2 并行：同一组 K 线帧上同步产出两套信号，互不改写。"""
from __future__ import annotations

from typing import Any, Sequence

import pandas as pd

from oi_mornitor.strategy.short_term_v1.engine import run_on_frames as run_v1_on_frames
from oi_mornitor.strategy.short_term_v2.engine import collect_signals_on_frames, merge_v2_symbol_results
from oi_mornitor.strategy.short_term_v2.params import RESEARCH_DISCLAIMER, STRATEGY_VERSION


def run_parallel_on_frames(
    *,
    symbol: str,
    df_15m: pd.DataFrame,
    df_5m: pd.DataFrame | None = None,
    df_1h: pd.DataFrame | None = None,
    df_4h: pd.DataFrame | None = None,
    df_1d: pd.DataFrame | None = None,
    df_btc_15m: pd.DataFrame | None = None,
    df_btc_4h: pd.DataFrame | None = None,
    liq_events: list[dict[str, Any]] | None = None,
    v1_experiment: str = "E",
    v2_strategies: Sequence[str] | None = None,
    include_batch2: bool = False,
    equity: float = 10_000.0,
    fee_pct: float = 0.06,
    slippage_pct: float = 0.03,
    vol_30d_quote: float | None = None,
    depth: float | None = None,
    spread_pct: float | None = None,
    run_v1: bool = True,
    run_v2: bool = True,
) -> dict[str, Any]:
    """同一标的上并行跑 V1 引擎与 V2 扫描器。

    返回结构：
    - v1 / v2：各自完整结果
    - combinedSignals：打上 strategyVersion 的扁平列表，便于后续组合研究
    """
    out: dict[str, Any] = {
        "symbol": symbol,
        "mode": "parallel_v1_v2",
        "disclaimer": (
            "V1 与 V2 独立产出；默认不合并交易。后续组合应先分策略验证净期望。"
            + " "
            + RESEARCH_DISCLAIMER
        ),
    }
    v1_res = None
    v2_res = None
    if run_v1:
        v1_res = run_v1_on_frames(
            symbol=symbol,
            df_15m=df_15m,
            df_5m=df_5m,
            df_1h=df_1h,
            df_4h=df_4h,
            df_btc_15m=df_btc_15m,
            df_btc_4h=df_btc_4h,
            experiment=v1_experiment,
            equity=equity,
            fee_pct=fee_pct,
            slippage_pct=slippage_pct,
            vol_30d_quote=vol_30d_quote,
            depth=depth,
            liq_events=liq_events,
        )
        v1_res = dict(v1_res)
        v1_res["strategyVersion"] = "v1"
        out["v1"] = v1_res
    if run_v2:
        v2_res = collect_signals_on_frames(
            symbol=symbol,
            df_15m=df_15m,
            df_1h=df_1h,
            df_4h=df_4h,
            df_1d=df_1d,
            df_btc_15m=df_btc_15m,
            liq_events=liq_events,
            strategies=list(v2_strategies) if v2_strategies else None,
            include_batch2=include_batch2,
            vol_30d_quote=vol_30d_quote,
            depth=depth,
            spread_pct=spread_pct,
            fee_pct=fee_pct,
            slip_pct=slippage_pct,
        )
        out["v2"] = v2_res

    combined: list[dict[str, Any]] = []
    if v1_res:
        for row in (v1_res.get("accepted") or []):
            d = dict(row)
            d["strategyVersion"] = "v1"
            d["stream"] = "v1_accepted"
            combined.append(d)
        for row in (v1_res.get("skipped") or [])[:500]:
            d = dict(row)
            d["strategyVersion"] = "v1"
            d["stream"] = "v1_skipped"
            combined.append(d)
    if v2_res:
        for row in (v2_res.get("signals") or []):
            d = dict(row)
            d["strategyVersion"] = STRATEGY_VERSION
            d["stream"] = f"v2_{d.get('status')}"
            combined.append(d)
    out["combinedSignals"] = combined
    out["counts"] = {
        "v1Accepted": len(v1_res.get("accepted") or []) if v1_res else 0,
        "v1Skipped": len(v1_res.get("skipped") or []) if v1_res else 0,
        "v2Signals": len(v2_res.get("signals") or []) if v2_res else 0,
        "v2Traded": len(v2_res.get("traded") or []) if v2_res else 0,
        "combined": len(combined),
    }
    return out


def merge_parallel_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    v2_parts = [r["v2"] for r in results if r.get("v2")]
    v2_merged = merge_v2_symbol_results(v2_parts) if v2_parts else None
    combined: list[dict[str, Any]] = []
    for r in results:
        combined.extend(r.get("combinedSignals") or [])
    return {
        "mode": "parallel_v1_v2",
        "symbols": [r.get("symbol") for r in results],
        "perSymbol": results,
        "v2": v2_merged,
        "combinedSignals": combined,
        "counts": {
            "symbols": len(results),
            "combined": len(combined),
            "v2Traded": (v2_merged or {}).get("counts", {}).get("traded"),
        },
        "disclaimer": RESEARCH_DISCLAIMER,
    }
