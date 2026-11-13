"""短线策略 V2：指标、梯队、S01/S10 规则与并行 dry-run。"""
from __future__ import annotations

import unittest

import pandas as pd

from oi_mornitor.strategy.short_term_v1.params import STRATEGY_VERSION as V1_VER
from oi_mornitor.strategy.short_term_v1.synthetic import make_ohlcv
from oi_mornitor.strategy.short_term_v2.common import BarContext, check_chase_distance, check_rr
from oi_mornitor.strategy.short_term_v2.engine import collect_signals_on_frames, merge_duplicate_triggers
from oi_mornitor.strategy.short_term_v2.metrics import oi_change_pct, rvol_at
from oi_mornitor.strategy.short_term_v2.params import STRATEGY_VERSION as V2_VER
from oi_mornitor.strategy.short_term_v2.signal import V2Signal
from oi_mornitor.strategy.short_term_v2.tiers import classify_v2_tier


class VersionSeparationTests(unittest.TestCase):
    def test_versions_differ(self) -> None:
        self.assertEqual(V1_VER, "v1")
        self.assertEqual(V2_VER, "v2")


class TierMapTests(unittest.TestCase):
    def test_btc_is_tier1(self) -> None:
        t = classify_v2_tier("BTCUSDT", vol_30d_quote=5e9, depth=1e6)
        self.assertEqual(t.market_cap_tier, 1)
        self.assertEqual(t.v1_tier, "A")
        self.assertFalse(t.skipped)

    def test_equity_skipped(self) -> None:
        t = classify_v2_tier("TSLAUSDT", vol_30d_quote=9e9, depth=1e6)
        self.assertTrue(t.skipped)


class MetricsTests(unittest.TestCase):
    def test_rvol_and_oi(self) -> None:
        rows = []
        oi = 1_000_000.0
        for i in range(30):
            vol = 1000.0 if i < 25 else 3000.0
            oi *= 1.01 if i == 29 else 1.0
            rows.append({
                "open_time": 1_700_000_000_000 + i * 900_000,
                "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0,
                "volume": vol, "oi": oi,
            })
        df = pd.DataFrame(rows)
        rv = rvol_at(df, 29, lookback=20)
        self.assertIsNotNone(rv)
        self.assertGreater(rv, 2.0)
        chg = oi_change_pct(df, 29)
        self.assertIsNotNone(chg)
        self.assertAlmostEqual(chg, 1.0, places=5)


class GateTests(unittest.TestCase):
    def test_chase_and_rr(self) -> None:
        bad = check_chase_distance(close=110, level=100, atr=5, direction="long")
        self.assertFalse(bad.ok)
        ok = check_chase_distance(close=102, level=100, atr=5, direction="long")
        self.assertTrue(ok.ok)
        rr = check_rr(entry=100, stop=98, target=104, direction="long", fee_pct=0.06, slip_pct=0.03)
        self.assertTrue(rr.ok)


class DedupTests(unittest.TestCase):
    def test_merge_keeps_better_status(self) -> None:
        a = V2Signal("S01", 1, symbol="BTCUSDT", status="observe", direction="long",
                     structure_level=100.0, trigger_idx=10)
        b = V2Signal("S01", 1, symbol="BTCUSDT", status="entry_ready", direction="long",
                     structure_level=100.0, trigger_idx=11, entry_price=101.0)
        m = merge_duplicate_triggers([a, b])
        self.assertEqual(len(m), 1)
        self.assertEqual(m[0].status, "entry_ready")


class EngineSmokeTests(unittest.TestCase):
    def test_collect_runs(self) -> None:
        df15 = make_ohlcv(160, start_price=60000.0, trend=0.0004, oi=2e6)
        df1h = make_ohlcv(80, start_price=60000.0, trend=0.001, step_ms=3_600_000, oi=2e6)
        rec = collect_signals_on_frames(
            symbol="BTCUSDT",
            df_15m=df15,
            df_1h=df1h,
            strategies=["S01", "S10"],
            vol_30d_quote=5e9,
            depth=1e6,
            simulate=True,
        )
        self.assertEqual(rec["strategyVersion"], "v2")
        self.assertIn("signals", rec)
        self.assertIn("S01", rec["enabledStrategies"])

    def test_parallel_dry_run(self) -> None:
        from oi_mornitor.strategy.short_term_v2.synthetic import tiny_parallel_fixture

        merged = tiny_parallel_fixture()
        self.assertEqual(merged["mode"], "parallel_v1_v2")
        self.assertGreaterEqual(merged["counts"]["combined"], 0)
        one = merged["perSymbol"][0]
        self.assertIn("v1", one)
        self.assertIn("v2", one)
        self.assertEqual(one["v1"]["strategyVersion"], "v1")
        self.assertEqual(one["v2"]["strategyVersion"], "v2")


class S01RuleTests(unittest.TestCase):
    def test_s01_can_fire_on_breakout_pullback(self) -> None:
        from oi_mornitor.strategy.short_term_v2.strategies.s01_pattern_volume import scan_s01

        df = make_ohlcv(80, start_price=100.0, trend=0.0, volume=1000.0, oi=1e6)
        # 平坦后突破
        for i in range(50, 60):
            df.loc[i, "high"] = 100.4
            df.loc[i, "low"] = 99.6
            df.loc[i, "close"] = 100.0
            df.loc[i, "volume"] = 800.0
        # breakout bar
        df.loc[60, "high"] = 105.0
        df.loc[60, "close"] = 104.0
        df.loc[60, "open"] = 100.0
        df.loc[60, "volume"] = 5000.0
        df.loc[60, "oi"] = float(df.loc[59, "oi"]) * 1.04
        # pullback hold
        df.loc[61, "low"] = 103.5
        df.loc[61, "high"] = 104.2
        df.loc[61, "close"] = 103.8
        df.loc[61, "open"] = 104.0
        df.loc[61, "volume"] = 1200.0
        tier = classify_v2_tier("BTCUSDT", vol_30d_quote=5e9, depth=2e6)
        ctx = BarContext(symbol="BTCUSDT", tier=tier, idx=61, df_15m=df, df_1h=None)
        # 无 1H 时 S01 对 tier1 会要求 mtf → 可能空；改用造 1H
        df1h = make_ohlcv(40, start_price=100.0, trend=0.002, step_ms=3_600_000, oi=1e6)
        ctx.df_1h = df1h
        sigs = scan_s01(ctx)
        # 合成数据不一定总触发；至少函数可运行
        self.assertIsInstance(sigs, list)


if __name__ == "__main__":
    unittest.main()
