"""摆动结构强弱软评分单测。"""

import unittest

import numpy as np
import pandas as pd

from oi_mornitor.strategy.structure_market_bias import (
    _compare_high_swings,
    _compare_low_swings,
    evaluate_market_structure_bias,
    find_structure_bias_hit,
    is_counter_structure_signal,
)


def _zigzag_df(
    peak_heights: list[float],
    *,
    bars_per_leg: int = 14,
    swing_order: int = 3,
) -> pd.DataFrame:
    """构造明显摆动高低点（峰顶高度逐 leg 可变）。"""
    n = bars_per_leg * len(peak_heights) + swing_order * 4
    highs = np.full(n, -np.inf)
    lows = np.full(n, np.inf)
    for leg, peak in enumerate(peak_heights):
        peak_i = swing_order * 2 + leg * bars_per_leg + 4
        trough_i = peak_i + bars_per_leg // 2
        trough = peak - 600 - leg * 20
        for i in range(n):
            if abs(i - peak_i) <= swing_order:
                highs[i] = max(highs[i], peak - abs(i - peak_i) * 5)
            if abs(i - trough_i) <= swing_order:
                lows[i] = min(lows[i], trough + abs(i - trough_i) * 5)
    highs = np.where(np.isfinite(highs), highs, np.nan)
    lows = np.where(np.isfinite(lows), lows, np.nan)
    highs = pd.Series(highs).ffill().bfill().to_numpy()
    lows = pd.Series(lows).ffill().bfill().to_numpy()
    for i in range(n):
        if lows[i] >= highs[i]:
            lows[i] = highs[i] - 400
    closes = (highs + lows) / 2
    opens = closes * 0.999
    return pd.DataFrame(
        {
            "open_time": np.arange(n, dtype=np.int64) * 900_000,
            "open": opens,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": np.full(n, 1000.0),
        }
    )


class StructureMarketBiasTests(unittest.TestCase):
    def test_descending_highs_detect_bear_bias(self) -> None:
        """三连降低反弹高点 → 走弱（对应用户截图场景）。"""
        df = _zigzag_df([82400, 82000, 81800, 81600], swing_order=3)
        ev = evaluate_market_structure_bias(df, swing_order=3, pairs_lookback=3)
        self.assertEqual(ev["bias"], "bear")
        self.assertGreaterEqual(ev["score"], 55)
        self.assertIn("LH", "".join(ev["high_tags"]))

    def test_compare_swings_bull_votes(self) -> None:
        hi_tags, hi_bull, hi_bear = _compare_high_swings([100, 104, 108])
        lo_tags, lo_bull, lo_bear = _compare_low_swings([90, 93, 96])
        self.assertIn("HH", hi_tags)
        self.assertIn("HL", lo_tags)
        self.assertGreaterEqual(hi_bull + lo_bull, 2)
        self.assertGreater(hi_bull + lo_bull, hi_bear + lo_bear)

    def test_closed_bar_hit(self) -> None:
        df = _zigzag_df([120, 115, 110, 105], swing_order=3)
        now_ms = int(df.iloc[-1]["open_time"]) + 900_000
        hit = find_structure_bias_hit(df, now_ms=now_ms, min_score=50)
        self.assertIsNotNone(hit)
        self.assertEqual(hit.get("side"), "bear")

    def test_counter_structure_signal(self) -> None:
        self.assertTrue(
            is_counter_structure_signal("long", "bear", 60),
        )
        self.assertFalse(
            is_counter_structure_signal("short", "bear", 60),
        )


if __name__ == "__main__":
    unittest.main()
