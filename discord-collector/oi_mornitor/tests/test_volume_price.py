"""量价信号模块单测。"""
from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from oi_mornitor.volume_price.classify import ClassifyThresholds, classify_bars, fit_classify_thresholds
from oi_mornitor.volume_price.features import add_volume_price_features
from oi_mornitor.volume_price.signals import generate_signals
from oi_mornitor.volume_price.ticker_bridge import (
    klines_map_to_vp_df,
    scan_volume_price_ticker_alerts,
    volume_price_signal_to_alert,
)
from oi_mornitor.volume_price.signals import VolumePriceSignal


def _make_bars(n: int, *, symbol: str = "BTCUSDT", tf: str = "15m") -> pd.DataFrame:
    ts0 = 1_700_000_000_000
    rows = []
    price = 100.0
    for i in range(n):
        o = price
        c = price + 0.1
        h = max(o, c) + 0.05
        l = min(o, c) - 0.05
        vol = 1000.0
        rows.append(
            {
                "ts": ts0 + i * 900_000,
                "symbol": symbol,
                "tf": tf,
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": vol,
            }
        )
        price = c
    return pd.DataFrame(rows)


class VolumePriceFeaturesTest(unittest.TestCase):
    def test_oi_all_null_no_error(self) -> None:
        df = _make_bars(30)
        df["oi"] = np.nan
        out = add_volume_price_features(df)
        self.assertIn("vol_z", out.columns)
        self.assertIn("oi_z", out.columns)
        self.assertTrue(out["oi_z"].isna().all())

    def test_no_oi_column_no_error(self) -> None:
        df = _make_bars(30)
        out = add_volume_price_features(df)
        self.assertIn("efficiency", out.columns)
        self.assertTrue(out["oi_z"].isna().all())


class VolumePriceClassifyTest(unittest.TestCase):
    def test_thrust_small_volume_large_body(self) -> None:
        df = _make_bars(25)
        # 最后一根：小量、大实体阳线
        i = len(df) - 1
        df.loc[i, "open"] = 100.0
        df.loc[i, "close"] = 103.0
        df.loc[i, "high"] = 103.1
        df.loc[i, "low"] = 99.9
        df.loc[i, "volume"] = 800.0

        feat = add_volume_price_features(df)
        th = fit_classify_thresholds(feat.iloc[:-1])
        # 手动压低 vol_z 门槛，确保 thrust 可触发
        th = ClassifyThresholds(
            efficiency_high=0.5,
            efficiency_low=0.15,
            vol_z_high=2.0,
            vol_z_low=-1.0,
            range_z_high=2.0,
            range_z_low=-1.0,
        )
        last = feat.iloc[[i]].copy()
        last["h1_trend_end"] = False
        last["h1_dir"] = 1
        classified = classify_bars(last, th)
        self.assertEqual(classified.iloc[0]["bar_class"], "thrust")

    def test_effort_no_result_high_vol_doji(self) -> None:
        df = _make_bars(25)
        i = len(df) - 1
        df.loc[i, "open"] = 100.0
        df.loc[i, "close"] = 100.02
        df.loc[i, "high"] = 100.08
        df.loc[i, "low"] = 99.95
        df.loc[i, "volume"] = 8000.0
        # 前面几根保持窄幅，放大 range_z 对比
        for j in range(max(0, i - 5), i):
            df.loc[j, "high"] = df.loc[j, "close"] + 0.06
            df.loc[j, "low"] = df.loc[j, "close"] - 0.06

        feat = add_volume_price_features(df)
        th = ClassifyThresholds(
            efficiency_high=0.7,
            efficiency_low=0.25,
            vol_z_high=-1.0,
            vol_z_low=-2.0,
            range_z_high=2.0,
            range_z_low=0.5,
        )
        last = feat.iloc[[i]].copy()
        last["h1_trend_end"] = False
        last["h1_dir"] = 0
        classified = classify_bars(last, th)
        self.assertEqual(classified.iloc[0]["bar_class"], "effort_no_result")


class VolumePriceSignalsTest(unittest.TestCase):
    def test_generate_signals_runs_without_oi(self) -> None:
        df = _make_bars(40)
        # 补 1h 趋势过滤
        h1 = df.copy()
        h1["tf"] = "1h"
        h1["ts"] = h1["ts"] // 3_600_000 * 3_600_000
        full = pd.concat([df, h1], ignore_index=True)
        signals, enriched = generate_signals(full, signal_tfs=("15m",))
        self.assertIsInstance(signals, list)
        self.assertFalse(enriched.empty)


class VolumePriceTickerBridgeTest(unittest.TestCase):
    def test_klines_map_to_vp_df(self) -> None:
        k15 = {
            "BTCUSDT": [
                [1_700_000_000_000, "100", "101", "99", "100.5", "1000", 1_700_000_899_999],
            ]
        }
        df = klines_map_to_vp_df(k15, klines_map_1h={"BTCUSDT": k15["BTCUSDT"]})
        self.assertEqual(len(df), 2)
        self.assertIn("close_time", df.columns)

    def test_volume_price_signal_to_alert_types(self) -> None:
        sig = VolumePriceSignal(
            ts=1,
            symbol="BTCUSDT",
            tf="15m",
            side="long",
            kind="continuation",
            entry_hint=100.0,
            invalid_level=99.0,
            reason="1h偏多 + thrust 向上",
            score=0.8,
            observation_only=False,
            bar_class="thrust",
            signal_bar_index=10,
        )
        alert = volume_price_signal_to_alert(sig, kline_close_time=999, scan_ts=1.0)
        assert alert is not None
        self.assertEqual(alert["type"], "vp_cont_thrust")
        self.assertEqual(alert["type_label"], "量价推进·多")

    def test_scan_volume_price_ticker_alerts_empty(self) -> None:
        self.assertEqual(scan_volume_price_ticker_alerts({}), [])


if __name__ == "__main__":
    unittest.main()
