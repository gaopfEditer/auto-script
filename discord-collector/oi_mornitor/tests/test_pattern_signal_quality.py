"""形态信号质量：门控、signalAt、MTF、SL 地板、胜率汇总口径。"""
from __future__ import annotations

import os
import unittest
from unittest import mock

import pandas as pd

from oi_mornitor.pattern_alert_stats import (
    alert_stats_key,
    apply_settle_updates,
    record_alert_from_push,
    summarize,
)
from oi_mornitor.pattern_stats_admission import (
    canonical_stats_key_from_record,
    is_observation_stats_record,
    passes_ma144_t3_15m_gate,
    stats_cooldown_blocks,
)
from oi_mornitor.pattern_push_gate import passes_push_mtf_gate
from oi_mornitor.pattern_settle_profile import build_settle_plan, resolve_verify_delay_ms
from oi_mornitor.pattern_signal_time import align_signal_at_ms, resolve_signal_at_from_alert
from oi_mornitor.strategy.candle_signals import htf_trend_gate_ok


class AlertStatsKeyTests(unittest.TestCase):
    def test_key_uses_kind_side_not_message(self) -> None:
        a = {
            "type": "candle_pattern_card",
            "symbol": "BTCUSDT",
            "kline_close_time": 1_700_000_000_000,
            "kind": "shooting_star",
            "side": "bear",
            "message": "射击之星 · 15m",
            "type_label": "射击之星",
        }
        b = {**a, "message": "另一段文案"}
        self.assertEqual(alert_stats_key(a), alert_stats_key(b))
        self.assertIn("shooting_star", alert_stats_key(a))
        self.assertIn("short", alert_stats_key(a))


class SignalAtTests(unittest.TestCase):
    def test_kline_close_aligned_not_scan_ts(self) -> None:
        close_ms = 1_700_000_000_000
        scan_ms = close_ms + 3600_000
        alert = {
            "kline_close_time": close_ms,
            "scan_ts": scan_ms / 1000.0,
            "time": close_ms // 1000,
        }
        self.assertEqual(resolve_signal_at_from_alert(alert), align_signal_at_ms(close_ms))


class MtfGateTests(unittest.TestCase):
    def test_single_interval_blocked_when_min_two(self) -> None:
        alert = {
            "type": "candle_pattern_card",
            "symbol": "ETHUSDT",
            "interval": "15m",
            "kind": "shooting_star",
            "side": "bear",
            "type_label": "射击之星",
            "kline_close_time": 1_700_000_000_000,
            "price": 3000.0,
            "close": 3000.0,
        }
        with mock.patch.dict(os.environ, {"OI_PATTERN_PUSH_MTF_MIN": "2"}, clear=False):
            from oi_mornitor import config
            import oi_mornitor.pattern_push_gate as pg

            config.OI_PATTERN_PUSH_MTF_MIN = 2
            pg.OI_PATTERN_PUSH_MTF_MIN = 2
            self.assertFalse(passes_push_mtf_gate(alert, peers=[]))

    def test_resonance_passes_with_two_intervals(self) -> None:
        t = 1_700_000_000_000
        peers = [
            {
                "key": "k1",
                "symbol": "ETH",
                "tradeSymbol": "ETHUSDT",
                "side": "short",
                "dir": "空",
                "signalAt": t,
                "typeLabel": "射击之星",
                "interval": "15m",
            },
            {
                "key": "k2",
                "symbol": "ETH",
                "tradeSymbol": "ETHUSDT",
                "side": "short",
                "dir": "空",
                "signalAt": t + 60_000,
                "typeLabel": "射击之星",
                "interval": "1h",
            },
        ]
        alert = {
            "type": "candle_pattern_card",
            "symbol": "ETHUSDT",
            "interval": "4h",
            "kind": "shooting_star",
            "side": "bear",
            "type_label": "射击之星",
            "kline_close_time": t + 120_000,
            "price": 3000.0,
            "close": 3000.0,
        }
        with mock.patch.dict(os.environ, {"OI_PATTERN_PUSH_MTF_MIN": "2"}, clear=False):
            from oi_mornitor import config
            import oi_mornitor.pattern_push_gate as pg

            config.OI_PATTERN_PUSH_MTF_MIN = 2
            pg.OI_PATTERN_PUSH_MTF_MIN = 2
            self.assertTrue(passes_push_mtf_gate(alert, peers=peers))


class SettleProfileTests(unittest.TestCase):
    def test_15m_verify_window_six_hours(self) -> None:
        rec = {"interval": "15m", "tradeSymbol": "DOGEUSDT", "mcapTier": "t3"}
        delay = resolve_verify_delay_ms(rec)
        self.assertEqual(delay, 6 * 60 * 60 * 1000)

    def test_sl_floor_widens_tight_invalid(self) -> None:
        rec = {
            "side": "long",
            "entry": 100.0,
            "invalid_level": 99.9,
            "tradeSymbol": "DOGEUSDT",
            "interval": "15m",
            "typeLabel": "倒锤子",
        }
        plan = build_settle_plan(rec, atr=0.1)
        dist_pct = (rec["entry"] - plan.sl_price) / rec["entry"] * 100
        self.assertGreaterEqual(dist_pct, 0.79)


class SummarizeTests(unittest.TestCase):
    def test_excludes_observation_flat_error_from_headline(self) -> None:
        rows = [
            {"outcome": "take_profit", "entry": 1, "side": "long", "symbol": "A"},
            {"outcome": "stop_loss", "entry": 1, "side": "long", "symbol": "B"},
            {"outcome": "flat", "entry": 1, "side": "long", "symbol": "C"},
            {"outcome": "error", "entry": 1, "side": "long", "symbol": "D"},
            {
                "outcome": "take_profit",
                "entry": 1,
                "side": "long",
                "symbol": "E",
                "observation_only": True,
            },
        ]
        s = summarize(rows)
        self.assertEqual(s["wins"], 1)
        self.assertEqual(s["losses"], 1)
        self.assertEqual(s["total"], 2)
        self.assertEqual(s["flats"], 1)
        self.assertEqual(s["errors"], 1)
        self.assertAlmostEqual(s["winRate"], 0.5)


class HtfTrendTests(unittest.TestCase):
    def _df_with_trend(self, pct: float, n: int = 30) -> pd.DataFrame:
        closes = [100.0]
        step = pct / (n - 2) / 100.0 * 100.0
        for _ in range(n - 1):
            closes.append(closes[-1] * (1 + step / 100.0))
        rows = []
        for i, c in enumerate(closes):
            rows.append({"open_time": i * 3_600_000, "close": c})
        return pd.DataFrame(rows)

    def test_shoot_needs_htf_uptrend(self) -> None:
        up = self._df_with_trend(5.0)
        self.assertTrue(
            htf_trend_gate_ok(
                {"4h": up},
                signal_close_ms=29 * 3_600_000,
                card_kind="shooting_star",
            )
        )
        down = self._df_with_trend(-5.0)
        self.assertFalse(
            htf_trend_gate_ok(
                {"4h": down},
                signal_close_ms=29 * 3_600_000,
                card_kind="shooting_star",
            )
        )


class DualKeyMergeTests(unittest.TestCase):
    def test_canonical_key_from_legacy_message_key(self) -> None:
        legacy = {
            "key": "candle_pattern_card:IRYSUSDT:1730000000000:射击之星·15m",
            "typeLabel": "射击之星",
            "side": "short",
            "interval": "15m",
            "signalAt": 1_730_000_000_000,
        }
        canon = canonical_stats_key_from_record(legacy)
        self.assertIn("shooting_star", canon)
        self.assertTrue(canon.endswith(":short"))


class ObservationStatsTests(unittest.TestCase):
    def test_c_tier_and_confluence_flag(self) -> None:
        self.assertTrue(
            is_observation_stats_record({"confluence_observation_only": True, "outcome": "pending"})
        )
        self.assertTrue(
            is_observation_stats_record(
                {"confluence": {"tier": "C", "score": 55}, "outcome": "pending"}
            )
        )
        self.assertFalse(
            is_observation_stats_record(
                {"confluence": {"tier": "B", "score": 72}, "outcome": "pending"}
            )
        )


class SettleAdmissionTests(unittest.TestCase):
    def test_apply_settle_updates_rejects_new_rows(self) -> None:
        with mock.patch("oi_mornitor.pattern_alert_stats._load", return_value=[]):
            with mock.patch("oi_mornitor.pattern_alert_stats._save", return_value=[]) as save_mock:
                apply_settle_updates(
                    [
                        {
                            "key": "candle_pattern_card:ETHUSDT:1:shooting_star:short",
                            "signalAt": 1,
                            "entry": 1.0,
                            "side": "short",
                            "outcome": "take_profit",
                        }
                    ]
                )
        save_mock.assert_called_once()
        saved = save_mock.call_args[0][0]
        self.assertEqual(saved, [])


class StatsCooldownTests(unittest.TestCase):
    def test_same_side_blocked_within_four_bars(self) -> None:
        t = 1_700_000_000_000
        existing = [
            {
                "tradeSymbol": "IRYSUSDT",
                "interval": "15m",
                "side": "long",
                "signalAt": t,
            }
        ]
        alert = {
            "symbol": "IRYSUSDT",
            "interval": "15m",
            "side": "bull",
            "kline_close_time": t + 15 * 60_000 * 2,
        }
        self.assertTrue(stats_cooldown_blocks(alert, existing))

    def test_opposite_blocked_within_six_bars(self) -> None:
        t = 1_700_000_000_000
        existing = [
            {
                "tradeSymbol": "IRYSUSDT",
                "interval": "15m",
                "side": "short",
                "signalAt": t,
            }
        ]
        alert = {
            "symbol": "IRYSUSDT",
            "interval": "15m",
            "side": "bull",
            "kline_close_time": t + 15 * 60_000 * 4,
        }
        self.assertTrue(stats_cooldown_blocks(alert, existing))


class Ma144T3GateTests(unittest.TestCase):
    def test_t3_15m_needs_mtf_or_score(self) -> None:
        alert = {
            "type": "ma144_candle_card",
            "symbol": "IRYSUSDT",
            "interval": "15m",
            "kind": "inverted_hammer",
            "side": "bull",
            "kline_close_time": 1_700_000_000_000,
            "confluence": {"score": 50, "tier": "C"},
        }
        with mock.patch("oi_mornitor.mcap_tier.resolve_mcap_tier", return_value="t3"):
            with mock.patch(
                "oi_mornitor.pattern_push_gate.mtf_tier_count_for_alert",
                return_value=1,
            ):
                with mock.patch.dict(os.environ, {"OI_MA144_T3_15M_MIN_SCORE": "70"}, clear=False):
                    from oi_mornitor import config

                    config.OI_MA144_T3_15M_MIN_SCORE = 70.0
                    self.assertFalse(passes_ma144_t3_15m_gate(alert, peers=[]))
            with mock.patch(
                "oi_mornitor.pattern_push_gate.mtf_tier_count_for_alert",
                return_value=2,
            ):
                self.assertTrue(passes_ma144_t3_15m_gate(alert, peers=[]))


class CandleConfigUnifyTests(unittest.TestCase):
    def test_candle_card_config_reads_config_module(self) -> None:
        from oi_mornitor import config
        from oi_mornitor.candle_card_config import (
            CANDLE_HAMMER_TREND_MIN_PCT,
            CANDLE_SHOOT_REQUIRE_POSITION,
            CANDLE_VOL_BYPASS_CONTEXT,
        )

        self.assertIs(CANDLE_SHOOT_REQUIRE_POSITION, config.CANDLE_SHOOT_REQUIRE_POSITION)
        self.assertIs(CANDLE_VOL_BYPASS_CONTEXT, config.CANDLE_VOL_BYPASS_CONTEXT)
        self.assertEqual(CANDLE_HAMMER_TREND_MIN_PCT, config.CANDLE_HAMMER_TREND_MIN_PCT)


if __name__ == "__main__":
    unittest.main()
