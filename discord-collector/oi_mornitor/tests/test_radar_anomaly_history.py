"""雷达异动历史缓存。"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from oi_mornitor import radar_anomaly_history as rah


class RadarAnomalyHistoryTests(unittest.TestCase):
    def setUp(self) -> None:
        rah._MEMORY = None
        rah._LAST_BOARD_KEYS = set()

    def test_oi_price_upsert_and_prune(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hist.json"
            with mock.patch.object(rah, "_HISTORY_FILE", path):
                with mock.patch.object(rah, "OI_RADAR_ANOMALY_RETENTION_SEC", 3600):
                    row = {
                        "symbol": "ETHUSDT",
                        "status": "pump",
                        "delta_5m_usd": 600_000,
                        "pct_5m": 3.0,
                        "current_oi_usd": 50_000_000,
                        "pct_price_5m": 0.5,
                        "alert_ts": 1_700_000_000,
                    }
                    rah.ingest_oi_price_from_rows(
                        [row],
                        scan_ts=1_700_000_000,
                        oi_usd_limit=500_000,
                        oi_pct_limit=2.5,
                    )
                    payload = rah.history_payload()
                    self.assertGreaterEqual(len(payload["oi_price"]), 1)
                    ids = {x["id"] for x in payload["oi_price"]}
                    self.assertIn("oi-ETHUSDT-5m", ids)

    def test_board_enter_event(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hist.json"
            with mock.patch.object(rah, "_HISTORY_FILE", path):
                rows = [
                    {
                        "symbol": "BTCUSDT",
                        "status": "normal",
                        "pct_price_5m": 5.0,
                        "delta_5m_usd": 1_000_000,
                    },
                    {
                        "symbol": "ETHUSDT",
                        "status": "normal",
                        "pct_price_5m": 1.0,
                        "delta_5m_usd": 100_000,
                    },
                ]
                rah.ingest_board_from_rows(rows, scan_ts=1_700_000_100)
                payload = rah.history_payload()
                self.assertGreater(len(payload["board"]), 0)


if __name__ == "__main__":
    unittest.main()
