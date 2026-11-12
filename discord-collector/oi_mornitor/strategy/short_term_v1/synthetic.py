"""合成 K 线夹具：供单元测试与 CLI --dry-run 证明引擎能启动，不是行情预测。"""
from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.strategy.short_term_v1.engine import merge_symbol_results, run_on_frames


def make_ohlcv(
    n: int = 120,
    *,
    start_ms: int = 1_700_000_000_000,
    step_ms: int = 900_000,
    start_price: float = 100.0,
    trend: float = 0.0,
    volume: float = 1000.0,
    oi: float | None = None,
    cvd: bool = False,
) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    px = float(start_price)
    cvd_v = 0.0
    oi_v = 1_000_000.0 if oi is None else float(oi)
    for i in range(n):
        o = px
        px = px * (1.0 + trend) + ((i % 7) - 3) * 0.02
        c = max(px, 0.1)
        h = max(o, c) + 0.15
        l = min(o, c) - 0.15
        row = {
            "open_time": start_ms + i * step_ms,
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "volume": volume * (1.0 + (i % 5) * 0.1),
        }
        if oi is not None or True:
            oi_v *= 1.001
            row["oi"] = oi_v
        if cvd:
            cvd_v += (c - o) * volume
            row["cvd"] = cvd_v
        rows.append(row)
    return pd.DataFrame(rows)


def tiny_fixture_result(
    *,
    experiment: str = "E",
    fee_pct: float = 0.06,
    slippage_pct: float = 0.03,
    equity: float = 10_000.0,
) -> dict[str, Any]:
    """用合成 BTC/ETH 15m+5m 跑一遍引擎，证明 CLI 能启动。"""
    btc_15 = make_ohlcv(160, start_price=60000.0, trend=0.0004, step_ms=900_000)
    btc_4h = make_ohlcv(80, start_price=60000.0, trend=0.002, step_ms=14_400_000)
    btc_5 = make_ohlcv(480, start_price=60000.0, trend=0.0001, step_ms=300_000)
    eth_15 = make_ohlcv(160, start_price=3200.0, trend=0.0003, step_ms=900_000, cvd=True)
    eth_5 = make_ohlcv(480, start_price=3200.0, trend=0.0001, step_ms=300_000)
    eth_4h = make_ohlcv(80, start_price=3200.0, trend=0.0015, step_ms=14_400_000)
    r1 = run_on_frames(
        symbol="BTCUSDT",
        df_15m=btc_15,
        df_5m=btc_5,
        df_4h=btc_4h,
        df_btc_15m=btc_15,
        df_btc_4h=btc_4h,
        experiment=experiment,
        equity=equity,
        fee_pct=fee_pct,
        slippage_pct=slippage_pct,
        vol_30d_quote=5_000_000_000.0,
        depth=1_000_000.0,
    )
    r2 = run_on_frames(
        symbol="ETHUSDT",
        df_15m=eth_15,
        df_5m=eth_5,
        df_4h=eth_4h,
        df_btc_15m=btc_15,
        df_btc_4h=btc_4h,
        experiment=experiment,
        equity=equity,
        fee_pct=fee_pct,
        slippage_pct=slippage_pct,
        vol_30d_quote=2_000_000_000.0,
        depth=800_000.0,
    )
    merged = merge_symbol_results([r1, r2], experiment=experiment)
    merged["symbols"] = ["BTCUSDT", "ETHUSDT"]
    merged["fixture"] = "synthetic_tiny"
    return merged
