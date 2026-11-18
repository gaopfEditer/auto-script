"""报告队列：5 分钟聚合、多周期、空窗不落盘、周期最低 5m、放量缺失为未知。"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from oi_mornitor.report_queue import (
    ReportQueue,
    classify_volume_surge,
    interval_seconds,
    is_min_interval,
    normalize_interval_label,
)

_TZ = timezone(timedelta(hours=8))


def _dt(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=_TZ)


class IntervalAndVolumeHelpersTests(unittest.TestCase):
    def test_interval_seconds_and_min_5m(self) -> None:
        self.assertEqual(interval_seconds("1m"), 60)
        self.assertEqual(interval_seconds("5m"), 300)
        self.assertEqual(interval_seconds("15min"), 900)
        self.assertEqual(interval_seconds("1h"), 3600)
        self.assertEqual(interval_seconds("4h"), 14400)
        self.assertEqual(normalize_interval_label("15min"), "15m")
        self.assertFalse(is_min_interval("1m"))
        self.assertTrue(is_min_interval("5m"))
        self.assertTrue(is_min_interval("1h"))

    def test_volume_missing_is_unknown(self) -> None:
        status, ratio = classify_volume_surge({}, threshold=1.2)
        self.assertEqual(status, "unknown")
        self.assertIsNone(ratio)

        status, ratio = classify_volume_surge({"vol_ratio": "x"}, threshold=1.2)
        self.assertEqual(status, "unknown")
        self.assertIsNone(ratio)

        status, ratio = classify_volume_surge({"vol_ratio": 1.5}, threshold=1.2)
        self.assertEqual(status, "yes")
        self.assertEqual(ratio, 1.5)

        status, ratio = classify_volume_surge({"climax_vol_ratio": 0.8}, threshold=1.2)
        self.assertEqual(status, "no")
        self.assertEqual(ratio, 0.8)


class ReportQueueTests(unittest.TestCase):
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

    def test_five_minute_aggregation(self) -> None:
        t0 = _dt("2026-11-18 16:01:00")
        t1 = _dt("2026-11-18 16:04:00")
        t2 = _dt("2026-11-18 16:06:10")
        self.q.ingest_pattern_alerts(
            [
                {
                    "symbol": "BTCUSDT",
                    "interval": "5m",
                    "side": "bull",
                    "type_label": "看涨吞没",
                    "vol_ratio": 1.6,
                    "time": t0.timestamp(),
                }
            ],
            now=t0,
        )
        self.q.ingest_pattern_alerts(
            [
                {
                    "symbol": "ETHUSDT",
                    "interval": "15m",
                    "side": "bear",
                    "type_label": "射击之星",
                    "vol_ratio": 0.9,
                    "time": t1.timestamp(),
                }
            ],
            now=t1,
        )
        # 窗尚未结束：不应生成正式报告
        self.assertEqual(self.q.flush_due(now=_dt("2026-11-18 16:04:59")), [])
        self.assertEqual(self.q.list_reports(), [])
        pending = self.q.pending_report(now=_dt("2026-11-18 16:04:59"))
        self.assertIsNotNone(pending)
        self.assertTrue(pending["pending"])
        self.assertEqual(pending["itemCount"], 2)
        self.assertEqual(pending["windowLabel"], "16:00–16:05")

        created = self.q.flush_due(now=_dt("2026-11-18 16:05:00"))
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0]["windowLabel"], "16:00–16:05")
        self.assertEqual(created[0]["itemCount"], 2)
        symbols = {i["symbol"] for i in created[0]["items"]}
        self.assertEqual(symbols, {"BTCUSDT", "ETHUSDT"})

        self.q.ingest_pattern_alerts(
            [
                {
                    "symbol": "SOLUSDT",
                    "interval": "1h",
                    "side": "bull",
                    "type_label": "倒锤子",
                    "vol_ratio": 2.0,
                    "time": t2.timestamp(),
                }
            ],
            now=t2,
        )
        created2 = self.q.flush_due(now=_dt("2026-11-18 16:10:00"))
        self.assertEqual(len(created2), 1)
        self.assertEqual(created2[0]["windowLabel"], "16:05–16:10")
        self.assertEqual(created2[0]["items"][0]["symbol"], "SOLUSDT")
        reports = self.q.list_reports()
        self.assertEqual([r["windowLabel"] for r in reports], ["16:05–16:10", "16:00–16:05"])

    def test_multi_timeframe_included(self) -> None:
        now = _dt("2026-11-18 16:03:00")
        patterns = [
            {"symbol": "BTCUSDT", "interval": "5m", "side": "bull", "type_label": "锤子线", "vol_ratio": 1.4, "time": now.timestamp()},
            {"symbol": "ETHUSDT", "interval": "15m", "side": "bear", "type_label": "吞没", "vol_ratio": 1.1, "time": now.timestamp()},
            {"symbol": "QQQ", "interval": "4h", "side": "bull", "type_label": "倒锤子", "source": "equity_pattern", "time": now.timestamp()},
        ]
        oi_rows = [
            {
                "symbol": "SOLUSDT",
                "status": "pump",
                "is_alert": True,
                "triggered_windows": ["5m"],
                "delta_5m_usd": 800000,
                "pct_5m": 3.2,
                "oi_by_tf": {
                    "5m": {"delta_usd": 800000, "pct": 3.2},
                    "15m": {"delta_usd": 10000, "pct": 0.2},
                    "1h": {"delta_usd": 900000, "pct": 4.0},
                    "4h": {"delta_usd": 1_200_000, "pct": 5.5},
                },
                "scan_ts": now.timestamp(),
            }
        ]
        self.q.ingest_pattern_alerts(patterns, now=now)
        self.q.ingest_oi_rows(oi_rows, now=now, usd_limit=500000, pct_limit=2.5)
        report = self.q.flush_due(now=_dt("2026-11-18 16:05:00"))[0]
        intervals = {(i["symbol"], i["interval"], i["kind"]) for i in report["items"]}
        self.assertIn(("BTCUSDT", "5m", "pattern"), intervals)
        self.assertIn(("ETHUSDT", "15m", "pattern"), intervals)
        self.assertIn(("QQQ", "4h", "pattern"), intervals)
        self.assertIn(("SOLUSDT", "5m", "oi_anomaly"), intervals)
        self.assertIn(("SOLUSDT", "1h", "oi_anomaly"), intervals)
        self.assertIn(("SOLUSDT", "4h", "oi_anomaly"), intervals)
        self.assertNotIn(("SOLUSDT", "15m", "oi_anomaly"), intervals)
        qqq = next(i for i in report["items"] if i["symbol"] == "QQQ")
        self.assertEqual(qqq["volumeSurge"], "unknown")
        self.assertEqual(qqq["volumeSurgeLabel"], "未知")

    def test_empty_window_does_not_create_report(self) -> None:
        created = self.q.flush_due(now=_dt("2026-11-18 16:05:00"))
        self.assertEqual(created, [])
        self.assertEqual(self.q.list_reports(), [])
        self.assertIsNone(self.q.pending_report(now=_dt("2026-11-18 16:04:00")))
        payload = self.q.payload(now=_dt("2026-11-18 16:05:01"))
        self.assertEqual(payload["reports"], [])
        self.assertIsNone(payload["pending"])

    def test_min_interval_excludes_1m_keeps_5m(self) -> None:
        now = _dt("2026-11-18 16:02:00")
        added = self.q.ingest_pattern_alerts(
            [
                {"symbol": "BTCUSDT", "interval": "1m", "side": "bull", "type_label": "1m形态", "vol_ratio": 2.0, "time": now.timestamp()},
                {"symbol": "ETHUSDT", "interval": "5m", "side": "bull", "type_label": "5m形态", "vol_ratio": 2.0, "time": now.timestamp()},
            ],
            now=now,
        )
        self.assertEqual(added, 1)
        report = self.q.flush_due(now=_dt("2026-11-18 16:05:00"))[0]
        self.assertEqual([i["interval"] for i in report["items"]], ["5m"])
        self.assertEqual(report["items"][0]["symbol"], "ETHUSDT")

    def test_volume_missing_unknown_and_dedupe(self) -> None:
        now = _dt("2026-11-18 16:02:00")
        alert = {
            "symbol": "BTCUSDT",
            "interval": "15m",
            "side": "bull",
            "type_label": "看涨吞没",
            "kind": "engulfing",
            "kline_close_time": int(now.timestamp()),
        }
        self.assertEqual(self.q.ingest_pattern_alerts([alert], now=now), 1)
        self.assertEqual(self.q.ingest_pattern_alerts([alert], now=now), 0)
        report = self.q.flush_due(now=_dt("2026-11-18 16:05:00"))[0]
        self.assertEqual(report["itemCount"], 1)
        item = report["items"][0]
        self.assertEqual(item["volumeSurge"], "unknown")
        self.assertEqual(item["volumeSurgeLabel"], "未知")
        self.assertIsNone(item["volumeRatio"])
        self.assertEqual(item["pattern"], "看涨吞没")
        self.assertEqual(item["sideLabel"], "多")
        self.assertEqual(item["interval"], "15m")

    def test_oi_suppressed_not_included_unless_other_tf_triggers(self) -> None:
        now = _dt("2026-11-18 16:02:00")
        self.q.ingest_oi_rows(
            [
                {
                    "symbol": "AAAUSDT",
                    "status": "suppressed",
                    "is_alert": False,
                    "is_hot": True,
                    "is_historic_anomaly": False,
                    "triggered_windows": [],
                    "oi_by_tf": {"5m": {"delta_usd": 100, "pct": 0.1}},
                    "scan_ts": now.timestamp(),
                }
            ],
            now=now,
            usd_limit=500000,
            pct_limit=2.5,
        )
        self.assertEqual(self.q.flush_due(now=_dt("2026-11-18 16:05:00")), [])


if __name__ == "__main__":
    unittest.main()
