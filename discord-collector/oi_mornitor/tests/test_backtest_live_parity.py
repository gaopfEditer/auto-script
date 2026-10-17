"""回测与 Live 共享路径一致性（fixture，无需外网）。"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from oi_mornitor.pattern_emit_gate import (
    passes_backtest_emit_gate,
    passes_pattern_card_emit_gate,
)
from oi_mornitor.pattern_entry import resolve_backtest_entry_price
from oi_mornitor.pattern_settle import settle_signal_batch
from oi_mornitor.pattern_settle_profile import build_settle_plan
from oi_mornitor.structure_backtest import _filter_items_chronological_emit_gate


class EntryParityTests(unittest.TestCase):
    def test_next_bar_open_with_slippage(self) -> None:
        px = resolve_backtest_entry_price(
            side="long",
            signal_bar_close=100.0,
            next_bar_open=101.0,
            mode="next_bar_open",
            slippage_pct=0.1,
        )
        self.assertAlmostEqual(px, 101.0 * 1.001, places=5)


class SettleSlFirstTests(unittest.TestCase):
    def test_same_5m_bar_sl_before_tp(self) -> None:
        """同根 5m 同时触及 SL 与 TP1 时按 SL 优先（悲观）。"""
        rec = {
            "side": "long",
            "entry": 100.0,
            "tradeSymbol": "TESTUSDT",
            "interval": "15m",
            "typeLabel": "射击之星",
        }
        plan = build_settle_plan(rec, atr=1.0)
        sl = plan.sl_price
        tp1 = plan.tp1_price
        self.assertLess(sl, 100.0)
        self.assertGreater(tp1, 100.0)
        bars = [
            {
                "ts": 1_700_000_000_000,
                "high": tp1 + 1,
                "low": sl - 1,
                "close": 100.0,
            }
        ]
        out = settle_signal_batch(
            side="long",
            entry=100.0,
            symbol="TESTUSDT",
            signal_at_ms=1_700_000_000_000 - 1,
            bars=bars,
            now_ms=1_700_000_300_000,
            plan=plan,
            fine_bars=True,
            breakeven_after_tp1=True,
        )
        self.assertEqual(out.get("outcome"), "stop_loss")


class MtfChronologicalGateTests(unittest.TestCase):
    def tearDown(self) -> None:
        from oi_mornitor import config
        import oi_mornitor.pattern_push_gate as pg

        config.OI_PATTERN_PUSH_MTF_MIN = 2
        pg.OI_PATTERN_PUSH_MTF_MIN = 2

    def test_second_signal_needs_peer_for_mtf2(self) -> None:
        t = 1_700_000_000_000
        items = [
            {
                "symbol": "ETHUSDT",
                "interval": "15m",
                "kind": "shooting_star",
                "side": "bear",
                "typeLabel": "射击之星",
                "signalAt": t,
                "entry": 3000.0,
                "emit": "candle",
            },
            {
                "symbol": "ETHUSDT",
                "interval": "1h",
                "kind": "shooting_star",
                "side": "bear",
                "typeLabel": "射击之星",
                "signalAt": t + 60_000,
                "entry": 3000.0,
                "emit": "candle",
            },
        ]
        from oi_mornitor import config
        import oi_mornitor.pattern_push_gate as pg

        config.OI_PATTERN_PUSH_MTF_MIN = 1
        pg.OI_PATTERN_PUSH_MTF_MIN = 1
        filtered = _filter_items_chronological_emit_gate(items)
        self.assertEqual(len(filtered), 2)

    def test_emit_gate_matches_mtf_helper(self) -> None:
        alert = {
            "type": "candle_pattern_card",
            "symbol": "BTCUSDT",
            "interval": "15m",
            "kind": "shooting_star",
            "side": "bear",
            "type_label": "射击之星",
            "kline_close_time": 1_700_000_000_000,
            "price": 50000.0,
        }
        from oi_mornitor import config
        import oi_mornitor.pattern_push_gate as pg

        config.OI_PATTERN_PUSH_MTF_MIN = 1
        pg.OI_PATTERN_PUSH_MTF_MIN = 1
        self.assertTrue(passes_pattern_card_emit_gate(alert, []))
        self.assertTrue(passes_backtest_emit_gate(alert, []))


if __name__ == "__main__":
    unittest.main()
