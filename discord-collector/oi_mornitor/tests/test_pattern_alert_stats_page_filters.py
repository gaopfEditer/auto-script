"""形态信号列表 API 分页筛选：独立维度 AND；MTF peer 不因单周期筛空。"""
from __future__ import annotations

import time
import unittest
from unittest import mock

from oi_mornitor.pattern_alert_stats import list_alert_stats_page


def _row(
    key: str,
    *,
    sat_offset_ms: int,
    interval: str,
    type_label: str,
    side: str = "short",
    symbol: str = "BTC",
) -> dict:
    now = int(time.time() * 1000)
    return {
        "key": key,
        "symbol": symbol,
        "side": side,
        "dir": "空" if side == "short" else "多",
        "signalAt": now - sat_offset_ms,
        "typeLabel": type_label,
        "interval": interval,
        "outcome": "pending",
        "assetClass": "crypto",
    }


class PatternAlertStatsPageFilterTests(unittest.TestCase):
    def setUp(self) -> None:
        # 同币同向同族：15m + 1h 在 4h 窗内 → 应共振
        self.rows = [
            _row("a15", sat_offset_ms=30 * 60 * 1000, interval="15m", type_label="倒锤子"),
            _row("a1h", sat_offset_ms=40 * 60 * 1000, interval="1h", type_label="倒锤子"),
            _row(
                "b4h",
                sat_offset_ms=10 * 24 * 3600 * 1000,
                interval="4h",
                type_label="射击之星",
            ),
        ]

    def test_type_label_filter(self) -> None:
        with mock.patch("oi_mornitor.pattern_alert_stats._load", return_value=self.rows):
            out = list_alert_stats_page(type_label="射击之星", page=1, page_size=100)
        self.assertEqual(out["total"], 1)
        self.assertEqual(out["items"][0]["typeLabel"], "射击之星")

    def test_interval_filter(self) -> None:
        with mock.patch("oi_mornitor.pattern_alert_stats._load", return_value=self.rows):
            out = list_alert_stats_page(interval="1h", page=1, page_size=100)
        self.assertEqual(out["total"], 1)
        self.assertEqual(out["items"][0]["interval"], "1h")

    def test_mtf_only_not_empty(self) -> None:
        with mock.patch("oi_mornitor.pattern_alert_stats._load", return_value=self.rows):
            out = list_alert_stats_page(mtf_resonance_only=True, page=1, page_size=100)
        self.assertGreaterEqual(out["total"], 2)
        keys = {r["key"] for r in out["items"]}
        self.assertIn("a15", keys)
        self.assertIn("a1h", keys)

    def test_mtf_and_interval_intersection_uses_peer_pool(self) -> None:
        """单周期 + 仅共振：应用全库 peer，15m 行仍可因 1h peer 命中。"""
        with mock.patch("oi_mornitor.pattern_alert_stats._load", return_value=self.rows):
            out = list_alert_stats_page(
                mtf_resonance_only=True,
                interval="15m",
                page=1,
                page_size=100,
            )
        self.assertEqual(out["total"], 1)
        self.assertEqual(out["items"][0]["key"], "a15")
        self.assertTrue(out["items"][0].get("mtfResonance"))

    def test_confluence_exact_abc(self) -> None:
        rows = [dict(r) for r in self.rows]
        # 预置 confluence，跳过 attach 真实打分波动
        rows[0]["confluence"] = {"score": 90, "tier": "A"}
        rows[1]["confluence"] = {"score": 70, "tier": "B"}
        rows[2]["confluence"] = {"score": 40, "tier": "C"}

        def fake_attach(recs):
            # keep pre-seeded tiers
            return None

        with mock.patch("oi_mornitor.pattern_alert_stats._load", return_value=rows):
            with mock.patch(
                "oi_mornitor.signal_confluence.attach_signal_confluence",
                side_effect=fake_attach,
            ):
                only_a = list_alert_stats_page(
                    confluence_min_tier="A",
                    confluence_exact=True,
                    page=1,
                    page_size=100,
                )
                only_b = list_alert_stats_page(
                    confluence_min_tier="B",
                    confluence_exact=True,
                    page=1,
                    page_size=100,
                )
                only_c = list_alert_stats_page(
                    confluence_min_tier="C",
                    confluence_exact=True,
                    page=1,
                    page_size=100,
                )
        self.assertEqual(only_a["total"], 1)
        self.assertEqual(only_a["items"][0]["key"], "a15")
        self.assertEqual(only_b["total"], 1)
        self.assertEqual(only_b["items"][0]["key"], "a1h")
        self.assertEqual(only_c["total"], 1)
        self.assertEqual(only_c["items"][0]["key"], "b4h")


if __name__ == "__main__":
    unittest.main()
