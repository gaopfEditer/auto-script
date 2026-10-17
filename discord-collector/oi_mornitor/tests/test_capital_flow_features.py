"""资金流特征：无前瞻、空环境默认、各特征触发。"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from oi_mornitor.capital_flow_config import CF_ENABLED
from oi_mornitor.capital_flow_features import (
    _oi_at_bar_close,
    compute_capital_flow,
    confluence_feature_keys,
    format_capital_flow_tg_line,
    klines_to_bars,
    signal_interval_cutoff_ms,
)
from oi_mornitor.pattern_signal_time import resolve_signal_at_from_alert

_15M = 900_000


def _kline(open_ms: int, o: float, h: float, l: float, c: float, v: float = 1000.0) -> list:
    close_ms = open_ms + _15M - 1
    return [open_ms, o, h, l, c, v, close_ms, v, 0, 0, 0, 0]


class CapitalFlowNoLookaheadTests(unittest.TestCase):
    def test_bars_exclude_future_klines(self) -> None:
        signal_ms = 1_700_000_000_000
        cutoff = signal_interval_cutoff_ms(signal_ms, "15m")
        klines = [
            _kline(signal_ms - 2 * _15M, 100, 101, 99, 100.5),
            _kline(signal_ms + _15M, 100, 105, 99, 104),
        ]
        bars = klines_to_bars(klines, signal_at_ms=signal_ms, interval="15m")
        self.assertEqual(len(bars), 1)
        self.assertLessEqual(int(bars[0]["close_time_ms"]), cutoff)

    def test_resolve_signal_at_from_signal_at_field(self) -> None:
        sat = 1_700_000_000_000
        self.assertEqual(resolve_signal_at_from_alert({"signalAt": sat}), sat)

    def test_empty_env_defaults_enabled(self) -> None:
        with mock.patch.dict(os.environ, {"OI_CAPITAL_FLOW_ENABLED": ""}, clear=False):
            import importlib
            import oi_mornitor.capital_flow_config as cfg

            importlib.reload(cfg)
            self.assertTrue(cfg.CF_ENABLED)


class OiLookupSecTests(unittest.TestCase):
    def test_oi_at_bar_close_uses_period_end_sec(self) -> None:
        t0 = 1_700_000_000_000
        k = _kline(t0, 100, 101, 99, 100.5)
        signal_ms = t0 + _15M
        bar = klines_to_bars([k], signal_at_ms=signal_ms, interval="15m")[0]
        snap_sec = int(bar["close_time_sec"])
        self.assertEqual(snap_sec, (t0 + _15M) // 1000)
        oi = [(snap_sec - 900, 1.0), (snap_sec, 2.0)]
        self.assertEqual(_oi_at_bar_close(oi, bar), 2.0)
        # 若误用 close_ms//1000 会落到上一根快照
        wrong_sec = int(bar["close_time_ms"]) // 1000
        self.assertLess(wrong_sec, snap_sec)
        self.assertEqual(_oi_at_bar_close([(wrong_sec, 99.0), (snap_sec, 2.0)], bar), 2.0)


class OiFlushTests(unittest.TestCase):
    def test_oi_flush_long_wick_long_bias(self) -> None:
        t0 = 1_700_000_000_000
        klines = []
        for i in range(10):
            o, c = 100.0, 99.5
            h, l = 100.5, 95.0 if i == 9 else 99.0
            klines.append(_kline(t0 + i * _15M, o, h, l, c, v=2000 if i == 9 else 800))
        signal_ms = t0 + 10 * _15M - 1
        bars_pre = klines_to_bars(klines, signal_at_ms=signal_ms, interval="15m")
        oi = [(int(b["close_time_sec"]), 1000.0) for b in bars_pre]
        oi[-1] = (oi[-1][0], 850.0)
        cf = compute_capital_flow(
            signal_at_ms=signal_ms,
            klines=klines,
            oi_series=oi,
            funding_rate=0.0,
            global_ls=[],
            top_pos_ls=[],
            taker_buy=[],
            interval="15m",
        )
        self.assertTrue(cf["flags"]["oi_flush"])
        self.assertEqual(cf["bias"]["oi_flush"], "long")
        feats = confluence_feature_keys(cf, "long")
        self.assertIn("feat:cf_oi_flush_align", feats)


class FundingTests(unittest.TestCase):
    def test_funding_extreme_short_bias_4h_interval(self) -> None:
        t0 = 1_700_000_000_000
        klines = [_kline(t0, 100, 101, 99, 100)]
        signal_ms = t0 + _15M - 1
        cf = compute_capital_flow(
            signal_at_ms=signal_ms,
            klines=klines,
            oi_series=[(t0 // 1000 + 899, 100.0)],
            funding_rate=0.0003,
            global_ls=[],
            top_pos_ls=[],
            taker_buy=[],
            funding_interval_hours=4.0,
        )
        self.assertTrue(cf["flags"]["funding_extreme"])
        self.assertIn("feat:cf_funding_align", confluence_feature_keys(cf, "short"))
        line = format_capital_flow_tg_line(cf)
        self.assertIn("资金：", line)


class DistributionTests(unittest.TestCase):
    def test_distribution_short_bias(self) -> None:
        t0 = 1_700_000_000_000
        klines = []
        for i in range(22):
            klines.append(_kline(t0 + i * _15M, 100, 101, 99, 100.8, v=500))
        klines[-1][5] = 2000
        klines[-1][1] = 100.9
        klines[-1][2] = 101.0
        klines[-1][3] = 100.85
        klines[-1][4] = 100.92
        signal_ms = t0 + 22 * _15M - 1
        bars_pre = klines_to_bars(klines, signal_at_ms=signal_ms, interval="15m")
        oi = [(int(b["close_time_sec"]), 1000.0 if i <= 18 else 850.0) for i, b in enumerate(bars_pre)]
        taker = [(int(b["time_sec"]), 0.42) for b in bars_pre]
        cf = compute_capital_flow(
            signal_at_ms=signal_ms,
            klines=klines,
            oi_series=oi,
            funding_rate=0.0,
            global_ls=[],
            top_pos_ls=[],
            taker_buy=taker,
            interval="15m",
        )
        self.assertTrue(cf["flags"]["distribution"])
        self.assertIn("feat:cf_distribution", confluence_feature_keys(cf, "short"))

    def test_distribution_against_long(self) -> None:
        t0 = 1_700_000_000_000
        klines = []
        for i in range(22):
            klines.append(_kline(t0 + i * _15M, 100, 101, 99, 100.8, v=500))
        klines[-1][5] = 2000
        klines[-1][1] = 100.9
        klines[-1][2] = 101.0
        klines[-1][3] = 100.85
        klines[-1][4] = 100.92
        signal_ms = t0 + 22 * _15M - 1
        bars_pre = klines_to_bars(klines, signal_at_ms=signal_ms, interval="15m")
        oi = [(int(b["close_time_sec"]), 1000.0 if i <= 18 else 850.0) for i, b in enumerate(bars_pre)]
        taker = [(int(b["time_sec"]), 0.42) for b in bars_pre]
        cf = compute_capital_flow(
            signal_at_ms=signal_ms,
            klines=klines,
            oi_series=oi,
            funding_rate=0.0,
            global_ls=[],
            top_pos_ls=[],
            taker_buy=taker,
            interval="15m",
        )
        self.assertTrue(cf["flags"]["distribution"])
        self.assertIn("feat:cf_distribution_against", confluence_feature_keys(cf, "long"))


if __name__ == "__main__":
    unittest.main()
