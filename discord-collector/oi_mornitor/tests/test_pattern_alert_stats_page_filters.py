"""形态信号列表 API 分页筛选口径（弹窗筛选依赖 list_alert_stats_page）。"""
from __future__ import annotations

import time
import unittest
from unittest import mock

from oi_mornitor.pattern_alert_stats import list_alert_stats_page


class PatternAlertStatsPageFilterTests(unittest.TestCase):
    def setUp(self) -> None:
        now = int(time.time() * 1000)
        self.rows = [
            {
                "key": "a",
                "signalAt": now - 3600 * 1000,
                "typeLabel": "射击之星",
                "interval": "15m",
                "outcome": "pending",
                "assetClass": "crypto",
            },
            {
                "key": "b",
                "signalAt": now - 10 * 24 * 3600 * 1000,
                "typeLabel": "顶部结构确认",
                "interval": "1h",
                "outcome": "pending",
                "assetClass": "crypto",
            },
        ]

    def test_type_label_filter(self) -> None:
        with mock.patch("oi_mornitor.pattern_alert_stats._load", return_value=self.rows):
            out = list_alert_stats_page(type_label="射击之星", page=1, page_size=100)
        self.assertEqual(out["total"], 1)
        self.assertEqual(out["items"][0]["typeLabel"], "射击之星")

    def test_time_filter(self) -> None:
        with mock.patch("oi_mornitor.pattern_alert_stats._load", return_value=self.rows):
            out = list_alert_stats_page(time_filter="2h", page=1, page_size=100)
        self.assertEqual(out["total"], 1)
        self.assertEqual(out["items"][0]["key"], "a")

    def test_interval_filter(self) -> None:
        with mock.patch("oi_mornitor.pattern_alert_stats._load", return_value=self.rows):
            out = list_alert_stats_page(interval="1h", page=1, page_size=100)
        self.assertEqual(out["total"], 1)
        self.assertEqual(out["items"][0]["interval"], "1h")


if __name__ == "__main__":
    unittest.main()
