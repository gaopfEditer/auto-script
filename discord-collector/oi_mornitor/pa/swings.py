"""Swing High/Low + BOS/CHoCH (deterministic, closed candles only)."""

from __future__ import annotations

from typing import Any

from oi_mornitor.pa.params import SWING_ALGO_VERSION, SWING_LOOKBACK


def detect_swings(
    highs: list[float], lows: list[float], lookback: int = SWING_LOOKBACK
) -> list[tuple[int, str, float]]:
    n = len(highs)
    pivots: list[tuple[int, str, float]] = []
    if n < 2 * lookback + 1:
        return pivots
    for i in range(lookback, n - lookback):
        window_hi = highs[i - lookback : i + lookback + 1]
        if highs[i] > max(window_hi[:lookback]) and highs[i] > max(window_hi[lookback + 1 :]):
            pivots.append((i, "high", highs[i]))
        window_lo = lows[i - lookback : i + lookback + 1]
        if lows[i] < min(window_lo[:lookback]) and lows[i] < min(window_lo[lookback + 1 :]):
            pivots.append((i, "low", lows[i]))
    return pivots


def detect_structure(
    candles: list[dict[str, Any]],
    lookback: int = SWING_LOOKBACK,
    algo_version: str = SWING_ALGO_VERSION,
) -> dict[str, Any]:
    n = len(candles)
    highs = [float(c["high"]) for c in candles]
    lows = [float(c["low"]) for c in candles]
    closes = [float(c["close"]) for c in candles]
    times = [int(c["open_time"]) for c in candles]

    pivots = detect_swings(highs, lows, lookback)

    last_high: float | None = None
    last_low: float | None = None
    prev_high: float | None = None
    prev_low: float | None = None
    trend: str | None = None
    swings_out: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    first_kind: str | None = None

    pidx = 0
    npiv = len(pivots)
    for b in range(n):
        if b > 0 and last_high is not None and last_low is not None:
            prev_close = closes[b - 1]
            c = closes[b]
            if c > last_high and prev_close <= last_high:
                if trend == "down":
                    events.append(
                        {
                            "index": b,
                            "time": times[b],
                            "type": "choch_bullish",
                            "level": last_high,
                            "direction": "bullish",
                        }
                    )
                    trend = "up"
                else:
                    events.append(
                        {
                            "index": b,
                            "time": times[b],
                            "type": "bos_bullish",
                            "level": last_high,
                            "direction": "bullish",
                        }
                    )
            elif c < last_low and prev_close >= last_low:
                if trend == "up":
                    events.append(
                        {
                            "index": b,
                            "time": times[b],
                            "type": "choch_bearish",
                            "level": last_low,
                            "direction": "bearish",
                        }
                    )
                    trend = "down"
                else:
                    events.append(
                        {
                            "index": b,
                            "time": times[b],
                            "type": "bos_bearish",
                            "level": last_low,
                            "direction": "bearish",
                        }
                    )

        while pidx < npiv and pivots[pidx][0] == b:
            idx, kind, price = pivots[pidx]
            pidx += 1
            if first_kind is None:
                first_kind = kind
            if kind == "high":
                label = (
                    "HH"
                    if (prev_high is not None and price > prev_high)
                    else ("LH" if prev_high is not None else None)
                )
                prev_high = price
                last_high = price
            else:
                label = (
                    "HL"
                    if (prev_low is not None and price > prev_low)
                    else ("LL" if prev_low is not None else None)
                )
                prev_low = price
                last_low = price
            swings_out.append(
                {"index": idx, "time": times[idx], "kind": kind, "price": price, "label": label}
            )

        if trend is None and first_kind is not None and last_high is not None and last_low is not None:
            trend = "down" if first_kind == "high" else "up"

    if trend is None and first_kind is not None:
        trend = "transition"
    elif trend not in ("up", "down") and events:
        trend = "transition"

    return {"algo_version": algo_version, "trend": trend, "swings": swings_out, "events": events}
