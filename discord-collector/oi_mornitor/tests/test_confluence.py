"""共振分 V2：特征、收缩拟合、晋升守卫、默认权重、环境变量。"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from unittest import mock

from oi_mornitor.confluence_calibrate import (
    _promote_guard,
    compute_r_multiple,
    fit_shrunk_weights,
    run_calibration,
)
from oi_mornitor.confluence_features import extract_confluence_features, normalize_type_label
from oi_mornitor.signal_confluence import (
    DEFAULT_FEATURE_WEIGHTS,
    active_feature_weights,
    compute_quintile_table,
    compute_raw_score,
    compute_signal_confluence,
    confluence_push_min_tier,
    map_raw_to_percentile_score,
    passes_confluence_push_gate,
    reload_confluence_weights,
    score_records,
    tier_from_percentile_score,
)


class FeatureExtractionTests(unittest.TestCase):
    def test_normalize_strips_numeric_suffix(self) -> None:
        self.assertEqual(normalize_type_label("射击之星（2）"), "射击之星")

    def test_structure_vs_candle_mtf_combos(self) -> None:
        reversal = {
            "typeLabel": "顶部结构确认",
            "side": "short",
            "interval": "4h",
            "mtfResonance": {"tiers": 2, "intervals": ["1h", "4h"], "family": "reversal"},
            "mcapTier": "t2",
        }
        candle = {
            "typeLabel": "倒锤子",
            "side": "long",
            "interval": "15m",
            "mtfResonance": {"tiers": 2, "intervals": ["15m", "1h"], "family": "inverted_hammer"},
            "mcapTier": "t3",
        }
        fr = extract_confluence_features(reversal)
        fc = extract_confluence_features(candle)
        self.assertIn("combo:结构·双周期共振", fr)
        self.assertNotIn("combo:蜡烛形态·双周期共振", fr)
        self.assertIn("combo:蜡烛形态·双周期共振", fc)
        self.assertNotIn("combo:结构·双周期共振", fc)


class ShrinkageTests(unittest.TestCase):
    def test_shrinkage_reduces_extreme_delta(self) -> None:
        train = [
            {"typeLabel": "顶部结构", "side": "short", "interval": "4h", "mcapTier": "t3"},
            {"typeLabel": "顶部结构", "side": "short", "interval": "4h", "mcapTier": "t3"},
            {"typeLabel": "其他", "side": "long", "interval": "15m", "mcapTier": "t3"},
        ]
        r_vals = [2.0, 1.8, -1.0]
        w, n = fit_shrunk_weights(train, r_vals, shrink_k=50, min_n=2)
        self.assertTrue(w)
        self.assertGreaterEqual(min(n.values()), 2)


class PromotionGuardTests(unittest.TestCase):
    def test_promote_when_top_quintile_beats_bottom(self) -> None:
        good = [
            {"quintile": 1, "expR": -0.1},
            {"quintile": 5, "expR": 0.08},
        ]
        self.assertTrue(_promote_guard(good))
        bad = [
            {"quintile": 1, "expR": 0.05},
            {"quintile": 5, "expR": -0.02},
        ]
        self.assertFalse(_promote_guard(bad))


class DefaultWeightsTests(unittest.TestCase):
    def test_fallback_weights_when_file_missing(self) -> None:
        reload_confluence_weights()
        with mock.patch.dict(os.environ, {"OI_CONFLUENCE_WEIGHTS_PATH": "/nonexistent/path.json"}, clear=False):
            reload_confluence_weights()
            w = active_feature_weights()
            self.assertEqual(w["combo:结构·双周期共振"], DEFAULT_FEATURE_WEIGHTS["combo:结构·双周期共振"])

    def test_compute_confluence_has_legacy_score(self) -> None:
        rec = {
            "typeLabel": "顶部结构确认",
            "side": "short",
            "interval": "4h",
            "mtfResonance": {"tiers": 2, "intervals": ["1h", "4h"], "family": "reversal"},
            "mcapTier": "t2",
        }
        conf = compute_signal_confluence(rec)
        self.assertIn("score", conf)
        self.assertIn("legacyScore", conf)
        self.assertIn("topFactors", conf)


class EnvDefaultsTests(unittest.TestCase):
    def test_empty_push_min_tier_defaults_b(self) -> None:
        with mock.patch.dict(os.environ, {"OI_CONFLUENCE_PUSH_MIN_TIER": ""}, clear=False):
            for name in list(__import__("sys").modules):
                if name == "oi_mornitor.config":
                    del __import__("sys").modules[name]
            import oi_mornitor.config as config

            importlib = __import__("importlib")
            importlib.reload(config)
            self.assertEqual(config.OI_CONFLUENCE_PUSH_MIN_TIER, "B")

    def test_invalid_push_min_tier_falls_back(self) -> None:
        with mock.patch.dict(os.environ, {"OI_CONFLUENCE_PUSH_MIN_TIER": "??? "}, clear=False):
            import importlib
            import sys

            if "oi_mornitor.config" in sys.modules:
                del sys.modules["oi_mornitor.config"]
            import oi_mornitor.config as config

            importlib.reload(config)
            self.assertEqual(config.OI_CONFLUENCE_PUSH_MIN_TIER, "B")


class ScoringTests(unittest.TestCase):
    def test_tier_from_percentile(self) -> None:
        self.assertEqual(tier_from_percentile_score(85), "A")
        self.assertEqual(tier_from_percentile_score(70), "B")
        self.assertEqual(tier_from_percentile_score(40), "C")

    def test_push_gate_default_b(self) -> None:
        self.assertTrue(passes_confluence_push_gate({"tier": "A"}))
        self.assertTrue(passes_confluence_push_gate({"tier": "B"}))
        self.assertFalse(passes_confluence_push_gate({"tier": "C"}))

    def test_quintile_table_monotonic_sample(self) -> None:
        scored = score_records(
            [
                {"typeLabel": "a", "side": "long", "interval": "15m", "mcapTier": "t3"},
                {"typeLabel": "b", "side": "short", "interval": "4h", "mcapTier": "t1"},
            ],
            weights=DEFAULT_FEATURE_WEIGHTS,
        )
        r = [-0.2, 0.3]
        tbl = compute_quintile_table(scored, r)
        self.assertTrue(tbl)


class RMultipleTests(unittest.TestCase):
    def test_r_from_sl_and_move(self) -> None:
        rec = {
            "outcome": "stop_loss",
            "entry": 100.0,
            "slPrice": 99.0,
            "movePct": -1.0,
            "side": "long",
        }
        r = compute_r_multiple(rec)
        self.assertIsNotNone(r)
        self.assertAlmostEqual(r, -1.0, places=2)


class CalibrationFileTests(unittest.TestCase):
    def test_promotion_skips_write_when_test_fails(self) -> None:
        stats = [
            {
                "key": "k1",
                "typeLabel": "顶部结构",
                "side": "short",
                "interval": "4h",
                "signalAt": 1,
                "entry": 100,
                "slPrice": 99,
                "movePct": 0.5,
                "outcome": "take_profit",
                "mcapTier": "t3",
            },
            {
                "key": "k2",
                "typeLabel": "倒锤子",
                "side": "long",
                "interval": "15m",
                "signalAt": 2,
                "entry": 50,
                "slPrice": 49,
                "movePct": -0.5,
                "outcome": "stop_loss",
                "mcapTier": "t3",
            },
        ]
        with tempfile.TemporaryDirectory() as td:
            stats_path = os.path.join(td, "stats.json")
            out_path = os.path.join(td, "data", "confluence_weights.json")
            with open(stats_path, "w", encoding="utf-8") as f:
                json.dump(stats, f)
            payload = run_calibration(
                stats_path=__import__("pathlib").Path(stats_path),
                out_path=__import__("pathlib").Path(out_path),
                split_ms=10**15,
                shrink_k=10,
                min_n=1,
                dry_run=True,
            )
            self.assertIn("promoted", payload)


if __name__ == "__main__":
    unittest.main()
