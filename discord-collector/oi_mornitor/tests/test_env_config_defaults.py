"""空 .env / 空字符串 / 非法值时，PR #3–#5 相关配置须回退安全默认。"""
from __future__ import annotations

import importlib
import os
import sys
import unittest
from unittest import mock

_PR3_KEYS = [
    "OI_CANDLE_SHOOT_REQUIRE_POSITION",
    "OI_CANDLE_SHOOT_TREND_LOOKBACK",
    "OI_CANDLE_SHOOT_TREND_MIN_PCT",
    "OI_CANDLE_HAMMER_TREND_LOOKBACK",
    "OI_CANDLE_HAMMER_TREND_MIN_PCT",
    "OI_CANDLE_VOL_BYPASS_CONTEXT",
    "OI_CANDLE_1H_HTF_TREND_ENABLED",
    "OI_CANDLE_1H_HTF_TREND_LOOKBACK",
    "OI_CANDLE_1H_HTF_TREND_MIN_PCT",
    "OI_CANDLE_CARD_REQUIRE_VOL",
    "OI_CANDLE_CARD_VOL_MULT",
    "OI_CANDLE_CARD_VOL_LOOKBACK",
    "OI_MAIN_CARD_VOL_LOOKBACK",
    "OI_MAIN_CARD_VOL_MULT",
    "OI_PATTERN_PUSH_MTF_MIN",
    "OI_PATTERN_SL_MIN_PCT",
    "OI_PATTERN_SL_MIN_PCT_MAJOR",
    "OI_PATTERN_15M_VERIFY_H",
    "OI_SETTLE_ATR_K_T1",
    "OI_SETTLE_ATR_K_T2",
    "OI_SETTLE_ATR_K_T3",
    "OI_SETTLE_CAP_T1",
    "OI_SETTLE_CAP_T2",
    "OI_SETTLE_CAP_T3",
    "OI_CONFLUENCE_PUSH_MIN_TIER",
    "OI_CONFLUENCE_SHRINK_K",
    "OI_CONFLUENCE_MIN_N",
    "OI_CONFLUENCE_SPLIT_AT",
    "OI_CONFLUENCE_WEIGHTS_PATH",
]


def _reload_config_modules():
    for name in list(sys.modules):
        if name == "oi_mornitor.config" or name.startswith("oi_mornitor.candle_card_config"):
            del sys.modules[name]
    import oi_mornitor.config as config
    import oi_mornitor.candle_card_config as candle_card_config
    import oi_mornitor.pattern_settle_profile as pattern_settle_profile

    importlib.reload(config)
    importlib.reload(candle_card_config)
    importlib.reload(pattern_settle_profile)
    return config, candle_card_config, pattern_settle_profile


class EnvConfigDefaultsTests(unittest.TestCase):
    def test_empty_env_strings_use_safe_defaults(self) -> None:
        blank = {k: "" for k in _PR3_KEYS}
        with mock.patch.dict(os.environ, blank, clear=False):
            config, candle_cfg, settle = _reload_config_modules()
            self.assertTrue(config.CANDLE_SHOOT_REQUIRE_POSITION)
            self.assertEqual(config.CANDLE_SHOOT_TREND_LOOKBACK, 20)
            self.assertEqual(config.CANDLE_SHOOT_TREND_MIN_PCT, 3.0)
            self.assertFalse(config.CANDLE_VOL_BYPASS_CONTEXT)
            self.assertTrue(config.CANDLE_1H_HTF_TREND_ENABLED)
            self.assertEqual(config.OI_PATTERN_PUSH_MTF_MIN, 2)
            self.assertEqual(config.OI_PATTERN_SL_MIN_PCT, 0.8)
            self.assertEqual(config.OI_PATTERN_SL_MIN_PCT_MAJOR, 0.4)
            self.assertEqual(config.OI_PATTERN_15M_VERIFY_H, 6.0)
            self.assertEqual(config.OI_PATTERN_15M_VERIFY_MS, 6 * 3600 * 1000)
            self.assertEqual(candle_cfg.CANDLE_CARD_VOL_MULT, 1.2)
            self.assertEqual(candle_cfg.MAIN_CARD_VOL_LOOKBACK, 3)
            rec = {"interval": "15m", "tradeSymbol": "ETHUSDT"}
            self.assertEqual(settle.resolve_verify_delay_ms(rec), 6 * 3600 * 1000)

    def test_invalid_numeric_env_falls_back(self) -> None:
        bad = {
            "OI_PATTERN_PUSH_MTF_MIN": "nope",
            "OI_PATTERN_SL_MIN_PCT": "NaN",
            "OI_PATTERN_15M_VERIFY_H": "???",
            "OI_CANDLE_CARD_VOL_MULT": "",
        }
        with mock.patch.dict(os.environ, bad, clear=False):
            config, _, _ = _reload_config_modules()
            self.assertEqual(config.OI_PATTERN_PUSH_MTF_MIN, 2)
            self.assertEqual(config.OI_PATTERN_SL_MIN_PCT, 0.8)
            self.assertEqual(config.OI_PATTERN_15M_VERIFY_H, 6.0)
            self.assertEqual(config.CANDLE_CARD_VOL_MULT, 1.2)
            self.assertEqual(config.OI_CONFLUENCE_PUSH_MIN_TIER, "B")
            self.assertEqual(config.OI_CONFLUENCE_SHRINK_K, 50)
            self.assertEqual(config.OI_CONFLUENCE_MIN_N, 30)


if __name__ == "__main__":
    unittest.main()
