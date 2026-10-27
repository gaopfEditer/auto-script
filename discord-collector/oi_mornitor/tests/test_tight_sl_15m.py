#!/usr/bin/env python3
"""15m composite vs protect 结算单测。"""
import json
import unittest
from pathlib import Path

from oi_mornitor.btc_1h_backtest import run_from_fixture, run_settlement_compare_on_trades
from oi_mornitor.strategy.tight_sl_15m import (
    OhlcBar,
    _gross_pct_from_r,
    _tick_size,
    compute_composite_trade_plan,
    evaluate_future_outcome,
    simulate_tight_sl_outcome,
    summarize_sim_results,
)

_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "btc_ai_backtest_sample.json"


class TightSl15mTests(unittest.TestCase):
    def test_gross_pct_one_r_is_price_risk_not_hundred(self):
        plan = compute_composite_trade_plan(side="long", entry=100.0, sl=99.0)
        self.assertAlmostEqual(_gross_pct_from_r(plan, 1.0, 1.0), 1.0, places=4)
        self.assertAlmostEqual(_gross_pct_from_r(plan, -1.0, 1.0), -1.0, places=4)

    def test_tp1_half_gross_formula(self):
        plan = compute_composite_trade_plan(side="long", entry=100.0, sl=99.0)
        self.assertAlmostEqual(_gross_pct_from_r(plan, 1.8, 0.5), 0.9, places=4)
        bars = [OhlcBar(ts=1, open=100, high=101.85, low=100.01, close=101.5)]
        r = simulate_tight_sl_outcome(plan, bars, settlement="entry_sl_tp_trail", fee_rate=0.0)
        self.assertGreaterEqual(r.gross_pct, 0.9)
        self.assertLess(r.gross_pct, 3.0)

    def test_doge_tick_not_absolute_cent(self):
        entry = 0.08
        self.assertLess(_tick_size(entry), 0.001)
        plan = compute_composite_trade_plan(side="long", entry=entry, sl=0.079)
        bars = [
            OhlcBar(ts=1, open=entry, high=0.0807, low=0.0799, close=0.0805),
            OhlcBar(ts=2, open=0.0805, high=0.08052, low=0.07998, close=0.08001),
        ]
        r = simulate_tight_sl_outcome(plan, bars, settlement="entry_sl_tp_protect")
        self.assertLess(abs(r.net_pct), 2.0)

    def test_fixture_net_sums_sane_magnitude(self):
        payload = run_from_fixture(_FIXTURE)
        for mode in ("entry_sl_tp_trail", "entry_sl_tp_protect"):
            net = payload["settlements"][mode]["net_pct_sum"]
            self.assertGreater(net, -50.0)
            self.assertLess(net, 50.0)

    def test_horizon_unchanged_by_settlement(self):
        plan = compute_composite_trade_plan(side="long", entry=100.0, sl=99.0)
        bars = [
            OhlcBar(ts=i, open=100, high=101, low=99.5, close=100.5 if i < 4 else 99.2)
            for i in range(1, 33)
        ]
        h4 = evaluate_future_outcome(plan, bars, horizon_bars=16)
        trail = simulate_tight_sl_outcome(plan, bars, settlement="entry_sl_tp_trail")
        protect = simulate_tight_sl_outcome(plan, bars, settlement="entry_sl_tp_protect")
        self.assertIs(h4, False)
        self.assertEqual(trail.exit_reason, protect.exit_reason)

    def test_protect_tp1_r_lower_than_trail(self):
        from oi_mornitor.config import BTC_PROTECT_TP1_R, BTC_TRAIL_TP1_R

        self.assertLess(float(BTC_PROTECT_TP1_R), float(BTC_TRAIL_TP1_R))
        payload = run_from_fixture(_FIXTURE)
        trail_net = payload["settlements"]["entry_sl_tp_trail"]["net_pct_sum"]
        protect_net = payload["settlements"]["entry_sl_tp_protect"]["net_pct_sum"]
        self.assertNotEqual(trail_net, protect_net)

    def test_summarize_has_tp_sl_win_rate(self):
        plan = compute_composite_trade_plan(side="long", entry=100.0, sl=99.0)
        bars = [OhlcBar(ts=1, open=100, high=98.5, low=98, close=98.2)]
        r = simulate_tight_sl_outcome(plan, bars, settlement="entry_sl_tp_trail")
        s = summarize_sim_results([r])
        self.assertIn("tp_sl_settle_win_rate", s)
        self.assertIn("expired_ratio", s)

    def test_fixture_compare_both_modes(self):
        payload = run_from_fixture(_FIXTURE)
        self.assertGreaterEqual(payload["trade_count"], 4)
        settlements = payload["settlements"]
        self.assertIn("entry_sl_tp_trail", settlements)
        self.assertIn("entry_sl_tp_protect", settlements)
        for mode in ("entry_sl_tp_trail", "entry_sl_tp_protect"):
            s = settlements[mode]
            self.assertEqual(s["count"], payload["trade_count"])
            self.assertIsNotNone(s.get("net_pct_sum"))

    def test_request_trades_roundtrip(self):
        raw = json.loads(_FIXTURE.read_text(encoding="utf-8"))
        trades = raw["trades"][:2]
        out = run_settlement_compare_on_trades(trades)
        self.assertEqual(out["trade_count"], 2)


if __name__ == "__main__":
    unittest.main()
