"""Telegram 卡片文案解析。"""
from __future__ import annotations

import unittest

from oi_mornitor.telegram_backfill_parse import parse_oi_telegram_card


_SAMPLE_CANDLE = """💰 交易对: BTCUSDT
📈 类型: 射击之星 (看跌)
⏰ 周期: 15m
⏰ 时间: 2025-06-01 14:15:00
💵 价格: 67500.5
📈 最高: 67600
📉 最低: 67400"""


_SAMPLE_TOP = """🚨 信号: 顶部结构确认 (看跌)
💰 交易对: ETHUSDT
⏰ 周期: 1h
⏰ 时间: 2025-06-02 09:00:00
📊 形态: 头肩顶
💵 现价: 3200.1"""


class TelegramBackfillParseTests(unittest.TestCase):
    def test_candle_card(self) -> None:
        alert = parse_oi_telegram_card(_SAMPLE_CANDLE)
        self.assertIsNotNone(alert)
        assert alert is not None
        self.assertEqual(alert["symbol"], "BTCUSDT")
        self.assertEqual(alert["kind"], "shooting_star")
        self.assertEqual(alert["interval"], "15m")
        self.assertEqual(alert["kline_close_time"], 1_748_758_500_000)

    def test_structure_top(self) -> None:
        alert = parse_oi_telegram_card(_SAMPLE_TOP)
        self.assertIsNotNone(alert)
        assert alert is not None
        self.assertEqual(alert["symbol"], "ETHUSDT")
        self.assertIn("hs_vegas_break", alert["kind"])

    def test_settle_summary_ignored(self) -> None:
        text = "本档 4h 胜率 55% · 合计盈亏 +12U"
        self.assertIsNone(parse_oi_telegram_card(text))


if __name__ == "__main__":
    unittest.main()
