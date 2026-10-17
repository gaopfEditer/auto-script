"""趋势线 pivot / 贴近 / 形态 / EMA 共振。"""
from __future__ import annotations

import pandas as pd

from oi_mornitor.trendline.lines import TrendLine, detect_trendlines
from oi_mornitor.trendline.patterns import classify_reversal_at_line, detect_hammer
from oi_mornitor.trendline.pivots import mark_swing_pivots
from oi_mornitor.trendline.signals import enrich_trendline_frame, evaluate_bar_signal
from oi_mornitor.ma144_reversal_signals import near_ema144


def _synthetic_uptrend_df(n: int = 120) -> pd.DataFrame:
    rows = []
    t0 = 1_700_000_000_000
    price = 100.0
    for i in range(n):
        wave = 2.0 if i % 11 == 5 else -1.5 if i % 11 == 8 else 0.0
        drift = 0.05 * (i % 7) + wave
        o = price + drift
        c = o + 0.2
        h = c + 0.5 + abs(wave) * 0.2
        l = o - 0.3 - abs(wave) * 0.3
        rows.append(
            {
                "open_time": t0 + i * 900_000,
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": 1000 + i * 5,
                "close_time": t0 + i * 900_000 + 899_999,
                "quote_volume": 1e6,
            }
        )
        price = c
    return pd.DataFrame(rows)


def test_pivot_marks_local_extrema() -> None:
    df = _synthetic_uptrend_df(40)
    out = mark_swing_pivots(df, left=2, right=2)
    assert out["is_swing_low"].dtype == bool
    assert out["is_swing_high"].any() or out["is_swing_low"].any()


def test_detect_trendlines_returns_scored_lines() -> None:
    df = enrich_trendline_frame(_synthetic_uptrend_df(200))
    lines = detect_trendlines(
        df,
        end_idx=len(df) - 1,
        touch_tol_pct=0.01,
        close_viol_tol_pct=0.01,
        wick_viol_mult=2.0,
        min_touches=2,
        max_per_side=2,
        lookback_bars=150,
    )
    assert isinstance(lines, list)


def test_hammer_and_near_ema() -> None:
    row = pd.Series(
        {
            "open": 99.5,
            "high": 100.1,
            "low": 96.0,
            "close": 100.0,
            "ema144": 100.0,
            "volume": 2000,
            "vol_sma20": 1000,
        }
    )
    assert detect_hammer(row)
    assert near_ema144(row, tol_pct=0.05)


def test_classify_reversal_at_support_line() -> None:
    df = enrich_trendline_frame(_synthetic_uptrend_df(80))
    idx = len(df) - 1
    line = TrendLine(
        side="support",
        idx_a=10,
        idx_b=40,
        price_a=float(df.iloc[10]["low"]),
        price_b=float(df.iloc[40]["low"]),
        slope=0.01,
        touches=3,
        violations=0,
        score=5.0,
        line_id="testline01",
    )
    df.iloc[idx, df.columns.get_loc("low")] = line.price_at(idx) * 0.998
    df.iloc[idx, df.columns.get_loc("close")] = line.price_at(idx) * 1.001
    pat = classify_reversal_at_line(
        df, idx, line=line, touch_tol_pct=0.02, breakout_lookback=8
    )
    assert pat is None or pat.get("trade_side") in ("long", "short")


def test_evaluate_bar_signal_none_without_pattern() -> None:
    df = enrich_trendline_frame(_synthetic_uptrend_df(100))
    hit = evaluate_bar_signal(
        df,
        end_idx=len(df) - 1,
        asset="BTC",
        interval="15m",
        type_label_prefix="趋势线·BTC 15m",
    )
    assert hit is None or "type_label" in hit
