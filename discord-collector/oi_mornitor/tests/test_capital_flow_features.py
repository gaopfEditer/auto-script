"""资金流特征：无前瞻、空环境默认、各特征触发。"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from oi_mornitor.capital_flow_config import CF_ENABLED
from oi_mornitor.capital_flow_features import (
    compute_capital_flow,
    confluence_feature_keys,
    format_capital_flow_tg_line,
    klines_to_bars,
)


def _kline(open_ms: int, o: float, h: float, l: float, c: float, v: float = 1000.0) -> list:
    return [open_ms, o, h, l, c, v, open_ms + 60_000, v, 0, 0, 0, 0]


class CapitalFlowNoLookaheadTests(unittest.TestCase):
    def test_bars_exclude_future_klines(self) -> None:
        signal_ms = 1_700_000_000_000
        klines = [
            _kline(signal_ms - 180_000, 100, 101, 99, 100.5),
            _kline(signal_ms + 60_000, 100, 105, 99, 104),
        ]
        bars = klines_to_bars(klines, signal_at_ms=signal_ms)
        self.assertEqual(len(bars), 1)

    def test_empty_env_defaults_enabled(self) -> None:
        with mock.patch.dict(os.environ, {"OI_CAPITAL_FLOW_ENABLED": ""}, clear=False):
            import importlib
            import oi_mornitor.capital_flow_config as cfg

            importlib.reload(cfg)
            self.assertTrue(cfg.CF_ENABLED)


class OiFlushTests(unittest.TestCase):
    def test_oi_flush_long_wick_long_bias(self) -> None:
        t0 = 1_700_000_000_000
        klines = []
        for i in range(10):
            o, c = 100.0, 99.5
            h, l = 100.5, 95.0 if i == 9 else 99.0
            klines.append(_kline(t0 + i * 900_000, o, h, l, c, v=2000 if i == 9 else 800))
        signal_ms = t0 + 9 * 900_000 + 1
        oi = [(t0 // 1000 + i * 900, 1000.0 - i * 5) for i in range(10)]
        oi[-1] = (oi[-1][0], 850.0)
        oi[-2] = (oi[-2][0], 1000.0)
        cf = compute_capital_flow(
            signal_at_ms=signal_ms,
            klines=klines,
            oi_series=oi,
            funding_rate=0.0,
            global_ls=[],
            top_pos_ls=[],
            taker_buy=[],
        )
        self.assertTrue(cf["flags"]["oi_flush"])
        self.assertEqual(cf["bias"]["oi_flush"], "long")
        feats = confluence_feature_keys(cf, "long")
        self.assertIn("feat:cf_oi_flush_align", feats)


class FundingTests(unittest.TestCase):
    def test_funding_extreme_short_bias(self) -> None:
        t0 = 1_700_000_000_000
        klines = [_kline(t0, 100, 101, 99, 100)]
        cf = compute_capital_flow(
            signal_at_ms=t0 + 1,
            klines=klines,
            oi_series=[(t0 // 1000, 100.0)],
            funding_rate=0.0006,
            global_ls=[],
            top_pos_ls=[],
            taker_buy=[],
        )
        self.assertTrue(cf["flags"]["funding_extreme"])
        self.assertIn("feat:cf_funding_align", confluence_feature_keys(cf, "short"))
        line = format_capital_flow_tg_line(cf)
        self.assertIn("资金：", line)
        self.assertIn("费率", line)


class DistributionTests(unittest.TestCase):
    def test_distribution_short_bias(self) -> None:
        t0 = 1_700_000_000_000
        klines = []
        for i in range(22):
            klines.append(_kline(t0 + i * 900_000, 100, 101, 99, 100.8, v=500))
        klines[-1][5] = 2000
        klines[-1][1] = 100.9
        klines[-1][2] = 101.0
        klines[-1][3] = 100.85
        klines[-1][4] = 100.92
        signal_ms = t0 + 21 * 900_000 + 1
        oi = [(t0 // 1000 + i * 900, 1000.0 if i <= 18 else 850.0) for i in range(22)]
        taker = [(t0 // 1000 + i * 900, 0.42) for i in range(22)]
        cf = compute_capital_flow(
            signal_at_ms=signal_ms,
            klines=klines,
            oi_series=oi,
            funding_rate=0.0,
            global_ls=[],
            top_pos_ls=[],
            taker_buy=taker,
        )
        self.assertTrue(cf["flags"]["distribution"])
        self.assertIn("feat:cf_distribution", confluence_feature_keys(cf, "short"))


if __name__ == "__main__":
    unittest.main()
