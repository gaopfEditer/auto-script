"""第一阶段验收：路径不得早于成交、费用可对账、4H 只用已收盘、字段映射正确。"""
from __future__ import annotations

import unittest

import pandas as pd

from oi_mornitor.backtest_engine_v2.alignment import (
    acceptance_timing,
    execution_path,
    last_closed_idx,
    signal_timeline,
)
from oi_mornitor.backtest_engine_v2.costs import add_leg, apply_slippage, new_ledger, reconcile_ledger
from oi_mornitor.backtest_engine_v2.equity import build_equity_curve
from oi_mornitor.backtest_engine_v2.settle import attach_settlement, map_exit_flags
from oi_mornitor.backtest_engine_v2.structure import structure_broken_on_close
from oi_mornitor.strategy.short_term_v1.exits import ExitState


def _ohlc(start: int, n: int, interval_ms: int, px: float = 100.0) -> pd.DataFrame:
    rows = []
    for i in range(n):
        ts = start + i * interval_ms
        rows.append({
            "open_time": ts,
            "open": px,
            "high": px + 1,
            "low": px - 1,
            "close": px,
            "volume": 1.0,
        })
    return pd.DataFrame(rows)


class AlignmentTests(unittest.TestCase):
    def test_fill_equals_15m_close(self):
        open_ts = 1_700_000_000_000
        tl = signal_timeline(open_ts)
        self.assertEqual(tl["signalCloseAt"] - tl["signalOpenAt"], 15 * 60 * 1000)
        self.assertEqual(tl["fillAt"], tl["signalCloseAt"])

    def test_5m_path_excludes_signal_bar(self):
        # 信号 15m 开盘=0，收盘/成交=15min；此前 3 根 5m 属于信号柱，不得进入路径
        start = 1_700_000_000_000
        df = _ohlc(start, 12, 5 * 60 * 1000)
        fill = start + 15 * 60 * 1000
        bars = execution_path(df, fill, limit=10)
        self.assertTrue(bars)
        self.assertGreaterEqual(bars[0]["ts"], fill)
        self.assertTrue(all(b["ts"] >= fill for b in bars))
        self.assertNotIn(start + 5 * 60 * 1000, [b["ts"] for b in bars])

    def test_4h_uses_only_closed_bar(self):
        start = 1_700_000_000_000
        df = _ohlc(start, 6, 4 * 60 * 60 * 1000, px=100)
        # 第二根 4H 开盘后 1 小时：第一根已收盘，第二根仍在形成
        asof = start + 4 * 60 * 60 * 1000 + 60 * 60 * 1000
        idx = last_closed_idx(df, asof, "4h")
        self.assertEqual(idx, 0)
        # 恰好收盘时，该柱可用
        idx_close = last_closed_idx(df, start + 4 * 60 * 60 * 1000, "4h")
        self.assertEqual(idx_close, 0)
        # 若误用信号开盘对齐，会取到仍在形成的第二根
        forming_asof = start + 4 * 60 * 60 * 1000 + 60 * 60 * 1000
        self.assertLess(idx, 1)
        self.assertIsNotNone(forming_asof)


class CostTests(unittest.TestCase):
    def test_entry_slip_not_deducted_twice(self):
        requested = 100.0
        filled = apply_slippage(requested, side="long", slippage_pct=0.03, action="entry")
        self.assertGreater(filled, requested)
        ledger = new_ledger(
            side="long", entry_requested=requested, entry_filled=filled,
            qty=1.0, fee_pct=0.06, slippage_pct=0.03,
        )
        add_leg(ledger, reason="timeout", raw_price=101.0, frac=1.0, ts=1)
        issues = reconcile_ledger(ledger)
        self.assertEqual(issues, [])
        # 毛额从已含入场滑点的成交价到路径原价；入场滑点只存在于 filled vs requested
        self.assertAlmostEqual(ledger["grossUsdt"], 101.0 - filled, places=6)
        expect_exit = apply_slippage(101.0, side="long", slippage_pct=0.03, action="exit")
        slipped = expect_exit - filled
        fees = filled * 0.0006 + expect_exit * 0.0006
        self.assertAlmostEqual(ledger["netUsdt"], slipped - fees, places=6)
        # 若错误再减 0.03% 入场滑点，净额会明显更差
        wrong = ledger["netUsdt"] - requested * 0.0003
        self.assertLess(wrong, ledger["netUsdt"])


class StructureAndMappingTests(unittest.TestCase):
    def test_structure_break_on_close(self):
        self.assertTrue(structure_broken_on_close({"close": 99.0}, side="long", structure_level=100.0))
        self.assertFalse(structure_broken_on_close({"close": 100.5}, side="long", structure_level=100.0))
        self.assertTrue(structure_broken_on_close({"close": 101.0}, side="short", structure_level=100.0))

    def test_exit_field_mapping(self):
        st = ExitState(side="long", entry=100, initial_stop=99, current_stop=99)
        st.tp_hits = [
            {"reason": "tp_1.0R", "r": 1.0, "r_level": 1.0, "closed": 0.25},
            {"reason": "tp_2.0R", "r": 2.0, "r_level": 2.0, "closed": 0.35},
            {"reason": "trail_giveback", "r": 1.2, "closed": 0.4},
        ]
        st.exit_reason = "trail_giveback"
        flags = map_exit_flags(st, exit_reason="trail_giveback")
        self.assertTrue(flags["tp1Hit"])
        self.assertTrue(flags["tp2Hit"])
        self.assertTrue(flags["runnerActivated"])
        self.assertFalse(flags["initialSlHit"])
        self.assertEqual(flags["exitReason"], "trail_giveback")

        st2 = ExitState(side="long", entry=100, initial_stop=99, current_stop=99)
        st2.tp_hits = [{"reason": "stop_loss", "r": -1.0, "closed": 1.0}]
        flags2 = map_exit_flags(st2, exit_reason="stop_loss")
        self.assertTrue(flags2["initialSlHit"])
        self.assertFalse(flags2["tp1Hit"])
        self.assertEqual(flags2["exitReason"], "stop_loss")


class SettlementAcceptanceTests(unittest.TestCase):
    def test_no_exit_before_fill_and_structure_can_fire(self):
        fill = 1_700_000_000_000 + 15 * 60 * 1000
        # 成交后第一根先触及结构破坏（收盘跌破 99.5），且价格不先打止损
        bars = []
        px = 100.0
        for i in range(6):
            ts = fill + i * 5 * 60 * 1000
            close = 99.2 if i == 0 else px
            bars.append({"ts": ts, "open": px, "high": px + 0.2, "low": 99.1, "close": close})
        row = {
            "direction": "long",
            "entry": apply_slippage(100.0, side="long", slippage_pct=0.03, action="entry"),
            "stop_loss": 98.0,
            "structure_level": 99.5,
            "tier": "A",
            "position_qty": 1.0,
            "skipped": False,
        }
        tl = signal_timeline(1_700_000_000_000)
        out = attach_settlement(
            row, bars=bars, timeline=tl, entry_requested=100.0,
            fee_pct=0.06, slippage_pct=0.03, per_tier=True,
        )
        self.assertEqual(out["entryAt"], tl["fillAt"])
        self.assertGreaterEqual(out["exitAt"], out["fillAt"])
        self.assertEqual(out["timingIssues"], [])
        self.assertEqual(out["feeReconcileIssues"], [])
        self.assertEqual(out["exitReason"], "structure_break")
        self.assertFalse(acceptance_timing({**out, "path_bars": bars}))

    def test_equity_not_price_percent_sum(self):
        trades = [
            {"skipped": False, "pnlUsdt": -10.0, "pnlPct": -1.0, "exitAt": 2, "realized_r_net": -0.5, "symbol": "BTCUSDT"},
            {"skipped": False, "pnlUsdt": 5.0, "pnlPct": 0.5, "exitAt": 3, "realized_r_net": 0.25, "symbol": "BTCUSDT"},
        ]
        eq = build_equity_curve(trades, starting_equity=10_000.0)
        self.assertAlmostEqual(eq["endingEquity"], 9995.0)
        self.assertAlmostEqual(eq["netReturnPct"], -0.05)
        # 价格%合计是 -0.5，与净值收益不同
        self.assertNotAlmostEqual(eq["netReturnPct"], sum(t["pnlPct"] for t in trades))


if __name__ == "__main__":
    unittest.main()
