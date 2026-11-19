"""报告队列只收录并过滤 BTC/ETH 5m 放量影线。"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from oi_mornitor.report_queue import (
    ST_VOL_WICK_KIND,
    ReportQueue,
    list_report_queue_payload,
)

_TZ = timezone(timedelta(hours=8))


def _dt(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=_TZ)


def _sig(
    symbol: str,
    *,
    triggered: bool = True,
    side: str = "short",
    kind: str = "shooting_star",
    pattern: str = "放量射击之星",
    vol_ratio: float = 1.8,
    ts: int = 1763510700000,
) -> dict:
    return {
        "strategy": "st_5m_vol_wick_btc_eth_v0",
        "symbol": symbol,
        "interval": "5m",
        "signalTs": ts,
        "barOpenTime": ts,
        "side": side,
        "patternKind": kind,
        "pattern": pattern,
        "volumeRatio": vol_ratio,
        "volumeSurge": triggered,
        "triggered": triggered,
    }


class StVolWickReportQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.q = ReportQueue(
            Path(self.tmp.name) / "report_queue.db",
            window_sec=300,
            min_interval_sec=300,
            volume_threshold=1.5,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_ingests_only_triggered_btc_eth_long_and_short(self) -> None:
        now = _dt("2026-11-19 18:51:00")
        n = self.q.ingest_st_vol_wick_signals(
            [
                _sig("BTCUSDT", side="short"),
                _sig(
                    "ETH",
                    side="long",
                    kind="inverted_hammer",
                    pattern="放量倒锤子",
                    ts=1763510700000 + 1,
                ),
                _sig("BNBUSDT", ts=1763510700000 + 2),
                _sig("BTCUSDT", triggered=False, ts=1763510700000 + 3),
            ],
            now=now,
        )
        self.assertEqual(n, 2)
        pending = self.q.pending_report(now=now)
        self.assertIsNotNone(pending)
        items = {i["symbol"]: i for i in pending["items"]}
        self.assertEqual(set(items), {"BTCUSDT", "ETHUSDT"})
        self.assertEqual(items["BTCUSDT"]["kind"], ST_VOL_WICK_KIND)
        self.assertEqual(items["BTCUSDT"]["side"], "bear")
        self.assertEqual(items["BTCUSDT"]["pattern"], "放量射击之星")
        self.assertEqual(items["ETHUSDT"]["side"], "bull")
        self.assertEqual(items["ETHUSDT"]["pattern"], "放量倒锤子")
        self.assertEqual(items["BTCUSDT"]["interval"], "5m")
        self.assertEqual(items["BTCUSDT"]["volumeSurge"], "yes")

    def test_payload_filter_hides_other_kinds(self) -> None:
        now = _dt("2026-11-19 18:51:00")
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
        self.q.ingest_st_vol_wick_signals([_sig("BTCUSDT")], now=now)
        raw = list_report_queue_payload(now=now, queue=self.q)
        self.assertEqual(raw["pending"]["itemCount"], 2)
        filtered = list_report_queue_payload(
            now=now,
            kinds="st_vol_wick",
            symbols="BTCUSDT,ETHUSDT",
            queue=self.q,
        )
        self.assertIsNotNone(filtered["pending"])
        self.assertEqual(filtered["pending"]["itemCount"], 1)
        item = filtered["pending"]["items"][0]
        self.assertEqual(item["symbol"], "BTCUSDT")
        self.assertEqual(item["kind"], ST_VOL_WICK_KIND)
        self.assertEqual(item["pattern"], "放量射击之星")
        self.assertEqual(filtered["filter"]["kinds"], ["st_vol_wick"])

    def test_duplicate_same_bar_is_ignored(self) -> None:
        now = _dt("2026-11-19 18:51:00")
        first = self.q.ingest_st_vol_wick_signals([_sig("BTCUSDT")], now=now)
        second = self.q.ingest_st_vol_wick_signals([_sig("BTCUSDT")], now=now)
        self.assertEqual(first, 1)
        self.assertEqual(second, 0)


if __name__ == "__main__":
    unittest.main()
