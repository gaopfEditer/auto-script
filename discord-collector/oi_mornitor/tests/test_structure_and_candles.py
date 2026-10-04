"""结构 / 蜡烛检测器、异常隔离、无前视。"""
from __future__ import annotations

import logging
import unittest
from collections import OrderedDict
from unittest.mock import patch

import numpy as np
import pandas as pd

from oi_mornitor.pattern_monitor import (
    pick_candle_card_alt_gainer_symbols,
    pick_candle_card_alt_loser_symbols,
    remember_card_seen,
)
from oi_mornitor.signal_policy import evaluate_marker_text, is_blocked_marker_text
from oi_mornitor.strategy.features import apply_vegas_mid, mark_causal_swings, vegas_a_mid
from oi_mornitor.strategy.indicators import (
    detect_hammer,
    detect_inverted_hammer,
    enrich_strategy_indicators,
    inverted_hammer_confirmed,
)
from oi_mornitor.strategy.structure_signals import (
    detect_structure_events,
    mark_swing_points,
)
from oi_mornitor.volume_price.signals import _add_htf_columns


def _ohlc_frame(n: int, *, start: float = 100.0, step: float = 0.1) -> pd.DataFrame:
    rows = []
    price = start
    t0 = 1_700_000_000_000
    for i in range(n):
        o = price
        c = price + step
        h = max(o, c) + 0.05
        l = min(o, c) - 0.05
        rows.append(
            {
                "open_time": t0 + i * 900_000,
                "close_time": t0 + i * 900_000 + 899_999,
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": 1000.0 + i,
            }
        )
        price = c
    return pd.DataFrame(rows)


class HammerRenameTest(unittest.TestCase):
    def test_long_lower_wick_is_hammer_not_inverted(self) -> None:
        row = pd.Series({"open": 100.0, "high": 100.2, "low": 97.0, "close": 99.8})
        self.assertTrue(detect_hammer(row))
        self.assertFalse(detect_inverted_hammer(row))

    def test_real_inverted_hammer_needs_next_bar(self) -> None:
        sig = pd.Series({"open": 100.0, "high": 103.0, "low": 99.8, "close": 100.2})
        nxt_ok = pd.Series({"open": 100.3, "high": 101.5, "low": 100.0, "close": 101.2})
        nxt_fail = pd.Series({"open": 100.1, "high": 100.4, "low": 99.0, "close": 99.5})
        self.assertTrue(detect_inverted_hammer(sig))
        self.assertTrue(inverted_hammer_confirmed(sig, nxt_ok))
        self.assertFalse(inverted_hammer_confirmed(sig, nxt_fail))


class SignalPolicyBonusTest(unittest.TestCase):
    def test_v_and_oi_not_blocked(self) -> None:
        self.assertFalse(is_blocked_marker_text("V锤子线"))
        self.assertFalse(is_blocked_marker_text("锤子线(oi异动)"))
        self.assertFalse(is_blocked_marker_text("V射击之星(oi异动)"))
        self.assertTrue(is_blocked_marker_text("射击之星（2）"))
        self.assertTrue(is_blocked_marker_text("连续上插针"))
        blocked, reason = evaluate_marker_text("V锤子线")
        self.assertFalse(blocked)
        self.assertEqual(reason, "")


class SwingCausalTest(unittest.TestCase):
    def test_no_center_true_lookahead(self) -> None:
        df = _ohlc_frame(40)
        # 人为做一个局部高点在 i=20，但右侧 21-23 更高 → 因果下 20 不是摆动高
        df.loc[20, "high"] = 130.0
        df.loc[21, "high"] = 131.0
        df.loc[22, "high"] = 132.0
        df.loc[23, "high"] = 133.0
        marked = mark_causal_swings(df, left=5, right=3)
        self.assertFalse(bool(marked.iloc[20]["is_swing_high"]))
        # 截断到 20 根时，20 根本无法确认（右侧不足）
        prefix = mark_causal_swings(df.iloc[:21], left=5, right=3)
        self.assertFalse(bool(prefix.iloc[20]["is_swing_high"]))

    def test_confirmed_only_after_right_bars(self) -> None:
        df = _ohlc_frame(30, step=0.0)
        df.loc[10, ["high", "close", "open"]] = [120.0, 110.0, 110.0]
        marked = mark_swing_points(df)
        self.assertTrue(bool(marked.iloc[10]["is_swing_high"]))
        self.assertEqual(int(marked.iloc[10]["swing_confirm_at"]), 13)


class DetectorIsolationTest(unittest.TestCase):
    def test_one_detector_failure_does_not_drop_others(self) -> None:
        df = enrich_strategy_indicators(_ohlc_frame(80))
        boom = RuntimeError("boom")

        def _boom(_df: pd.DataFrame) -> list:
            raise boom

        with patch(
            "oi_mornitor.strategy.structure_signals._detect_liquidity_sweep",
            side_effect=_boom,
        ), self.assertLogs(logger="oi_mornitor.strategy.structure_signals", level=logging.ERROR):
            events = detect_structure_events(df)
        self.assertIsInstance(events, list)


class NoLookaheadTest(unittest.TestCase):
    def test_structure_events_stable_after_truncation(self) -> None:
        df = enrich_strategy_indicators(_ohlc_frame(120, step=0.15))
        # 造一个浅刺前高的扫荡柱，避免依赖随机行情
        df.loc[60, "high"] = float(df.iloc[40:60]["high"].max()) * 1.005
        df.loc[60, "close"] = float(df.iloc[59]["close"]) * 0.99
        df.loc[60, "open"] = float(df.iloc[60]["close"]) + 0.4
        df.loc[60, "low"] = float(df.iloc[60]["close"]) - 0.1
        df.loc[60, "volume"] = float(df["volume"].mean()) * 3
        full = detect_structure_events(df)
        cut = detect_structure_events(df.iloc[:-8].copy())
        full_early = sorted(
            (e["kind"], int(e["bar_index"]))
            for e in full
            if int(e["bar_index"]) < len(df) - 8
        )
        cut_keys = sorted((e["kind"], int(e["bar_index"])) for e in cut)
        self.assertEqual(full_early, cut_keys)


class VegasMidTest(unittest.TestCase):
    def test_unified_definition(self) -> None:
        df = enrich_strategy_indicators(_ohlc_frame(200))
        mid = vegas_a_mid(df)
        aligned = apply_vegas_mid(df)
        pd.testing.assert_series_equal(aligned["vegas_mid"], mid, check_names=False)
        expected = (df["vegas_e1"] + df["vegas_e2"]) / 2.0
        pd.testing.assert_series_equal(df["vegas_mid"], expected, check_names=False)


class GainerLoserTest(unittest.TestCase):
    def test_split_true_boards(self) -> None:
        rows = [
            {"symbol": "AAAUSDT", "status": "ok", "rank_by_tf": {"15m": {"price": {"change_rate": 0.08}}}},
            {"symbol": "BBBUSDT", "status": "ok", "rank_by_tf": {"15m": {"price": {"change_rate": -0.12}}}},
            {"symbol": "CCCUSDT", "status": "ok", "rank_by_tf": {"15m": {"price": {"change_rate": 0.03}}}},
            {"symbol": "DDDUSDT", "status": "ok", "rank_by_tf": {"15m": {"price": {"change_rate": -0.02}}}},
        ]
        majors = {"BTCUSDT"}
        gainers = pick_candle_card_alt_gainer_symbols(rows, majors=majors, top_n=7, tf="15m")
        losers = pick_candle_card_alt_loser_symbols(rows, majors=majors, top_n=7, tf="15m")
        self.assertEqual(gainers, ["AAAUSDT", "CCCUSDT"])
        self.assertEqual(losers, ["BBBUSDT", "DDDUSDT"])


class DedupeOrderTest(unittest.TestCase):
    def test_trim_keeps_newest_insertion_order(self) -> None:
        seen: OrderedDict[str, bool] = OrderedDict()
        for i in range(10):
            remember_card_seen(seen, f"k{i}", high_water=8, keep=4)
        # 越过 high_water 后裁到 keep；其后未再超过水位则保留后续新键
        self.assertEqual(list(seen.keys()), ["k5", "k6", "k7", "k8", "k9"])


class HtfCloseTimeTest(unittest.TestCase):
    def test_15m_does_not_see_unclosed_1h(self) -> None:
        # 1h 开于 00:00 收于 00:59:59；15m 00:15-00:29 不得用这根 1h
        rows_15 = []
        t0 = 1_700_000_000_000
        for i in range(8):
            ts = t0 + i * 900_000
            rows_15.append(
                {
                    "ts": ts,
                    "close_time": ts + 899_999,
                    "symbol": "BTCUSDT",
                    "tf": "15m",
                    "open": 100.0,
                    "high": 101.0,
                    "low": 99.0,
                    "close": 100.0 + i,
                    "volume": 10.0,
                }
            )
        h1 = pd.DataFrame(
            [
                {
                    "ts": t0,
                    "close_time": t0 + 3_599_999,
                    "symbol": "BTCUSDT",
                    "tf": "1h",
                    "open": 100.0,
                    "high": 110.0,
                    "low": 90.0,
                    "close": 200.0,
                    "volume": 100.0,
                },
                {
                    "ts": t0 - 3_600_000,
                    "close_time": t0 - 1,
                    "symbol": "BTCUSDT",
                    "tf": "1h",
                    "open": 90.0,
                    "high": 91.0,
                    "low": 89.0,
                    "close": 90.0,
                    "volume": 100.0,
                },
            ]
        )
        left = pd.DataFrame(rows_15)
        merged = _add_htf_columns(left, h1, "h1")
        mid = merged[merged["ts"] == t0 + 900_000].iloc[0]
        self.assertAlmostEqual(float(mid["h1_ema"]), 90.0, places=6)
        last = merged[merged["ts"] == t0 + 3 * 900_000].iloc[0]
        self.assertGreater(float(last["h1_ema"]), 90.0)


if __name__ == "__main__":
    unittest.main()
