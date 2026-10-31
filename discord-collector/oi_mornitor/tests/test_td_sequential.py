"""TD Sequential Setup + 共振特征接线。"""
from __future__ import annotations

import unittest

from oi_mornitor.confluence_features import extract_confluence_features
from oi_mornitor.signal_confluence import DEFAULT_FEATURE_WEIGHTS, compute_raw_score, compute_signal_confluence
from oi_mornitor.td_sequential import (
    attach_td_setup,
    is_td9_overbought,
    is_td9_oversold,
    td_label_zh,
    td_setup_at,
    td_setup_series,
)


class TdSequentialTests(unittest.TestCase):
    def test_sell_setup_reaches_plus_nine(self) -> None:
        base = [100.0, 100.0, 100.0, 100.0]
        up = [101.0 + i * 0.1 for i in range(9)]
        series = td_setup_series(base + up)
        self.assertEqual(series[-1], 9)
        self.assertTrue(is_td9_overbought(series[-1]))
        self.assertEqual(td_label_zh(9), "超买")

    def test_buy_setup_reaches_minus_nine(self) -> None:
        base = [100.0, 100.0, 100.0, 100.0]
        down = [99.0 - i * 0.1 for i in range(9)]
        series = td_setup_series(base + down)
        self.assertEqual(series[-1], -9)
        self.assertTrue(is_td9_oversold(series[-1]))
        self.assertEqual(td_label_zh(-9), "超卖")

    def test_equal_close_resets(self) -> None:
        closes = [10, 10, 10, 10, 11, 11, 11, 11, 11]
        # i=4: 11>10 → 1; i=5: 11>10 → 2; i=6: 11>10 → 3; i=7: 11>10 → 4; i=8: 11==11 → 0
        series = td_setup_series(closes)
        self.assertEqual(series[4], 1)
        self.assertEqual(series[8], 0)

    def test_cap_stays_at_nine_while_condition_holds(self) -> None:
        base = [100.0] * 4
        up = [110.0 + i for i in range(15)]
        series = td_setup_series(base + up)
        self.assertEqual(series[-1], 9)
        self.assertTrue(all(v <= 9 for v in series))

    def test_attach_writes_fields(self) -> None:
        alert: dict = {}
        base = [100.0] * 4
        down = [99.0 - i * 0.1 for i in range(9)]
        td = attach_td_setup(alert, base + down)
        self.assertEqual(td, -9)
        self.assertEqual(alert["tdSetup"], -9)
        self.assertEqual(alert["tdLabel"], "超卖")


class TdConfluenceTests(unittest.TestCase):
    def test_default_weights_nonzero(self) -> None:
        self.assertGreater(DEFAULT_FEATURE_WEIGHTS["feat:td9_ob"], 0)
        self.assertGreater(DEFAULT_FEATURE_WEIGHTS["feat:td9_os"], 0)
        self.assertGreater(DEFAULT_FEATURE_WEIGHTS["combo:超卖·多头形态·放量"], 0)
        self.assertGreater(DEFAULT_FEATURE_WEIGHTS["combo:超买·射击之星·放量"], 0)

    def test_oversold_hammer_volume_combo(self) -> None:
        rec = {
            "typeLabel": "倒锤子",
            "side": "long",
            "interval": "15m",
            "mcapTier": "t3",
            "vol_ratio": 1.8,
            "tdSetup": -9,
        }
        feats = extract_confluence_features(rec)
        self.assertIn("feat:td9_os", feats)
        self.assertIn("feat:vol_ratio_high", feats)
        self.assertIn("combo:超卖·多头形态·放量", feats)
        raw = compute_raw_score(feats, DEFAULT_FEATURE_WEIGHTS)
        base = dict(rec)
        base.pop("tdSetup")
        raw_no = compute_raw_score(extract_confluence_features(base), DEFAULT_FEATURE_WEIGHTS)
        self.assertGreater(raw, raw_no)

    def test_overbought_shooting_star_volume_combo(self) -> None:
        rec = {
            "typeLabel": "射击之星",
            "side": "short",
            "interval": "1h",
            "mcapTier": "t3",
            "vol_ratio": 1.5,
            "tdSetup": 9,
        }
        feats = extract_confluence_features(rec)
        self.assertIn("feat:td9_ob", feats)
        self.assertIn("combo:超买·射击之星·放量", feats)

    def test_conflict_td9_ob_with_long_ignored(self) -> None:
        rec = {
            "typeLabel": "倒锤子",
            "side": "long",
            "interval": "15m",
            "mcapTier": "t3",
            "vol_ratio": 1.8,
            "tdSetup": 9,  # 超买 vs 多头 → 忽略 TD boost
        }
        feats = extract_confluence_features(rec)
        self.assertNotIn("feat:td9_ob", feats)
        self.assertNotIn("combo:超卖·多头形态·放量", feats)
        self.assertNotIn("combo:超买·射击之星·放量", feats)

    def test_confluence_payload_runs(self) -> None:
        rec = {
            "typeLabel": "倒锤子",
            "side": "long",
            "interval": "15m",
            "mcapTier": "t3",
            "vol_ratio": 1.6,
            "tdSetup": -9,
        }
        conf = compute_signal_confluence(rec)
        self.assertIn("score", conf)
        self.assertIn("rawScore", conf)


if __name__ == "__main__":
    unittest.main()
