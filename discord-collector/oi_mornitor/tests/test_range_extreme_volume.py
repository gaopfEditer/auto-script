"""区间极值末端放量 + 共振特征接线。"""
from __future__ import annotations

import unittest

from oi_mornitor.confluence_features import extract_confluence_features
from oi_mornitor.range_extreme_volume import (
    attach_range_extreme_volume,
    is_rev_buy,
    is_rev_sell,
    range_extreme_signal_series,
    rev_vol_label_zh,
)
from oi_mornitor.signal_confluence import DEFAULT_FEATURE_WEIGHTS, compute_raw_score, compute_signal_confluence


def _flat(n: int = 130):
    opens = [100.0] * n
    highs = [101.0] * n
    lows = [99.0] * n
    closes = [100.0] * n
    volumes = [1000.0] * n
    return opens, highs, lows, closes, volumes


class RangeExtremeVolumeTests(unittest.TestCase):
    def test_buy_at_new_low_end_with_volume(self) -> None:
        opens, highs, lows, closes, volumes = _flat()
        i = len(opens) - 1
        lows[i] = 90.0
        highs[i] = 102.0
        opens[i] = 95.0
        closes[i] = 101.0
        volumes[i] = 5000.0
        lows[i - 1] = 91.0
        series = range_extreme_signal_series(highs, lows, opens, closes, volumes)
        self.assertEqual(series[i], 1)
        self.assertTrue(is_rev_buy(series[i]))
        self.assertEqual(rev_vol_label_zh(1), "新低末端放量买")

    def test_sell_at_new_high_end_with_volume(self) -> None:
        opens, highs, lows, closes, volumes = _flat()
        i = len(opens) - 1
        highs[i] = 110.0
        lows[i] = 98.0
        opens[i] = 108.0
        closes[i] = 99.0
        volumes[i] = 5000.0
        highs[i - 1] = 109.0
        series = range_extreme_signal_series(highs, lows, opens, closes, volumes)
        self.assertEqual(series[i], -1)
        self.assertTrue(is_rev_sell(series[i]))
        self.assertEqual(rev_vol_label_zh(-1), "新高末端放量卖")

    def test_no_signal_without_volume(self) -> None:
        opens, highs, lows, closes, volumes = _flat()
        i = len(opens) - 1
        lows[i] = 90.0
        highs[i] = 102.0
        opens[i] = 95.0
        closes[i] = 101.0
        volumes[i] = 1000.0  # 未放量
        series = range_extreme_signal_series(highs, lows, opens, closes, volumes)
        self.assertEqual(series[i], 0)

    def test_signal_cooldown_blocks_repeat_buy(self) -> None:
        opens, highs, lows, closes, volumes = _flat(140)
        # 连续两根满足买条件；第二根因冷却应为 0
        for j in (137, 138):
            lows[j] = 90.0 - (j - 137) * 0.5
            highs[j] = 102.0
            opens[j] = 95.0
            closes[j] = 101.0
            volumes[j] = 5000.0
        series = range_extreme_signal_series(highs, lows, opens, closes, volumes)
        buys = [i for i, s in enumerate(series) if s == 1]
        self.assertGreaterEqual(len(buys), 1)
        # 任意两买入信号间距应 > 4（冷却窗口）
        for a, b in zip(buys, buys[1:]):
            self.assertGreater(b - a, 4)

    def test_attach_writes_fields(self) -> None:
        opens, highs, lows, closes, volumes = _flat()
        i = len(opens) - 1
        lows[i] = 90.0
        highs[i] = 102.0
        opens[i] = 95.0
        closes[i] = 101.0
        volumes[i] = 5000.0
        alert: dict = {}
        sig = attach_range_extreme_volume(
            alert, opens=opens, highs=highs, lows=lows, closes=closes, volumes=volumes
        )
        self.assertEqual(sig, 1)
        self.assertEqual(alert["revVolSignal"], 1)
        self.assertEqual(alert["revVolLabel"], "新低末端放量买")


class RevVolConfluenceTests(unittest.TestCase):
    def test_default_weights_nonzero(self) -> None:
        self.assertGreater(DEFAULT_FEATURE_WEIGHTS["feat:rev_nl_buy"], 0)
        self.assertGreater(DEFAULT_FEATURE_WEIGHTS["feat:rev_nh_sell"], 0)
        self.assertGreater(DEFAULT_FEATURE_WEIGHTS["combo:新低放量·倒锤子"], 0)
        self.assertGreater(DEFAULT_FEATURE_WEIGHTS["combo:新高放量·射击之星"], 0)
        self.assertGreater(DEFAULT_FEATURE_WEIGHTS["combo:新低放量·超卖·倒锤子"], 0)
        self.assertGreater(DEFAULT_FEATURE_WEIGHTS["combo:新高放量·超买·射星"], 0)

    def test_buy_hammer_combo(self) -> None:
        rec = {
            "typeLabel": "倒锤子",
            "side": "long",
            "interval": "15m",
            "mcapTier": "t3",
            "vol_ratio": 1.8,
            "revVolSignal": 1,
        }
        feats = extract_confluence_features(rec)
        self.assertIn("feat:rev_nl_buy", feats)
        self.assertIn("combo:新低放量·倒锤子", feats)
        raw = compute_raw_score(feats, DEFAULT_FEATURE_WEIGHTS)
        base = dict(rec)
        base.pop("revVolSignal")
        raw_no = compute_raw_score(extract_confluence_features(base), DEFAULT_FEATURE_WEIGHTS)
        self.assertGreater(raw, raw_no)

    def test_buy_with_td9_triple(self) -> None:
        rec = {
            "typeLabel": "倒锤子",
            "side": "long",
            "interval": "15m",
            "mcapTier": "t3",
            "vol_ratio": 1.8,
            "revVolSignal": 1,
            "tdSetup": -9,
        }
        feats = extract_confluence_features(rec)
        self.assertIn("combo:新低放量·超卖·倒锤子", feats)
        self.assertIn("feat:td9_os", feats)

    def test_sell_shooting_star_combo(self) -> None:
        rec = {
            "typeLabel": "射击之星",
            "side": "short",
            "interval": "1h",
            "mcapTier": "t3",
            "vol_ratio": 1.5,
            "revVolSignal": -1,
            "tdSetup": 9,
        }
        feats = extract_confluence_features(rec)
        self.assertIn("feat:rev_nh_sell", feats)
        self.assertIn("combo:新高放量·射击之星", feats)
        self.assertIn("combo:新高放量·超买·射星", feats)

    def test_conflict_sell_with_long_ignored(self) -> None:
        rec = {
            "typeLabel": "倒锤子",
            "side": "long",
            "interval": "15m",
            "mcapTier": "t3",
            "vol_ratio": 1.8,
            "revVolSignal": -1,  # 卖 vs 多 → 忽略
        }
        feats = extract_confluence_features(rec)
        self.assertNotIn("feat:rev_nh_sell", feats)
        self.assertNotIn("feat:rev_nl_buy", feats)
        self.assertNotIn("combo:新低放量·倒锤子", feats)
        self.assertNotIn("combo:新高放量·射击之星", feats)

    def test_confluence_payload_runs(self) -> None:
        rec = {
            "typeLabel": "倒锤子",
            "side": "long",
            "interval": "15m",
            "mcapTier": "t3",
            "vol_ratio": 1.6,
            "revVolSignal": 1,
        }
        conf = compute_signal_confluence(rec)
        self.assertIn("score", conf)
        self.assertIn("rawScore", conf)


if __name__ == "__main__":
    unittest.main()
