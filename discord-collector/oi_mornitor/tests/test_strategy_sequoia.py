"""Sequoia 策略 smoke：合成 K 线应能打出海龟/均量信号。"""
from __future__ import annotations

import numpy as np
import pandas as pd

from oi_mornitor.strategy_sequoia.strategies import detect_all, detect_turtle_trade, detect_ma_volume
from oi_mornitor.strategy_sequoia.bridge import hit_to_alert
from oi_mornitor.strategy_sequoia.registry import ALL_STRATEGY_IDS


def _synth(n: int = 120) -> pd.DataFrame:
    rng = np.random.default_rng(42)
    close = 100 + np.cumsum(rng.normal(0.05, 0.8, size=n))
    open_ = np.r_[close[0], close[:-1]]
    high = np.maximum(open_, close) + rng.uniform(0.1, 1.0, size=n)
    low = np.minimum(open_, close) - rng.uniform(0.1, 1.0, size=n)
    # 末段制造突破 + 放量阳线
    close[-1] = high[-5:-1].max() + 2
    open_[-1] = close[-2]
    high[-1] = close[-1] + 0.5
    low[-1] = open_[-1] - 0.2
    vol = rng.uniform(1000, 2000, size=n)
    vol[-1] = 5000
    ts0 = 1_700_000_000_000
    step = 3_600_000
    return pd.DataFrame(
        {
            "open_time": [ts0 + i * step for i in range(n)],
            "close_time": [ts0 + i * step + step - 1 for i in range(n)],
            "open": open_,
            "high": high,
            "low": low,
            "close": close,
            "volume": vol,
        }
    )


def test_registry_six():
    assert len(ALL_STRATEGY_IDS) == 6


def test_detect_all_runs():
    df = _synth()
    hits = detect_all(df)
    assert isinstance(hits, list)
    # 至少跑通；合成末根应触发海龟
    turtles = detect_turtle_trade(df)
    assert any(h["bar_index"] == len(df) - 1 for h in turtles)


def test_alert_shape():
    df = _synth()
    hits = detect_turtle_trade(df)
    assert hits
    alert = hit_to_alert(hits[-1], symbol="BTCUSDT", interval="1h")
    assert alert["type"] == "sequoia_card"
    assert alert["side"] == "long"
    assert alert["type_label"]
    assert alert["price"] > 0
    assert alert["kline_close_time"]


def test_ma_volume_callable():
    df = _synth()
    hits = detect_ma_volume(df)
    assert isinstance(hits, list)
