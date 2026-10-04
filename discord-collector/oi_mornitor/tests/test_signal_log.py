"""signal_log / signal_outcome 落库。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from oi_mornitor.signal_log import insert_outcome, insert_signal, list_signals


class SignalLogTest(unittest.TestCase):
    def test_insert_rejected_and_outcome(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "sig.db"
            sid = insert_signal(
                {
                    "symbol": "BTCUSDT",
                    "exchange": "binance_um",
                    "tf": "15m",
                    "bar_open_ts": 1000,
                    "bar_close_ts": 1899,
                    "side": "long",
                    "family": "pattern",
                    "kind": "hammer",
                    "price_close": 100.0,
                    "reject_reason": "continuous_wick",
                    "features": {"rvol": 1.2},
                    "tags": {"near_vegas": True},
                },
                db_path=db,
            )
            self.assertIsNotNone(sid)
            insert_outcome(
                int(sid),
                {
                    "exit_ts": 3000,
                    "exit_price": 101.0,
                    "pnl_pct": 0.8,
                    "pnl_r": 0.4,
                    "mfe_pct": 1.2,
                    "mae_pct": -0.3,
                    "bars_held": 4,
                    "exit_reason": "time",
                    "leverage": 100,
                    "fee_pct": 0.1,
                    "group_tag": "v_oi",
                },
                db_path=db,
            )
            rows = list_signals(db_path=db, symbol="BTCUSDT")
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["reject_reason"], "continuous_wick")
            self.assertEqual(rows[0]["kind"], "hammer")


if __name__ == "__main__":
    unittest.main()
