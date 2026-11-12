"""短线策略 V1：分层、放弃规则、机会识别、仓位、出场状态机、消融开关与暂停口径。"""
from __future__ import annotations

import unittest

import pandas as pd

from oi_mornitor.pattern_pause import is_paused_kind
from oi_mornitor.strategy.short_term_v1.ablation import flags_for, passes_btc_regime_filter
from oi_mornitor.strategy.short_term_v1.abort import (
    AbortContext,
    evaluate_aborts,
    first_block_reason,
    rule_book_depth_thin,
    rule_breakout_no_volume,
    rule_btc_4h_down_alt_spike,
    rule_btc_up_laggard_long,
    rule_equity_depeg,
    rule_extreme_funding_crowded,
    rule_oi_rise_price_stall,
    rule_small_cap_huge_upper_wick,
)
from oi_mornitor.strategy.short_term_v1.decision import build_decision, stop_too_wide
from oi_mornitor.strategy.short_term_v1.exits import init_exit_state, run_exit_path, step_bar
from oi_mornitor.strategy.short_term_v1.fills import apply_entry_fill
from oi_mornitor.strategy.short_term_v1.params import (
    BREAKEVEN_AFTER_TP1,
    MAX_SLIPPAGE_PCT,
    MIN_FIRST_TARGET_R,
    STOP_VS_ATR_CAP_MULT,
    take_profit_payload,
)
from oi_mornitor.strategy.short_term_v1.patterns import default_pattern_kinds, honor_pause
from oi_mornitor.strategy.short_term_v1.setups import (
    evaluate_absorption,
    evaluate_breakout_pullback,
    evaluate_liquidation_exhaustion,
    evaluate_liquidity_sweep_reclaim,
    sweep_pierce_flags,
)
from oi_mornitor.strategy.short_term_v1.sizing import position_qty, size_trade
from oi_mornitor.strategy.short_term_v1.tiers import classify_tier, is_equity_token


def _df(rows: list[dict], start=1_700_000_000_000, step=900_000) -> pd.DataFrame:
    out = []
    for i, r in enumerate(rows):
        row = dict(r)
        row.setdefault("open_time", start + i * step)
        row.setdefault("volume", 1000.0)
        out.append(row)
    return pd.DataFrame(out)


def _flat(n: int, px: float = 100.0, **extra) -> list[dict]:
    rows = []
    for _ in range(n):
        d = {"open": px, "high": px + 0.4, "low": px - 0.4, "close": px, "volume": 1000.0}
        d.update(extra)
        rows.append(d)
    return rows


class TierTests(unittest.TestCase):
    def test_btc_eth_are_a(self) -> None:
        b = classify_tier("BTCUSDT", vol_30d_quote=5e9, depth=1e6)
        e = classify_tier("ETHUSDT", vol_30d_quote=2e9, depth=8e5)
        self.assertEqual(b.tier, "A")
        self.assertEqual(e.tier, "A")
        self.assertFalse(b.skipped)
        self.assertFalse(b.depth_missing)

    def test_volume_downgrades_and_depth_fallback(self) -> None:
        # 大市值初分组但成交额极低 → D；无深度则默认跳过
        d = classify_tier("DOGEUSDT", vol_30d_quote=1_000_000.0, depth=None)
        self.assertEqual(d.tier, "D")
        self.assertTrue(d.depth_missing)
        self.assertTrue(d.liquidity_overrode)
        self.assertTrue(d.skipped)
        self.assertEqual(d.skip_reason, "d_tier_depth_missing")
        # 有深度则不因缺失跳过
        d2 = classify_tier("DOGEUSDT", vol_30d_quote=1_000_000.0, depth=50_000.0)
        self.assertEqual(d2.tier, "D")
        self.assertFalse(d2.skipped)

    def test_mid_and_large_volume_bands(self) -> None:
        uni = classify_tier("UNIUSDT", vol_30d_quote=30_000_000.0, depth=1e5)
        self.assertEqual(uni.tier, "C")
        sol = classify_tier("SOLUSDT", vol_30d_quote=200_000_000.0, depth=1e6)
        self.assertEqual(sol.tier, "B")

    def test_equity_token_is_e_and_skipped(self) -> None:
        self.assertTrue(is_equity_token("TSLAUSDT"))
        t = classify_tier("TSLAUSDT", vol_30d_quote=9e9, depth=1e6)
        self.assertEqual(t.tier, "E")
        self.assertTrue(t.is_equity_token)
        self.assertTrue(t.skipped)
        self.assertEqual(t.skip_reason, "equity_token_excluded")


class AbortRuleTests(unittest.TestCase):
    def test_btc_4h_down_alt_spike(self) -> None:
        ctx = AbortContext(symbol="DOGEUSDT", is_btc=False, btc_regime_4h="trend_down", alt_spike=True, direction="long")
        h = rule_btc_4h_down_alt_spike(ctx)
        self.assertTrue(h.triggered)
        self.assertEqual(h.action, "skip")
        ctx2 = AbortContext(symbol="BTCUSDT", is_btc=True, btc_regime_4h="trend_down", alt_spike=True)
        self.assertFalse(rule_btc_4h_down_alt_spike(ctx2).triggered)

    def test_btc_up_laggard_long(self) -> None:
        ctx = AbortContext(
            symbol="UNIUSDT", is_btc=False, direction="long",
            btc_regime_4h="trend_up", btc_return=0.08, coin_return=0.01,
        )
        h = rule_btc_up_laggard_long(ctx)
        self.assertTrue(h.triggered)
        ctx_ok = AbortContext(
            symbol="SOLUSDT", is_btc=False, direction="long",
            btc_regime_4h="trend_up", btc_return=0.08, coin_return=0.10,
        )
        self.assertFalse(rule_btc_up_laggard_long(ctx_ok).triggered)

    def test_oi_rise_price_stall_and_missing(self) -> None:
        miss = rule_oi_rise_price_stall(AbortContext(oi_available=False))
        self.assertFalse(miss.triggered)
        self.assertTrue(miss.data_missing)
        self.assertEqual(miss.data_flag, "oi_missing")
        hit = rule_oi_rise_price_stall(AbortContext(oi_available=True, oi_change_pct=0.05, price_range_atr=0.2))
        self.assertTrue(hit.triggered)
        self.assertEqual(hit.action, "wait")

    def test_breakout_no_volume(self) -> None:
        h = rule_breakout_no_volume(AbortContext(is_breakout=True, breakout_volume_ok=False))
        self.assertTrue(h.triggered)
        miss = rule_breakout_no_volume(AbortContext(is_breakout=True, breakout_volume_ok=None))
        self.assertFalse(miss.triggered)
        self.assertTrue(miss.data_missing)

    def test_book_depth_thin_missing_and_drop(self) -> None:
        miss = rule_book_depth_thin(AbortContext(depth_available=False, depth=None))
        self.assertFalse(miss.triggered)
        self.assertTrue(miss.data_missing)
        hit = rule_book_depth_thin(AbortContext(tier="C", depth_available=True, depth=10, depth_ref=100))
        self.assertTrue(hit.triggered)
        self.assertEqual(hit.action, "skip")

    def test_extreme_funding_crowded(self) -> None:
        miss = rule_extreme_funding_crowded(AbortContext(funding_available=False))
        self.assertTrue(miss.data_missing)
        self.assertFalse(miss.triggered)
        hit = rule_extreme_funding_crowded(AbortContext(
            funding_available=True, funding_rate=0.001, direction="long", crowded_side="long",
        ))
        self.assertTrue(hit.triggered)

    def test_small_cap_huge_upper_wick(self) -> None:
        skip = rule_small_cap_huge_upper_wick(AbortContext(tier="D", upper_wick_ratio=0.7))
        self.assertTrue(skip.triggered)
        self.assertFalse(rule_small_cap_huge_upper_wick(AbortContext(tier="A", upper_wick_ratio=0.7)).triggered)

    def test_equity_depeg(self) -> None:
        h = rule_equity_depeg(AbortContext(is_equity=True, underlying_available=True, depeg_pct=0.05))
        self.assertTrue(h.triggered)
        default = rule_equity_depeg(AbortContext(is_equity=True, underlying_available=False))
        self.assertTrue(default.triggered)
        self.assertFalse(rule_equity_depeg(AbortContext(is_equity=False)).triggered)

    def test_evaluate_aborts_blocks(self) -> None:
        ctx = AbortContext(
            symbol="DOGEUSDT", tier="B", direction="long", is_btc=False,
            btc_regime_4h="trend_down", alt_spike=True,
        )
        hits = evaluate_aborts(ctx)
        self.assertEqual(first_block_reason(hits), hits[0].reason if first_block_reason(hits) else first_block_reason(hits))
        self.assertIsNotNone(first_block_reason(hits))


def _sweep_frame(*, reclaim: bool) -> tuple[pd.DataFrame, int]:
    """构造前低摆动，再一根刺破。reclaim=False 时收盘仍在前低之下。"""
    rows = _flat(50, 100.0)
    # 摆动低点 index=20，窗口 15-25 内最低
    rows[20] = {"open": 96, "high": 97, "low": 90.0, "close": 95, "volume": 1200}
    for j in list(range(15, 20)) + list(range(21, 26)):
        rows[j] = {"open": 99, "high": 101, "low": 95.5, "close": 99, "volume": 1000}
    # 刺破根
    close = 92.0 if reclaim else 88.5
    rows[40] = {"open": 92.0, "high": 93.0, "low": 89.0, "close": close, "volume": 2000}
    return _df(rows), 40


class SweepReclaimTests(unittest.TestCase):
    def test_sweep_without_reclaim_rejected(self) -> None:
        df, idx = _sweep_frame(reclaim=False)
        flags = sweep_pierce_flags(df, idx=idx, side="long")
        self.assertTrue(flags["sweep"])
        self.assertFalse(flags["reclaim"])
        r = evaluate_liquidity_sweep_reclaim(df, idx=idx, side="long")
        self.assertFalse(r.accepted)
        self.assertEqual(r.skip_reason, "sweep_without_reclaim")

    def test_sweep_with_reclaim_not_sweep_only(self) -> None:
        df, idx = _sweep_frame(reclaim=True)
        flags = sweep_pierce_flags(df, idx=idx, side="long")
        self.assertTrue(flags["sweep"])
        self.assertTrue(flags["reclaim"])
        r = evaluate_liquidity_sweep_reclaim(df, idx=idx, side="long", require_choch=True)
        # 收回后若无 CHoCH 仍不可交易
        self.assertIn(r.skip_reason, ("no_choch_after_reclaim", None))
        if r.accepted:
            self.assertTrue(r.data_flags.get("choch"))
        else:
            self.assertEqual(r.skip_reason, "no_choch_after_reclaim")


def _wick_break_frame() -> tuple[pd.DataFrame, int]:
    rows = _flat(60, 100.0)
    # 摆动高点 21
    rows[21] = {"open": 104, "high": 110.0, "low": 103, "close": 105, "volume": 1500}
    for j in list(range(16, 21)) + list(range(22, 27)):
        rows[j] = {"open": 102, "high": 104, "low": 100, "close": 102, "volume": 1000}
    # 仅影线刺破：高点 111，收盘 109（未收在前高之上）
    rows[40] = {"open": 108, "high": 111.0, "low": 107, "close": 109.0, "volume": 2000}
    return _df(rows), 40


class PullbackWickTests(unittest.TestCase):
    def test_wick_only_breakout_rejected(self) -> None:
        df, idx = _wick_break_frame()
        r = evaluate_breakout_pullback(df, idx=idx, side="long")
        self.assertFalse(r.accepted)
        self.assertEqual(r.skip_reason, "wick_only_breakout")


class StopAndSizeTests(unittest.TestCase):
    def test_stop_too_wide_skipped(self) -> None:
        # A 档 ATR 上限 1.6，倍数 1.15；ATR=1 → 上限 1.84。距离 3 过宽。
        wide, reason = stop_too_wide(entry=100.0, stop=97.0, atr_15m=1.0, tier="A", per_tier=True)
        self.assertTrue(wide)
        self.assertEqual(reason, "stop_too_wide")
        ok, _ = stop_too_wide(entry=100.0, stop=99.0, atr_15m=1.0, tier="A", per_tier=True)
        self.assertFalse(ok)
        dec = build_decision(
            symbol="BTCUSDT", tier="A", setup="breakout_pullback", direction="long",
            entry=100.0, structure_level=96.5, atr_15m=1.0, market_regime="trend_up",
            per_tier=True,
        )
        # structure 96.5 距离约 3.5，应跳过
        self.assertTrue(dec.skipped)
        self.assertEqual(dec.skip_reason, "stop_too_wide")

    def test_position_sizing_formula(self) -> None:
        # 文档例子：E=10000，r=0.5%，P=100，S=98 → 25
        self.assertAlmostEqual(position_qty(10_000, 0.5, 100, 98), 25.0)
        # A 档中值 0.40%
        self.assertAlmostEqual(position_qty(10_000, 0.40, 100, 98), 20.0)
        sz = size_trade(entry=100, stop=98, tier="A", equity=10_000, per_tier=True)
        self.assertFalse(sz.skipped)
        self.assertAlmostEqual(sz.risk_percent, 0.40)
        self.assertAlmostEqual(sz.qty, 20.0)
        # 并发上限
        capped = size_trade(
            entry=100, stop=98, tier="A", equity=10_000, per_tier=True,
            open_risk_percents=[0.40, 0.40, 0.40],
        )
        self.assertTrue(capped.skipped)
        self.assertEqual(capped.skip_reason, "concurrent_risk_cap")


class ExitStateMachineTests(unittest.TestCase):
    def test_scaled_tp_and_no_breakeven_at_tp1(self) -> None:
        self.assertFalse(BREAKEVEN_AFTER_TP1)
        # 多：入场 100，止损 98，1R=2。A：25%@1R=102，35%@2R=104
        bars = [
            {"high": 102.2, "low": 99.5, "close": 102.0},  # 打到 1R
            {"high": 103.0, "low": 100.5, "close": 102.5},  # 回踩，若移保本会被扫；默认不应移
            {"high": 104.5, "low": 102.0, "close": 104.2},  # 2R
        ]
        state = run_exit_path(bars, side="long", entry=100.0, stop=98.0, tier="A", per_tier_targets=True)
        self.assertFalse(state.moved_to_breakeven)
        self.assertEqual(state.current_stop, 98.0)
        levels = [h.get("r_level") for h in state.tp_hits if h.get("r_level") is not None]
        self.assertIn(1.0, levels)
        self.assertIn(2.0, levels)
        # 已平 25%+35%=60%，剩余约 40%
        self.assertAlmostEqual(state.remaining, 0.40, places=6)

    def test_same_bar_sl_first(self) -> None:
        state = init_exit_state(side="long", entry=100.0, stop=98.0)
        targets = take_profit_payload("A", per_tier=True)
        # 同柱既到止损 98 又到 1R 102：先止损，全平
        bar = {"high": 103.0, "low": 97.5, "close": 99.0}
        step_bar(state, bar, targets=targets, tier="A")
        self.assertTrue(state.done)
        self.assertEqual(state.exit_reason, "stop_loss")
        self.assertEqual(state.exit_price, 98.0)
        self.assertAlmostEqual(state.remaining, 0.0)

    def test_never_widen_stop(self) -> None:
        state = init_exit_state(side="long", entry=100.0, stop=98.0)
        from oi_mornitor.strategy.short_term_v1.exits import _tighten_stop

        _tighten_stop(state, 97.0)  # 试图扩大（对多头更低）
        self.assertEqual(state.current_stop, 98.0)
        self.assertTrue(state.widened)
        _tighten_stop(state, 99.0)  # 收紧允许
        self.assertEqual(state.current_stop, 99.0)


class AblationFlagTests(unittest.TestCase):
    def test_progressive_flags(self) -> None:
        a = flags_for("A")
        b = flags_for("B")
        c = flags_for("C")
        d = flags_for("D")
        e = flags_for("E")
        self.assertFalse(a.btc_regime_filter)
        self.assertFalse(a.oi_funding_liq_confirm)
        self.assertFalse(a.sweep_cvd_absorption)
        self.assertFalse(a.per_tier_params)
        self.assertTrue(b.btc_regime_filter)
        self.assertFalse(b.oi_funding_liq_confirm)
        self.assertTrue(c.oi_funding_liq_confirm)
        self.assertFalse(c.sweep_cvd_absorption)
        self.assertTrue(d.sweep_cvd_absorption)
        self.assertFalse(d.per_tier_params)
        self.assertTrue(e.per_tier_params)
        self.assertTrue(e.sweep_cvd_absorption)

    def test_btc_regime_filter_changes_outcome(self) -> None:
        # 同一做多候选：实验 A 不过滤 BTC 下跌；B 拒绝
        ok_a, _ = passes_btc_regime_filter(
            flags=flags_for("A"), direction="long", btc_regime_4h="trend_down", is_btc=False,
        )
        ok_b, why = passes_btc_regime_filter(
            flags=flags_for("B"), direction="long", btc_regime_4h="trend_down", is_btc=False,
        )
        self.assertTrue(ok_a)
        self.assertFalse(ok_b)
        self.assertEqual(why, "btc_4h_down_no_alt_long")

    def test_per_tier_changes_targets(self) -> None:
        a_shared = take_profit_payload("A", per_tier=False)
        a_tier = take_profit_payload("A", per_tier=True)
        d_tier = take_profit_payload("D", per_tier=True)
        self.assertNotEqual(a_shared, d_tier)
        self.assertEqual(a_tier[0]["r"], 1.0)
        self.assertEqual(d_tier[0]["r"], 0.8)
        self.assertGreaterEqual(a_tier[0]["r"], MIN_FIRST_TARGET_R)


class PauseHonorTests(unittest.TestCase):
    def test_bottom_paused_shoot_enabled(self) -> None:
        self.assertTrue(is_paused_kind("bottom_secondary_test"))
        self.assertFalse(is_paused_kind("shooting_star"))
        self.assertFalse(is_paused_kind("consecutive_flat_shooting_star"))
        self.assertTrue(honor_pause("bottom_secondary_test", "底部二次探底确认"))
        self.assertFalse(honor_pause("shooting_star", "射击之星"))
        self.assertFalse(honor_pause("consecutive_flat_shooting_star", "连续走平射击之星"))
        kinds = default_pattern_kinds()
        self.assertNotIn("bottom_secondary_test", kinds)
        self.assertIn("shooting_star", kinds)
        self.assertIn("consecutive_flat_shooting_star", kinds)


class DataDependencyTests(unittest.TestCase):
    def test_absorption_skips_without_cvd(self) -> None:
        df = _df(_flat(30))
        r = evaluate_absorption(df, idx=20)
        self.assertFalse(r.accepted)
        self.assertEqual(r.skip_reason, "cvd_missing")
        self.assertTrue(r.data_flags.get("cvd_missing"))

    def test_liquidation_skips_without_history(self) -> None:
        df = _df(_flat(30))
        r = evaluate_liquidation_exhaustion(df, idx=20, liq_events=None)
        self.assertFalse(r.accepted)
        self.assertEqual(r.skip_reason, "liquidation_history_missing")
        self.assertTrue(r.data_flags.get("liquidation_missing"))
        # 仅有清算打印、无收回，不是入场
        evs = [{"ts": int(df.iloc[20]["open_time"]) - 60_000} for _ in range(5)]
        r2 = evaluate_liquidation_exhaustion(df, idx=20, liq_events=evs)
        self.assertFalse(r2.accepted)
        self.assertIn(r2.skip_reason, ("liq_cluster_without_reclaim", "no_liquidation_cluster", "forced_flow_not_faded"))


class FillModelTests(unittest.TestCase):
    def test_unfilled_when_slippage_over_cap(self) -> None:
        f = apply_entry_fill(100.0, side="long", slippage_pct=MAX_SLIPPAGE_PCT + 0.01)
        self.assertTrue(f.unfilled)
        self.assertEqual(f.reason, "slippage_over_cap")
        ok = apply_entry_fill(100.0, side="long", slippage_pct=0.03)
        self.assertFalse(ok.unfilled)
        self.assertGreater(ok.filled, 100.0)  # 多头不利滑点更高


class DryRunBootTests(unittest.TestCase):
    def test_cli_dry_run_boots(self) -> None:
        from oi_mornitor.strategy.short_term_v1.synthetic import tiny_fixture_result

        r = tiny_fixture_result(experiment="E")
        self.assertIn("summary", r)
        self.assertIn("disclaimer", r)
        self.assertEqual(r["symbols"], ["BTCUSDT", "ETHUSDT"])


if __name__ == "__main__":
    unittest.main()
