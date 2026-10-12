"""144 均线反转信号单元测试。"""
from __future__ import annotations

import pandas as pd

from oi_mornitor.ma144_reversal_signals import (
    count_prior_vol_bars_above_ema144,
    enrich_ema144,
    find_last_closed_ma144_reversal_hits,
    near_ema144,
)


def _row(
    *,
    o: float,
    h: float,
    l: float,
    c: float,
    vol: float,
    vol_ma: float,
    ema: float,
    open_time: int,
) -> dict:
    return {
        "open": o,
        "high": h,
        "low": l,
        "close": c,
        "volume": vol,
        "vol_sma20": vol_ma,
        "ema144": ema,
        "open_time": open_time,
        "close_time": open_time + 3_599_999,
    }


def test_near_ema144():
    row = pd.Series(_row(o=100, h=102, l=98, c=101, vol=1, vol_ma=1, ema=100, open_time=0))
    assert near_ema144(row, tol_pct=0.05)
    row2 = pd.Series(_row(o=120, h=121, l=119, c=120, vol=1, vol_ma=1, ema=100, open_time=0))
    assert not near_ema144(row2, tol_pct=0.01)


def test_count_prior_vol_bars():
    rows = []
    base_t = 1_700_000_000_000
    ema = 100.0
    for i in range(10):
        above = i >= 4 and i <= 6
        rows.append(
            _row(
                o=ema + 1,
                h=ema + 2,
                l=ema,
                c=ema + 1 if above else ema - 1,
                vol=200 if above else 50,
                vol_ma=100,
                ema=ema,
                open_time=base_t + i * 3_600_000,
            )
        )
    df = enrich_ema144(pd.DataFrame(rows))
    idx = len(df) - 1
    n = count_prior_vol_bars_above_ema144(df, idx, lookback=5, vol_mult=1.2)
    assert n >= 2


def test_find_shooting_star_at_ema144():
    rows = []
    base_t = 1_700_000_000_000
    ema = 100.0
    for i in range(150):
        rows.append(
            _row(
                o=ema + 0.5,
                h=ema + 1,
                l=ema - 0.2,
                c=ema + 0.6,
                vol=150,
                vol_ma=100,
                ema=ema,
                open_time=base_t + i * 3_600_000,
            )
        )
    # 射击之星：小实体、长上影，贴近 ema144
    rows[-1] = _row(
        o=100.2,
        h=103.0,
        l=99.8,
        c=100.1,
        vol=80,
        vol_ma=100,
        ema=100.0,
        open_time=base_t + 150 * 3_600_000,
    )
    rows[-1]["close_time"] = rows[-1]["open_time"] + 3_599_999
    df = pd.DataFrame(rows)
    df["bb_basis"] = df["close"].rolling(20).mean()
    now_ms = int(rows[-1]["close_time"]) + 1
    hits = find_last_closed_ma144_reversal_hits(df, now_ms=now_ms)
    kinds = {h["kind"] for h in hits}
    assert "shooting_star" in kinds
