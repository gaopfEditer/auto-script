"""candle_card_policy 白名单测试。"""
from __future__ import annotations

import importlib
import os
import unittest
from unittest import mock

import oi_mornitor.candle_card_policy as policy


class CandleCardPolicyTests(unittest.TestCase):
    def test_unconfigured_allows_all(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"OI_MAIN_CARD_LONG_SYMBOLS": "", "OI_MAIN_CARD_OTHER_SYMBOLS": ""},
            clear=False,
        ):
            importlib.reload(policy)
            self.assertFalse(policy.candle_card_watch_configured())
            self.assertTrue(policy.is_candle_card_push_symbol("RANDOMUSDT"))

    def test_long_other_union(self) -> None:
        env = {
            "OI_MAIN_CARD_LONG_SYMBOLS": "QQQUSDT,XLMUSDT",
            "OI_MAIN_CARD_OTHER_SYMBOLS": "VVVUSDT",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            importlib.reload(policy)
            watch = policy.candle_card_watch_symbols()
            self.assertIn("QQQUSDT", watch)
            self.assertIn("XLMUSDT", watch)
            self.assertIn("VVVUSDT", watch)
            self.assertFalse(policy.is_candle_card_push_symbol("BTCUSDT"))
            self.assertTrue(policy.is_candle_card_push_symbol("VVVUSDT"))


if __name__ == "__main__":
    unittest.main()
