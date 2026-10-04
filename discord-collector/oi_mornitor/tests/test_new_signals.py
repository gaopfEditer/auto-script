"""新检测器、打分、共振、无前视。"""
from __future__ import annotations

import unittest

import pandas as pd

from oi_mornitor.strategy.divergence import detect_macd_divergence
from oi_mornitor.strategy.features import add_core_features
from oi_mornitor.strategy.ma_confluence import detect_ma_confluence
from oi_mornitor.strategy.resonance import daily_against, resonate
from oi_mornitor.strategy.scan_all import collect_all_events
from oi_mornitor.strategy.scoring import score_side
from oi_mornitor.strategy.wyckoff_signals import detect_wyckoff_events
from oi_mornitor.tests.test_structure_and_candles import _ohlc_frame


class NewDetectorsTest(unittest.TestCase):
    def test_modules_run_and_isolate(self) -> None:
        df = add_core_features(_ohlc_frame(220, step=0.2))
        self.assertIsInstance(detect_wyckoff_events(df), list)
        self.assertIsInstance(detect_macd_divergence(df), list)
        self.assertIsInstance(detect_ma_confluence(df), list)
        evs = collect_all_events(df)
        self.assertIsInstance(evs, list)

    def test_no_lookahead_new_stack(self) -> None:
        df = add_core_features(_ohlc_frame(260, step=-0.05))
        full = [e for e in collect_all_events(df) if int(e["bar_index"]) < len(df) - 12]
        cut = collect_all_events(df.iloc[:-12].copy())
        key = lambda e: (e.get("kind"), int(e.get("bar_index") or -1), e.get("side"))
        self.assertEqual(sorted(key(e) for e in full), sorted(key(e) for e in cut))


class ScoringResonanceTest(unittest.TestCase):
    def test_score_and_grades(self) -> None:
        events = [
            {"kind": "hammer", "side": "long", "strength": 0.8, "bar_index": 10, "tags": {"near_vegas": True}},
            {"kind": "vp_div_bottom", "side": "long", "strength": 0.7, "bar_index": 10},
            {"kind": "macd_bull_div", "side": "long", "strength": 0.6, "bar_index": 10},
        ]
        s = score_side(events, side="long", tf="1h", asof_idx=10)
        self.assertGreater(s["score"], 0)
        scores = {
            "15m": {"long": 55, "short": 10},
            "1h": {"long": 70, "short": 12},
            "4h": {"long": 80, "short": 8},
            "1d": {"long": 40, "short": 20},
        }
        r = resonate(scores, side="long")
        self.assertEqual(r["grade"], "A")
        self.assertIsNone(r["reject_reason"])

    def test_daily_against_downgrade(self) -> None:
        self.assertTrue(daily_against(20, "long", 70))
        scores = {
            "15m": {"long": 55, "short": 10},
            "1h": {"long": 60, "short": 12},
            "4h": {"long": 70, "short": 8},
            "1d": {"long": 20, "short": 70},
        }
        r = resonate(scores, side="long")
        self.assertEqual(r["grade"], "C")
        self.assertEqual(r["reject_reason"], "daily_against")


class ReplaySmokeTest(unittest.TestCase):
    def test_replay_synthetic(self) -> None:
        from oi_mornitor.backtest.replay import replay_symbol_tf

        df = _ohlc_frame(300, step=0.05)
        klines = []
        for _, row in df.iterrows():
            klines.append(
                [
                    int(row["open_time"]),
                    row["open"],
                    row["high"],
                    row["low"],
                    row["close"],
                    row["volume"],
                    int(row["close_time"]),
                    0,
                ]
            )
        result = replay_symbol_tf(klines, symbol="AAAUSDT", tf="15m")
        self.assertIn("trades", result)
        self.assertIn("random_trades", result)


if __name__ == "__main__":
    unittest.main()
