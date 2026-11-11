from __future__ import annotations

import unittest
from datetime import datetime, timezone

from post_card.backtest import run_backtest
from post_card.schema import TradeCard, SourceType


def _bars_long_uptrend() -> list[dict]:
    base = 1_700_000_000_000
    return [
        {"ts": base, "open": 100, "high": 101, "low": 99, "close": 100},
        {"ts": base + 60_000, "open": 100, "high": 102, "low": 97, "close": 101},
        {"ts": base + 120_000, "open": 101, "high": 108, "low": 100, "close": 107},
        {"ts": base + 180_000, "open": 107, "high": 110, "low": 106, "close": 109},
    ]


class BacktestTest(unittest.TestCase):
    def test_mfe_mae_drawdown_before_peak(self) -> None:
        t0 = datetime.fromtimestamp(1_700_000_000, tz=timezone.utc)
        card = TradeCard(
            source_type=SourceType.TELEGRAM,
            source_id="1",
            symbol="BTCUSDT",
            direction="long",
            entry="100",
            stop_loss="90",
            take_profit="120",
            opened_at=t0,
        )
        r = run_backtest(card, _bars_long_uptrend(), entry_override=100.0)
        self.assertAlmostEqual(r.max_favorable_pct or 0, 10.0, places=2)
        self.assertAlmostEqual(r.max_adverse_pct or 0, 3.0, places=2)
        self.assertAlmostEqual(r.drawdown_before_max_favorable_pct or 0, 3.0, places=2)

    def test_hit_tp(self) -> None:
        t0 = datetime.fromtimestamp(1_700_000_000, tz=timezone.utc)
        card = TradeCard(
            source_type=SourceType.TELEGRAM,
            source_id="1",
            symbol="BTCUSDT",
            direction="long",
            entry="100",
            stop_loss="90",
            take_profit="108",
            opened_at=t0,
        )
        r = run_backtest(card, _bars_long_uptrend(), entry_override=100.0)
        self.assertEqual(r.outcome, "hit_tp")


if __name__ == "__main__":
    unittest.main()
