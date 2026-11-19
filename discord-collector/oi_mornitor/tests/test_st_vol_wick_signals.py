"""5m 放量影线口径：阈值、方向与扫描入口。"""
from __future__ import annotations

import unittest

import pandas as pd

from oi_mornitor.strategy.st_5m_vol_wick.signals import (
    LOOSE_PIN_WICK_BODY,
    LOOSE_PIN_WICK_RANGE,
    VOL_MA_PERIOD,
    VOL_RATIO_MIN,
    WICK_BODY_RATIO,
    evaluate_last_closed_bar,
    scan_closed_bars,
)


def _bar(*, o, h, l, c, v, t=0):
    return {"open_time": t, "open": o, "high": h, "low": l, "close": c, "volume": v}


def _df(last: dict, *, n: int = VOL_MA_PERIOD, base_vol: float = 100.0) -> pd.DataFrame:
    rows = []
    for i in range(n - 1):
        rows.append(_bar(o=100, h=101, l=99, c=100.4, v=base_vol, t=i * 300_000))
    last = dict(last)
    last["open_time"] = (n - 1) * 300_000
    rows.append(last)
    return pd.DataFrame(rows)


class StVolWickSignalTests(unittest.TestCase):
    def test_thresholds_match_house_vol_pin(self) -> None:
        self.assertEqual(VOL_MA_PERIOD, 20)
        self.assertEqual(VOL_RATIO_MIN, 1.5)
        self.assertEqual(WICK_BODY_RATIO, 1.5)
        self.assertEqual(LOOSE_PIN_WICK_BODY, 1.05)
        self.assertEqual(LOOSE_PIN_WICK_RANGE, 0.32)

    def test_shooting_star_with_volume_is_short(self) -> None:
        # body 1, upper wick 2 (>=1.5x), no lower wick, vol 2x ma
        ev = evaluate_last_closed_bar(
            _df(_bar(o=100, h=103, l=100, c=101, v=200, t=0)),
            symbol="BTCUSDT",
        )
        self.assertIsNotNone(ev)
        self.assertTrue(ev["triggered"])
        self.assertEqual(ev["side"], "short")
        self.assertEqual(ev["patternKind"], "shooting_star")
        self.assertEqual(ev["pattern"], "放量射击之星")
        self.assertGreaterEqual(ev["volumeRatio"], VOL_RATIO_MIN)

    def test_inverted_hammer_with_volume_is_long(self) -> None:
        ev = evaluate_last_closed_bar(
            _df(_bar(o=100, h=101, l=97, c=100.5, v=200, t=0)),
            symbol="ETHUSDT",
        )
        self.assertIsNotNone(ev)
        self.assertTrue(ev["triggered"])
        self.assertEqual(ev["side"], "long")
        self.assertEqual(ev["patternKind"], "inverted_hammer")
        self.assertEqual(ev["pattern"], "放量倒锤子")

    def test_wick_without_volume_does_not_trigger(self) -> None:
        ev = evaluate_last_closed_bar(
            _df(_bar(o=100, h=103, l=100, c=101, v=100, t=0), base_vol=100.0),
            symbol="BTCUSDT",
        )
        self.assertIsNotNone(ev)
        self.assertFalse(ev["triggered"])
        self.assertEqual(ev["patternKind"], "shooting_star")

    def test_loose_upper_wick_with_volume_is_short(self) -> None:
        # body 2, upper 2.2 (>=1.05x body, 2.2/4.2>=0.32 range), not official 1.5x
        ev = evaluate_last_closed_bar(
            _df(_bar(o=100, h=104.2, l=100, c=102, v=200, t=0)),
            symbol="BTCUSDT",
        )
        self.assertIsNotNone(ev)
        self.assertTrue(ev["triggered"])
        self.assertEqual(ev["side"], "short")
        self.assertEqual(ev["patternKind"], "upper_wick")
        self.assertEqual(ev["pattern"], "放量上影")

    def test_scan_closed_bars_returns_triggered_only(self) -> None:
        df = _df(_bar(o=100, h=103, l=100, c=101, v=200, t=0))
        hits = scan_closed_bars(df, symbol="BTCUSDT")
        self.assertEqual(len(hits), 1)
        self.assertTrue(hits[0]["triggered"])
        all_bars = scan_closed_bars(df, symbol="BTCUSDT", triggered_only=False)
        self.assertEqual(len(all_bars), 1)  # only last bar has warmup end; wait
        # warmup uses n-1 flat bars + last; only last can trigger, but triggered_only=False
        # still only evaluates bars from index 19, so 1 bar.
        self.assertEqual(len(all_bars), 1)


if __name__ == "__main__":
    unittest.main()
