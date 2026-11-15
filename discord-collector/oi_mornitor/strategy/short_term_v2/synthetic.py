"""V2 / 并行 dry-run 合成夹具。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.strategy.short_term_v1.synthetic import make_ohlcv
from oi_mornitor.strategy.short_term_v2.engine import collect_signals_on_frames, merge_v2_symbol_results
from oi_mornitor.strategy.short_term_v2.parallel import merge_parallel_results, run_parallel_on_frames


def tiny_v2_fixture(*, fee_pct: float = 0.06, slip_pct: float = 0.03) -> dict[str, Any]:
    btc_15 = make_ohlcv(200, start_price=60000.0, trend=0.0005, step_ms=900_000, oi=2_000_000.0)
    btc_1h = make_ohlcv(120, start_price=60000.0, trend=0.001, step_ms=3_600_000, oi=2_000_000.0)
    btc_4h = make_ohlcv(80, start_price=60000.0, trend=0.002, step_ms=14_400_000)
    # 人为制造一根放量突破
    i = 120
    btc_15.loc[i, "high"] = float(btc_15.loc[i - 1, "close"]) * 1.02
    btc_15.loc[i, "close"] = float(btc_15.loc[i - 1, "close"]) * 1.015
    btc_15.loc[i, "volume"] = float(btc_15.loc[i, "volume"]) * 5
    btc_15.loc[i, "oi"] = float(btc_15.loc[i - 1, "oi"]) * 1.06
    r = collect_signals_on_frames(
        symbol="BTCUSDT",
        df_15m=btc_15,
        df_1h=btc_1h,
        df_4h=btc_4h,
        vol_30d_quote=5e9,
        depth=2e6,
        fee_pct=fee_pct,
        slip_pct=slip_pct,
    )
    return merge_v2_symbol_results([r])


def tiny_parallel_fixture(
    *,
    fee_pct: float = 0.06,
    slip_pct: float = 0.03,
    equity: float = 10_000.0,
) -> dict[str, Any]:
    btc_15 = make_ohlcv(180, start_price=60000.0, trend=0.0004, step_ms=900_000, oi=2e6)
    btc_5 = make_ohlcv(540, start_price=60000.0, trend=0.0001, step_ms=300_000)
    btc_1h = make_ohlcv(100, start_price=60000.0, trend=0.001, step_ms=3_600_000, oi=2e6)
    btc_4h = make_ohlcv(60, start_price=60000.0, trend=0.002, step_ms=14_400_000)
    one = run_parallel_on_frames(
        symbol="BTCUSDT",
        df_15m=btc_15,
        df_5m=btc_5,
        df_1h=btc_1h,
        df_4h=btc_4h,
        df_btc_15m=btc_15,
        df_btc_4h=btc_4h,
        vol_30d_quote=5e9,
        depth=2e6,
        fee_pct=fee_pct,
        slippage_pct=slip_pct,
        equity=equity,
    )
    return merge_parallel_results([one])
