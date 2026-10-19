"""维加斯顺势检测。"""
from __future__ import annotations

import pandas as pd

from oi_mornitor.trendline.signals import enrich_trendline_indicators
from oi_mornitor.vegas_trend.detect import evaluate_vegas_trend_at_bar


def _uptrend_df(n: int = 200) -> pd.DataFrame:
    rows = []
    t0 = 1_760_000_000_000
    price = 100.0
    for i in range(n):
        price += 0.08
        o = price - 0.05
        c = price
        if i % 17 == 0:
            l = price - 2.5
            h = price + 0.2
        else:
            l = price - 0.4
            h = price + 0.3
        rows.append(
            {
                "open_time": t0 + i * 3_600_000,
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": 2000 if i % 17 == 0 else 800,
                "close_time": t0 + i * 3_600_000 + 3_599_999,
                "quote_volume": 1e6,
            }
        )
    return enrich_trendline_indicators(pd.DataFrame(rows))


def test_evaluate_vegas_trend_runs_without_error() -> None:
    df = _uptrend_df(220)
    hit = evaluate_vegas_trend_at_bar(df, len(df) - 1, symbol="BTCUSDT", interval="1h")
    assert hit is None or hit.get("trade_side") in ("long", "short")
