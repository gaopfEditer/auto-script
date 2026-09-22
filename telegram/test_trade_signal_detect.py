"""交易信号过滤单测（闲聊 vs 结构化策略）。"""
from __future__ import annotations

import unittest

from trade_signal_detect import (
    is_casual_chat_only,
    is_structured_trade_message,
    looks_like_trade_message,
    parse_trade_text,
    refine_trade_text,
    signal_skip_reason,
)

AURA_SIGNAL = """\
币種：ETH/USDT
方向：🚀🚀🚀📈
策略属性：限价
📌进场点：2570—2530
✔️获利目标：2625—2690—2790
❌止损位置：2490"""

AURA_MIXED = """\
【Aura_幣圈策略】
币種：ETH/USDT
方向：🚀🚀🚀📈
策略属性：限价
📌进场点：2570—2530
✔️获利目标：2625—2690—2790
❌止损位置：2490
我好像發現了自己的一個小規律
例如💰 ETH
如果我在9月1日做了多
9月2日平倉盈利200%
稍後發出💰 ETH 做多點位
幣種：ETH/USDT
方向：🚀🚀🚀📈
策略屬性：限價
📌進場點：2570—2530
✔️獲利目標：2625—2690—2790
❌止損位置：2490"""

ASHLEY_CHAT_1 = """\
有時候是，波動大的時候也有TP1，70% 。這塊我沒有固定
有时候是，波動大的时候也有TP1，70% 。這块我沒有固定
但是基本tp1 ,我最少平30%"""

ASHLEY_CHAT_2 = "我一般不會，，因為群裡有兄弟做單，我要看止損情況"

ASHLEY_CHAT_3 = "沒喊，我自己的掛單昨天入場了"


class TradeSignalFilterTest(unittest.TestCase):
    def test_pure_signal_structured(self) -> None:
        self.assertTrue(is_structured_trade_message(AURA_SIGNAL))
        self.assertFalse(is_casual_chat_only(AURA_SIGNAL))
        self.assertTrue(looks_like_trade_message(AURA_SIGNAL))
        sig = parse_trade_text(AURA_SIGNAL)
        self.assertIsNotNone(sig)
        assert sig is not None
        self.assertEqual(sig.symbol, "ETH")
        self.assertEqual(sig.direction, "多")
        self.assertIsNone(signal_skip_reason(sig, AURA_SIGNAL, sender="Aura"))

    def test_mixed_signal_extracts_structure(self) -> None:
        refined = refine_trade_text(AURA_MIXED)
        self.assertIn("ETH", refined)
        self.assertNotIn("规律", refined)
        self.assertTrue(looks_like_trade_message(AURA_MIXED))
        self.assertFalse(is_casual_chat_only(AURA_MIXED))

    def test_ashley_casual_blocked(self) -> None:
        for msg in (ASHLEY_CHAT_1, ASHLEY_CHAT_2, ASHLEY_CHAT_3):
            with self.subTest(msg=msg[:24]):
                self.assertTrue(is_casual_chat_only(msg))
                self.assertFalse(looks_like_trade_message(msg))


if __name__ == "__main__":
    unittest.main()
