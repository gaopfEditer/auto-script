"""成交量分布：POC / VAH / VAL."""

from __future__ import annotations

import numpy as np

from realtime_btc.models import Candle


def volume_profile(
    candles: list[Candle],
    bins: int = 48,
    value_area_pct: float = 0.70,
) -> tuple[float, float, float]:
    """
    根据 K 线高低价与成交量估算 POC、VAH、VAL。
    将每根 K 线的成交量均匀分配到 [low, high] 价格区间各档位。
    """
    if not candles:
        return 0.0, 0.0, 0.0

    lows = [c.low for c in candles]
    highs = [c.high for c in candles]
    lo, hi = min(lows), max(highs)
    if hi <= lo:
        p = candles[-1].close
        return p, p, p

    edges = np.linspace(lo, hi, bins + 1)
    hist = np.zeros(bins, dtype=float)

    for c in candles:
        span = max(c.high - c.low, 1e-9)
        start = int(np.clip(np.searchsorted(edges, c.low, side="right") - 1, 0, bins - 1))
        end = int(np.clip(np.searchsorted(edges, c.high, side="left"), 0, bins))
        n = max(end - start, 1)
        share = c.volume / n
        for i in range(start, min(end, bins)):
            hist[i] += share

    if hist.sum() <= 0:
        p = candles[-1].close
        return p, p, p

    centers = (edges[:-1] + edges[1:]) / 2
    poc_idx = int(np.argmax(hist))
    poc = float(centers[poc_idx])

    target = hist.sum() * value_area_pct
    acc = hist[poc_idx]
    left, right = poc_idx, poc_idx
    while acc < target and (left > 0 or right < bins - 1):
        left_vol = hist[left - 1] if left > 0 else -1.0
        right_vol = hist[right + 1] if right < bins - 1 else -1.0
        if right_vol >= left_vol:
            right += 1
            acc += hist[right]
        else:
            left -= 1
            acc += hist[left]

    val = float(centers[left])
    vah = float(centers[right])
    return poc, vah, val
