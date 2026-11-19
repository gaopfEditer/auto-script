"""报告队列只收录并过滤 BTC/ETH 5m POP 试空。"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from oi_mornitor.report_queue import (
    ST_POP_SHORT_KIND,
    ReportQueue,
    list_report_queue_payload,
)

_TZ = timezone(timedelta(hours=8))


def _dt(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=_TZ)


def _sig(symbol: str, *, triggered: bool = True, score: int = 3, veto: bool = False, vol_z: bool = True, ts: int = 1763510700000) -> dict:
    return {
        "strategy": "st_5m_pop_short_btc_eth_v0",
        "symbol": symbol,
        "signalTs": ts,
        "barOpenTime": ts,
        "score": score,
        "checks": {"rush": True, "wick": True, "vol_z": vol_z, "resistance": score >= 3},
        "trendVeto": veto,
        "session": "asia",
        "side": "short",
        "triggered": triggered,
    }


class StPopReportQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.q = ReportQueue(
            Path(self.tmp.name) / "report_queue.db",
            window_sec=300,
            min_interval_sec=300,
            volume_threshold=1.2,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_ingests_only_triggered_btc_eth(self) -> None:
        now = _dt("2026-11-19 08:51:00")
        n = self.q.ingest_st_pop_signals(
            [
                _sig("BTCUSDT"),
                _sig("ETH", ts=1763510700000 + 1),
                _sig("BNBUSDT", ts=1763510700000 + 2),
                _sig("BTCUSDT", triggered=False, score=2, ts=1763510700000 + 3),
                _sig("ETHUSDT", veto=True, ts=1763510700000 + 4),
                _sig("BTCUSDT", triggered=True, score=2, ts=1763510700000 + 5),
            ],
            now=now,
        )
        self.assertEqual(n, 2)
        pending = self.q.pending_report(now=now)
        self.assertIsNotNone(pending)
        symbols = {i["symbol"] for i in pending["items"]}
        self.assertEqual(symbols, {"BTCUSDT", "ETHUSDT"})
        for item in pending["items"]:
            self.assertEqual(item["kind"], ST_POP_SHORT_KIND)
            self.assertEqual(item["interval"], "5m")
            self.assertEqual(item["pattern"], "短空")
            self.assertEqual(item["side"], "bear")

    def test_payload_filter_hides_other_patterns(self) -> None:
        now = _dt("2026-11-19 08:51:00")
        self.q.ingest_pattern_alerts(
            [
                {
                    "symbol": "AAPLUSDT",
                    "interval": "4h",
                    "side": "bull",
                    "type_label": "底部二次探底确认",
                    "vol_ratio": 1.6,
                    "time": now.timestamp(),
                }
            ],
            now=now,
        )
        self.q.ingest_st_pop_signals([_sig("BTCUSDT", vol_z=True)], now=now)
        raw = list_report_queue_payload(now=now, queue=self.q)
        self.assertEqual(raw["pending"]["itemCount"], 2)
        filtered = list_report_queue_payload(
            now=now,
            kinds="st_pop_short",
            symbols="BTCUSDT,ETHUSDT",
            queue=self.q,
        )
        self.assertIsNotNone(filtered["pending"])
        self.assertEqual(filtered["pending"]["itemCount"], 1)
        item = filtered["pending"]["items"][0]
        self.assertEqual(item["symbol"], "BTCUSDT")
        self.assertEqual(item["kind"], ST_POP_SHORT_KIND)
        self.assertEqual(item["pattern"], "短空")
        self.assertEqual(item["volumeSurge"], "yes")
        self.assertEqual(filtered["filter"]["kinds"], ["st_pop_short"])
        self.assertEqual(filtered["filter"]["symbols"], ["BTCUSDT", "ETHUSDT"])

    def test_duplicate_same_bar_is_ignored(self) -> None:
        now = _dt("2026-11-19 08:51:00")
        first = self.q.ingest_st_pop_signals([_sig("BTCUSDT")], now=now)
        second = self.q.ingest_st_pop_signals([_sig("BTCUSDT")], now=now)
        self.assertEqual(first, 1)
        self.assertEqual(second, 0)


if __name__ == "__main__":
    unittest.main()
