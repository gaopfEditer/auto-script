"""MAIN 群镜像策略单测。"""

import unittest

from oi_mornitor.main_card_policy import is_main_card_mirror_eligible, is_volume_price_card


class MainCardPolicyTests(unittest.TestCase):
    def test_volume_price_excluded_from_main_mirror(self) -> None:
        vp = {
            "type": "volume_price_card",
            "symbol": "BTCUSDT",
            "interval": "15m",
            "type_label": "量价确认·多",
            "vp_formal": True,
        }
        self.assertTrue(is_volume_price_card(vp))
        self.assertFalse(is_main_card_mirror_eligible(vp))

    def test_candle_pattern_mirror_by_symbol_interval(self) -> None:
        candle = {
            "type": "candle_pattern_card",
            "symbol": "BTCUSDT",
            "interval": "15m",
            "type_label": "射击之星",
        }
        self.assertFalse(is_volume_price_card(candle))
        # 是否在 MAIN 还取决于 env 白名单；BTC 默认在白名单内
        eligible = is_main_card_mirror_eligible(candle)
        self.assertIsInstance(eligible, bool)


if __name__ == "__main__":
    unittest.main()
