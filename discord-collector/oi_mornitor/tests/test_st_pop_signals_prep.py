"""5m POP v0：15m/1h 不足 200 根时仍能算趋势否决，不因缺少 ema72 报错。"""
from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from oi_mornitor.strategy.st_5m_pop.signals import _prep, _trend_veto, evaluate_last_closed_bar


def _bars(n: int, *, start: int = 1_000_000, step: int = 60_000, close0: float = 100.0) -> pd.DataFrame:
    rows = []
    price = close0
    for i in range(n):
        price = close0 + i * 0.01
        rows.append(
            {
                "open_time": start + i * step,
                "open": price,
                "high": price + 0.2,
                "low": price - 0.1,
                "close": price + 0.05,
                "volume": 10 + (i % 5),
            }
        )
    return pd.DataFrame(rows)


class PrepAndVetoTests(unittest.TestCase):
    def test_prep_adds_ema_below_200_bars(self) -> None:
        df = _prep(_bars(120))
        self.assertIn("ema72", df.columns)
        self.assertFalse(np.isnan(float(df.iloc[-1]["ema72"])))

    def test_evaluate_with_short_htf_does_not_raise(self) -> None:
        ev = evaluate_last_closed_bar(_bars(220, step=5 * 60 * 1000), _bars(120, step=15 * 60 * 1000), _bars(100, step=60 * 60 * 1000), symbol="BTCUSDT")
        self.assertIsNotNone(ev)
        self.assertIn("trendVeto", ev)
        self.assertIn("triggered", ev)

    def test_trend_veto_missing_ema_is_true(self) -> None:
        raw = _bars(20)
        self.assertTrue(_trend_veto(raw, raw, int(raw.iloc[-1]["open_time"])))


if __name__ == "__main__":
    unittest.main()
