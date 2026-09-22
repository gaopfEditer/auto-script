"""默认止盈止损补全单测。"""
from __future__ import annotations

import unittest

from default_tpsl import apply_default_tpsl_if_needed, parse_entry_numeric
from trade_signal_detect import TradeSignal, parse_trade_text


class DefaultTpslTest(unittest.TestCase):
    def test_parse_entry_range(self) -> None:
        self.assertAlmostEqual(parse_entry_numeric("2570—2530"), 2550.0)

    def test_apply_defaults_long(self) -> None:
        sig = TradeSignal(
            symbol="ETH",
            direction="多",
            entry="2570—2530",
            take_profit="",
            stop_loss="",
        )
        out, changed, plan = apply_default_tpsl_if_needed(sig)
        self.assertTrue(changed)
        assert plan is not None
        self.assertEqual(plan["takeProfitSizePcts"], [30, 30, 40])
        self.assertIn("—", out.take_profit)
        self.assertTrue(out.stop_loss)

    def test_keep_explicit_tpsl(self) -> None:
        raw = """\
币種：ETH/USDT
方向：🚀📈
📌进场点：2570—2530
✔️获利目标：2625—2690—2790
❌止损位置：2490"""
        sig = parse_trade_text(raw)
        assert sig is not None
        _, changed, plan = apply_default_tpsl_if_needed(sig)
        self.assertFalse(changed)
        self.assertIsNone(plan)


if __name__ == "__main__":
    unittest.main()
