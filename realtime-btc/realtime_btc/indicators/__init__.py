"""技术指标工具函数."""

from __future__ import annotations

from realtime_btc.models import Candle


def ema_series(values: list[float], period: int) -> list[float]:
    """指数移动平均序列；长度与输入相同，前 period-1 项为逐步预热值."""
    if not values:
        return []
    if period <= 1:
        return list(values)
    k = 2.0 / (period + 1)
    out: list[float] = []
    prev = values[0]
    out.append(prev)
    for v in values[1:]:
        prev = v * k + prev * (1 - k)
        out.append(prev)
    return out


def last_ema(values: list[float], period: int) -> float:
    series = ema_series(values, period)
    return series[-1] if series else 0.0


def closes(candles: list[Candle]) -> list[float]:
    return [c.close for c in candles]


def is_bullish_pin(c: Candle, wick_body_ratio: float = 2.0) -> bool:
    """锤子线：长下影."""
    body = abs(c.close - c.open) or 1e-9
    lower_wick = min(c.open, c.close) - c.low
    upper_wick = c.high - max(c.open, c.close)
    return lower_wick >= body * wick_body_ratio and lower_wick > upper_wick


def is_bearish_pin(c: Candle, wick_body_ratio: float = 2.0) -> bool:
    """射击之星：长上影."""
    body = abs(c.close - c.open) or 1e-9
    lower_wick = min(c.open, c.close) - c.low
    upper_wick = c.high - max(c.open, c.close)
    return upper_wick >= body * wick_body_ratio and upper_wick > lower_wick
