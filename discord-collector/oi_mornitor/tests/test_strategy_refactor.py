"""策略重构：暂停闸、强平封顶、MFE/MAE、严格流动性、区间vs趋势、回踩收盘确认。"""
from __future__ import annotations

import os
import unittest
from unittest import mock

import pandas as pd

from oi_mornitor.market_regime import (
    bos_by_close,
    classify_trend_regime,
    close_confirms_break,
    confirmed_swings,
    identify_range,
    wick_only_break,
)
from oi_mornitor.pattern_emit_gate import passes_pattern_card_emit_gate
from oi_mornitor.pattern_pause import (
    bottom_long_forbidden_by_4h_downtrend,
    default_trade_kinds,
    is_paused_alert,
    is_paused_kind,
)
from oi_mornitor.pattern_settle import settle_signal_batch
from oi_mornitor.strategy.liquidity_reversal import (
    _sweep_and_reclaim,
    detect_liquidity_reversal_trades,
    is_tradable_liquidity_event,
)
from oi_mornitor.strategy.pullback import close_confirms_breakout
from oi_mornitor.structure_backtest import DEFAULT_KINDS, KIND_OPTIONS, list_kind_options
from oi_mornitor.trade_leverage import (
    cap_roe_at_margin,
    leverage_for_symbol,
    liquidation_distance_pct,
    liquidation_price,
)


def _alert(kind: str, label: str, side: str = "bear") -> dict:
    return {
        "type": "candle_pattern_card" if "shoot" in kind or "射击" in label else "structure_pattern_card",
        "symbol": "BTCUSDT",
        "interval": "1h",
        "kind": kind,
        "side": side,
        "type_label": label,
        "kline_close_time": 1_700_000_000_000,
        "price": 60000.0,
        "close": 60000.0,
        "mtfResonance": {"n": 2, "intervals": ["15m", "1h"]},
    }


class PauseFlagTests(unittest.TestCase):
    def test_defaults_pause_bottom_but_not_shooting_star(self) -> None:
        self.assertTrue(is_paused_kind("bottom_secondary_test"))
        self.assertFalse(is_paused_kind("shooting_star"))
        self.assertFalse(is_paused_kind("consecutive_flat_shooting_star"))
        self.assertTrue(is_paused_alert(_alert("bottom_secondary_test", "底部二次探底确认", "bull")))
        self.assertFalse(is_paused_alert(_alert("shooting_star", "射击之星", "bear")))
        self.assertFalse(is_paused_kind("liquidity_sweep"))
        self.assertFalse(is_paused_kind("hs_vegas_break"))

    def test_default_kinds_exclude_paused(self) -> None:
        ids = [k["id"] for k in KIND_OPTIONS]
        self.assertIn("bottom_secondary_test", ids)
        self.assertNotIn("bottom_secondary_test", DEFAULT_KINDS)
        self.assertIn("shooting_star", DEFAULT_KINDS)
        self.assertIn("consecutive_flat_shooting_star", DEFAULT_KINDS)
        self.assertIn("liquidity_sweep", DEFAULT_KINDS)
        opts = list_kind_options()
        paused = {o["id"] for o in opts if o.get("paused")}
        self.assertIn("bottom_secondary_test", paused)
        self.assertNotIn("shooting_star", paused)
        self.assertNotIn("consecutive_flat_shooting_star", paused)

    def test_emit_gate_blocks_paused(self) -> None:
        a = _alert("bottom_secondary_test", "底部二次探底确认", "bull")
        # 即使 MTF 放行，暂停仍挡
        with mock.patch("oi_mornitor.pattern_emit_gate.passes_push_mtf_gate", return_value=True):
            with mock.patch("oi_mornitor.pattern_emit_gate.is_blocked_stats_record", return_value=False):
                self.assertFalse(passes_pattern_card_emit_gate(a))

    def test_emit_gate_allows_shooting_star_when_not_paused(self) -> None:
        a = _alert("shooting_star", "射击之星")
        with mock.patch("oi_mornitor.pattern_emit_gate.passes_push_mtf_gate", return_value=True):
            with mock.patch("oi_mornitor.pattern_emit_gate.is_blocked_stats_record", return_value=False):
                self.assertTrue(passes_pattern_card_emit_gate(a))

    def test_reenable_via_env(self) -> None:
        import oi_mornitor.pattern_pause as pp

        # env 可整类暂停射击之星，或重开二次探底
        with mock.patch.object(pp, "OI_PAUSE_SHOOTING_STAR", True):
            self.assertTrue(pp.is_paused_kind("shooting_star"))
            self.assertTrue(pp.is_paused_kind("consecutive_flat_shooting_star"))
        with mock.patch.object(pp, "OI_PAUSE_BOTTOM_SECONDARY", False):
            self.assertFalse(pp.is_paused_kind("bottom_secondary_test"))
            all_ids = [k["id"] for k in KIND_OPTIONS]
            enabled = pp.default_trade_kinds(all_ids)
            self.assertIn("bottom_secondary_test", enabled)
            self.assertIn("shooting_star", enabled)

    def test_4h_downtrend_forbid_long_toggle(self) -> None:
        import oi_mornitor.pattern_pause as pp

        self.assertTrue(bottom_long_forbidden_by_4h_downtrend("trend_down"))
        self.assertFalse(bottom_long_forbidden_by_4h_downtrend("trend_up"))
        with mock.patch.object(pp, "OI_BOTTOM_4H_DOWNTREND_FORBID_LONG", False):
            self.assertFalse(pp.bottom_long_forbidden_by_4h_downtrend("trend_down"))

    def test_direction_or_htf_reversal_gate(self) -> None:
        import oi_mornitor.pattern_pause as pp

        # 构造简单下跌后再抬：多头方向未破应放行
        n = 80
        closes = list(range(100, 100 - n, -1))  # 单调下跌
        df = pd.DataFrame(
            {
                "open": closes,
                "high": [c + 1 for c in closes],
                "low": [c - 1 for c in closes],
                "close": closes,
                "volume": [100.0] * n,
                "open_time": [i * 3_600_000 for i in range(n)],
            }
        )
        # 末根未形成对多头的跌破 BOS 时，gate 依赖 bos；无摆动确认时 adverse=False → 放行
        ok, reason = pp.passes_direction_or_htf_reversal(
            side="bull", df_signal=df, bar_idx=n - 1, df_htf=None, htf_idx=None
        )
        self.assertTrue(ok)
        self.assertIn("direction_intact", reason)


class LiquidationCapTests(unittest.TestCase):
    def test_btc_100x_liq_before_wide_sl(self) -> None:
        self.assertEqual(leverage_for_symbol("BTCUSDT"), 100)
        entry = 100_000.0
        # 3% SL 在 100x 下会吃掉 300% 保证金；强平应先发生
        sl = 97_000.0
        liq = liquidation_price(entry, is_short=False, leverage=100, mmr=0.004)
        self.assertIsNotNone(liq)
        assert liq is not None
        self.assertGreater(liq, sl)  # 强平更靠近入场（99000 附近）
        self.assertAlmostEqual(liquidation_distance_pct(100, 0.004), 0.6, places=6)
        bars = [
            {"ts": 1_000, "high": 100_100, "low": 98_000, "close": 98_500},
        ]
        rec = settle_signal_batch(
            side="long",
            entry=entry,
            symbol="BTCUSDT",
            signal_at_ms=0,
            bars=bars,
            sl_pct=3.0,
            verify_delay_ms=3_600_000,
            now_ms=3_600_000,
            fine_bars=True,
            breakeven_after_tp1=False,
            fee_pct_per_side=0.06,
            slippage_pct_per_side=0.03,
            enable_liquidation=True,
        )
        self.assertTrue(rec.get("liquidated"))
        self.assertEqual(rec.get("exitReason"), "liquidation")
        self.assertIsNotNone(rec.get("pnlPct"))
        self.assertGreaterEqual(rec["pnlPct"], -100.0)
        # 未封顶前若有更宽亏损会记下
        self.assertLess(rec["pnlPct"], 0)

    def test_cap_roe_at_margin(self) -> None:
        capped, exceeded = cap_roe_at_margin(-138.0)
        self.assertEqual(capped, -100.0)
        self.assertTrue(exceeded)
        ok, ex = cap_roe_at_margin(-60.0)
        self.assertEqual(ok, -60.0)
        self.assertFalse(ex)

    def test_alt_20x(self) -> None:
        self.assertEqual(leverage_for_symbol("DOGEUSDT"), 20)
        self.assertEqual(leverage_for_symbol("UNIUSDT"), 20)


class MfeMaeTpHitTests(unittest.TestCase):
    def test_tp1_then_diagnostics(self) -> None:
        entry = 100.0
        # 固定 % 计划：TP1=3%, SL=5%。先冲到 3.2% 再回来
        bars = [
            {"ts": 1_000, "high": 102.0, "low": 99.7, "close": 101.0},  # MAE 0.3, MFE 2, no TP1 (3%)
            {"ts": 2_000, "high": 103.5, "low": 101.0, "close": 103.0},  # TP1 hit 3%
            {"ts": 3_000, "high": 104.0, "low": 100.0, "close": 100.0},  # BE after TP1?
        ]
        rec = settle_signal_batch(
            side="long",
            entry=entry,
            symbol="DOGEUSDT",
            signal_at_ms=0,
            bars=bars,
            sl_pct=5.0,
            verify_delay_ms=10_000,
            now_ms=10_000,
            fine_bars=True,
            breakeven_after_tp1=True,
            fee_pct_per_side=0.0,
            slippage_pct_per_side=0.0,
            enable_liquidation=False,
        )
        self.assertTrue(rec.get("tp1Hit"))
        self.assertFalse(rec.get("tp2Hit"))
        self.assertGreater(rec.get("mfePct") or 0, 3.0)
        self.assertGreaterEqual(rec.get("maePct") or 0, 0.29)
        self.assertIsNotNone(rec.get("mfeR"))
        self.assertIn(rec.get("exitReason"), ("tp1_breakeven", "timeout", "flat", "stop_loss", "runner"))
        self.assertFalse(rec.get("liquidated"))
        self.assertIn("fundingModeled", rec)
        self.assertFalse(rec["fundingModeled"])

    def test_initial_sl_no_tp(self) -> None:
        entry = 100.0
        bars = [
            {"ts": 1_000, "high": 100.2, "low": 94.0, "close": 95.0},
        ]
        rec = settle_signal_batch(
            side="long",
            entry=entry,
            symbol="DOGEUSDT",
            signal_at_ms=0,
            bars=bars,
            sl_pct=5.0,
            verify_delay_ms=10_000,
            now_ms=10_000,
            fine_bars=True,
            breakeven_after_tp1=True,
            fee_pct_per_side=0.0,
            slippage_pct_per_side=0.0,
            enable_liquidation=False,
        )
        self.assertTrue(rec.get("initialSlHit"))
        self.assertFalse(rec.get("tp1Hit"))
        self.assertEqual(rec.get("exitReason"), "initial_sl")
        self.assertEqual(rec.get("outcome"), "stop_loss")


def _ohlc(n: int, start: float, step: float, *, trend: str = "up") -> pd.DataFrame:
    rows = []
    px = start
    t0 = 1_700_000_000_000
    for i in range(n):
        if trend == "up":
            o, c = px, px + step
            h, l = c + step * 0.3, o - step * 0.2
            px = c
        elif trend == "down":
            o, c = px, px - step
            h, l = o + step * 0.2, c - step * 0.3
            px = c
        else:
            # 震荡：在 start±amp 内来回
            amp = step * 8
            phase = (i % 20)
            if phase < 10:
                o, c = px, px + step
            else:
                o, c = px, px - step
            h, l = max(o, c) + step * 0.2, min(o, c) - step * 0.2
            px = c
        rows.append({
            "open_time": t0 + i * 3_600_000,
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "volume": 1000.0 + (50 if i % 7 == 0 else 0),
        })
    return pd.DataFrame(rows)


class LiquidityStrictTests(unittest.TestCase):
    def test_sweep_only_not_tradable(self) -> None:
        self.assertFalse(is_tradable_liquidity_event({"sweep": True}))
        self.assertFalse(is_tradable_liquidity_event({"sweep": True, "reclaim": False}))
        self.assertFalse(is_tradable_liquidity_event({"sweep": True, "reclaim": True}))  # 无 CHoCH
        self.assertFalse(is_tradable_liquidity_event({"insufficient": True}))
        self.assertTrue(is_tradable_liquidity_event({"sweep": True, "reclaim": True, "choch": True}))

    def test_detector_rejects_sweep_without_choch(self) -> None:
        # 构造一根扫前高但没有随后 CHoCH 的序列
        df = _ohlc(80, 100.0, 0.4, trend="up")
        # 在末尾做一次上影扫高、收盘仍接近高位（不收回+无 CHoCH）
        i = 70
        ph = float(df.iloc[i - 6]["high"])
        df.loc[i, "high"] = ph * 1.008
        df.loc[i, "close"] = ph * 1.004  # 未收回
        df.loc[i, "open"] = ph * 1.002
        trades = detect_liquidity_reversal_trades(df, symbol="BTCUSDT")
        # 不应因不完整 sweep 产出交易
        for t in trades:
            self.assertTrue(t.get("complete"))
            self.assertIsNotNone(t.get("chochBar"))


class RangeVsTrendTests(unittest.TestCase):
    def test_strong_uptrend_not_range(self) -> None:
        df = _ohlc(120, 100.0, 0.8, trend="up")
        r = classify_trend_regime(df, end_idx=len(df) - 1, tf="1h")
        self.assertEqual(r.label, "trend_up")
        self.assertIsNone(identify_range(df, end_idx=len(df) - 1))

    def test_confirmed_swings_no_lookahead(self) -> None:
        df = _ohlc(40, 100.0, 0.5, trend="up")
        end = 20
        swings = confirmed_swings(df, end_idx=end, which="high", order=5)
        for idx, _ in swings:
            self.assertLessEqual(idx + 5, end, "摆动确认不得使用 end_idx 之后的 K 线")

    def test_confirmed_swings_match_bruteforce_and_prefix(self) -> None:
        """向量化+缓存必须与原来的逐窗扫描一致，包括并列极值和不同 end_idx。"""
        import numpy as np
        from oi_mornitor.market_regime import _compute_all_swings

        def brute(vals, end_idx, order, which):
            out = []
            last_ok = end_idx - order
            for i in range(order, last_ok + 1):
                window = vals[i - order : i + order + 1]
                v = vals[i]
                if which == "high":
                    if float(window.max()) == v and int(window.argmax()) == order:
                        out.append((i, float(v)))
                else:
                    if v <= float(window.min()) and int(window.argmin()) == order:
                        out.append((i, float(v)))
            return out

        rng = np.random.default_rng(42)
        series = [
            rng.normal(0, 1, size=180).cumsum() + 100,
            np.full(80, 50.0),  # 全平，并列极值
            np.array([1, 3, 2, 5, 4, 7, 6, 9, 8, 4, 3, 2, 8, 1, 0, 4] * 6, dtype=float),
        ]
        for arr in series:
            df = pd.DataFrame({
                "open": arr,
                "high": arr + 0.4,
                "low": arr - 0.4,
                "close": arr,
            })
            for which, col in (("high", "high"), ("low", "low")):
                vals = df[col].to_numpy(dtype=float)
                for end in (10, 25, 40, len(df) - 1):
                    got = confirmed_swings(df, end_idx=end, which=which, order=5)
                    self.assertEqual(got, brute(vals, end, 5, which), msg=f"{which} end={end}")
                # 全序列计算再截取，应与 prefix 查询相同
                all_sw, idxs = _compute_all_swings(vals, 5, which)
                self.assertEqual([s[0] for s in all_sw], idxs)


class PullbackCloseConfirmTests(unittest.TestCase):
    def test_wick_only_is_not_close_confirm(self) -> None:
        row = pd.Series({"open": 100.0, "high": 105.0, "low": 99.5, "close": 100.5})
        level = 104.0
        self.assertTrue(wick_only_break(pd.DataFrame([row]), bar_idx=0, level=level, side="long"))
        self.assertFalse(close_confirms_break(row, level, side="long"))
        self.assertFalse(close_confirms_breakout(row, level, side="long"))

    def test_close_above_confirms(self) -> None:
        row = pd.Series({"open": 100.0, "high": 106.0, "low": 99.5, "close": 105.0})
        self.assertTrue(close_confirms_break(row, 104.0, side="long"))
        self.assertFalse(wick_only_break(pd.DataFrame([row]), bar_idx=0, level=104.0, side="long"))


class OpportunityAndAblationTests(unittest.TestCase):
    def test_opportunity_does_not_invent_winrate_weights(self) -> None:
        from oi_mornitor.opportunity_score import assess

        a = assess(
            symbol="BTCUSDT",
            side_intent="long",
            regime_4h="trend_up",
            regime_1h="trend_up",
            structure_1h="bos",
            htf_aligned=True,
            close_confirmed=True,
            pattern="trend_pullback_continuation",
        )
        d = a.to_dict()
        self.assertFalse(d["weightsAreTrained"])
        self.assertEqual(d["decision"], "long")
        self.assertNotIn("winRateWeight", d)

    def test_ablation_drop_double_bottom(self) -> None:
        from oi_mornitor.strategy_ablation import FILTER_DROP_DOUBLE_BOTTOM, contribution_report

        rows = [
            {"symbol": "BTC", "signalAt": 1, "kind": "bottom_secondary_test", "side": "bull",
             "outcome": "stop_loss", "pnlPct": -1.1, "typeLabel": "底部二次探底确认"},
            {"symbol": "BTC", "signalAt": 2, "kind": "liquidity_sweep", "side": "bear",
             "outcome": "take_profit", "pnlPct": 0.8, "complete": True},
            {"symbol": "ETH", "signalAt": 3, "kind": "hs_vegas_break", "side": "bear",
             "outcome": "stop_loss", "pnlPct": -0.5},
        ]
        rep = contribution_report(rows, filter_names=[FILTER_DROP_DOUBLE_BOTTOM], combinations=False)
        drop = next(x for x in rep["experiments"] if FILTER_DROP_DOUBLE_BOTTOM in x["filters"])
        self.assertEqual(drop["dropped"], 1)
        self.assertEqual(drop["droppedLosing"], 1)
        self.assertEqual(drop["n"], 2)


class DecisionLayerTests(unittest.TestCase):
    def test_walk_forward_and_overlap(self) -> None:
        from oi_mornitor.strategy.decision_layer import (
            combined_equity_disclaimer,
            dedupe_overlapping_trades,
            strategies_for_regime,
            walk_forward_windows,
        )

        self.assertIn("trend_pullback_continuation", strategies_for_regime("trend_up", "trend_up"))
        self.assertIn("range_mean_reversion", strategies_for_regime("range", "range"))
        wins = walk_forward_windows(0, 180 * 86_400_000)
        self.assertGreater(len(wins), 0)
        self.assertIn("developStart", wins[0])
        self.assertIn("testEnd", wins[0])
        kept, dropped = dedupe_overlapping_trades([
            {"symbol": "BTCUSDT", "strategy": "trend_pullback_continuation", "signalAt": 1000, "timeoutBars": 24},
            {"symbol": "BTCUSDT", "strategy": "range_mean_reversion", "signalAt": 1500, "timeoutBars": 16},
        ])
        self.assertEqual(len(kept), 1)
        self.assertEqual(len(dropped), 1)
        self.assertIn("不是已验证", combined_equity_disclaimer())


if __name__ == "__main__":
    unittest.main()
