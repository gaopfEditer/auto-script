"""MAIN 群镜像策略单测。"""

import unittest

from oi_mornitor.main_card_policy import (
    is_main_card_mirror_eligible,
    is_volume_price_card,
    main_card_intervals_for_symbol,
)


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

    def test_structure_excluded_from_main_mirror(self) -> None:
        struct = {
            "type": "structure_pattern_card",
            "symbol": "BTCUSDT",
            "interval": "4h",
            "type_label": "二次探底",
            "main_mirror_vol_ok": True,
        }
        self.assertFalse(is_main_card_mirror_eligible(struct))

    def test_candle_pattern_mirror_by_symbol_interval(self) -> None:
        candle = {
            "type": "candle_pattern_card",
            "symbol": "BTCUSDT",
            "interval": "15m",
            "type_label": "射击之星",
            "main_mirror_vol_ok": True,
        }
        self.assertFalse(is_volume_price_card(candle))
        self.assertTrue(is_main_card_mirror_eligible(candle))

    def test_equity_intervals_include_1w_not_15m(self) -> None:
        ivs = main_card_intervals_for_symbol("AAPLUSDT")
        self.assertIn("1w", ivs)
        self.assertNotIn("15m", ivs)

    def test_major_intervals_include_15m_and_1d(self) -> None:
        ivs = main_card_intervals_for_symbol("BTCUSDT")
        self.assertIn("15m", ivs)
        self.assertIn("1d", ivs)


if __name__ == "__main__":
    unittest.main()
