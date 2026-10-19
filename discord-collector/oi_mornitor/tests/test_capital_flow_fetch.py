"""资金流拉取：费率选取逻辑。"""
from __future__ import annotations

import unittest

from oi_mornitor.capital_flow_fetch import pick_funding_rate_at


class PickFundingRateTests(unittest.TestCase):
    def test_full_page_picks_latest_not_oldest(self) -> None:
        signal_at = 1_700_000_000_000
        rows: list[dict[str, object]] = []
        for i in range(1000):
            ft = signal_at - (1000 - i) * 3_600_000
            rows.append({"fundingTime": ft, "fundingRate": "-0.0009"})
        rows[-1] = {"fundingTime": signal_at - 3_600_000, "fundingRate": "0.001"}
        got = pick_funding_rate_at(rows, signal_at)
        self.assertIsNotNone(got)
        self.assertAlmostEqual(got, 0.001, places=6)

    def test_over_1000_rows_still_latest_in_window(self) -> None:
        signal_at = 2_000_000_000_000
        rows = [
            {"fundingTime": signal_at - 5_000_000_000, "fundingRate": "-0.01"},
            {"fundingTime": signal_at - 1_000, "fundingRate": "0.0025"},
            {"fundingTime": signal_at + 60_000, "fundingRate": "0.99"},
        ]
        self.assertAlmostEqual(pick_funding_rate_at(rows, signal_at), 0.0025, places=6)


if __name__ == "__main__":
    unittest.main()
