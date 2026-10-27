"""潜力信号窗口盈/回撤计算。"""
from __future__ import annotations

import unittest

from oi_mornitor.potential_outcome_eval import compute_window_excursions


def _klines_from_closes(closes: list[tuple[int, float, float, float]]) -> list[list]:
    """(open_time_ms, open, high, low, close) simplified to binance row."""
    rows = []
    for ot, o, h, l, c in closes:
        rows.append([ot, str(o), str(h), str(l), str(c), "1000", ot + 899_999, "0"])
    return rows


class TestPotentialOutcome(unittest.TestCase):
    def test_long_max_profit_and_drawdown(self) -> None:
        t0 = 1_700_000_000_000
        step = 15 * 60 * 1000
        # entry close 100 at t0; then high 110, low 95
        data = [
            (t0, 100, 100, 99, 100),
            (t0 + step, 100, 110, 98, 108),
            (t0 + 2 * step, 108, 109, 95, 97),
        ]
        end = t0 + 3 * step
        r = compute_window_excursions(
            _klines_from_closes(data),
            signal_time_ms=t0,
            window_end_ms=end,
            direction="long",
        )
        self.assertTrue(r.get("ok"))
        self.assertAlmostEqual(r["max_profit_pct"], 10.0, places=1)
        self.assertAlmostEqual(r["max_drawdown_pct"], 5.0, places=1)

    def test_short(self) -> None:
        t0 = 1_700_000_000_000
        step = 15 * 60 * 1000
        data = [
            (t0, 100, 101, 99, 100),
            (t0 + step, 100, 105, 90, 92),
        ]
        r = compute_window_excursions(
            _klines_from_closes(data),
            signal_time_ms=t0,
            window_end_ms=t0 + 2 * step,
            direction="short",
        )
        self.assertTrue(r.get("ok"))
        self.assertAlmostEqual(r["max_profit_pct"], 10.0, places=1)
        self.assertAlmostEqual(r["max_drawdown_pct"], 5.0, places=1)


if __name__ == "__main__":
    unittest.main()
