"""V2 共用指标：RVOL、OI 变化、ATR、RSI、PriceZ、EMA、分位。"""
from __future__ import annotations

import math
from typing import Sequence

import numpy as np
import pandas as pd

from oi_mornitor.strategy.short_term_v2.params import ATR_PERIOD, RVOL_LOOKBACK


def _f(x: object, default: float = 0.0) -> float:
    try:
        v = float(x)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    if math.isnan(v) or math.isinf(v):
        return default
    return v


def rvol_at(df: pd.DataFrame, idx: int, lookback: int = RVOL_LOOKBACK) -> float | None:
    """RVOL = 当前成交量 / 过去 lookback 根同周期成交量均值（不含当前根）。"""
    if df is None or "volume" not in df.columns or idx < lookback:
        return None
    hist = df["volume"].iloc[idx - lookback : idx].astype(float)
    mean = float(hist.mean()) if len(hist) else 0.0
    if mean <= 0:
        return None
    return float(df.iloc[idx]["volume"]) / mean


def oi_change_pct(df: pd.DataFrame, idx: int, *, col: str = "oi") -> float | None:
    """OIChange = (OI_t - OI_{t-1}) / OI_{t-1} * 100%。"""
    if df is None or col not in df.columns or idx < 1:
        return None
    cur, prev = _f(df.iloc[idx][col]), _f(df.iloc[idx - 1][col])
    if prev <= 0 or cur <= 0:
        return None
    return (cur - prev) / prev * 100.0


def oi_change_abs(df: pd.DataFrame, idx: int, *, col: str = "oi") -> float | None:
    if df is None or col not in df.columns or idx < 1:
        return None
    cur, prev = _f(df.iloc[idx][col]), _f(df.iloc[idx - 1][col])
    if prev <= 0 or cur <= 0:
        return None
    return cur - prev


def true_range(df: pd.DataFrame, idx: int) -> float:
    if idx < 1 or df is None or idx >= len(df):
        row = df.iloc[idx] if df is not None and 0 <= idx < len(df) else None
        if row is None:
            return 0.0
        return max(_f(row["high"]) - _f(row["low"]), 0.0)
    row, prev = df.iloc[idx], df.iloc[idx - 1]
    h, l, pc = _f(row["high"]), _f(row["low"]), _f(prev["close"])
    return max(h - l, abs(h - pc), abs(l - pc))


def atr_series(df: pd.DataFrame, period: int = ATR_PERIOD) -> np.ndarray:
    n = 0 if df is None else len(df)
    out = np.zeros(n, dtype=float)
    if n < 2:
        return out
    trs = np.zeros(n, dtype=float)
    for i in range(1, n):
        trs[i] = true_range(df, i)
    for i in range(1, n):
        start = max(1, i - period + 1)
        sl = trs[start : i + 1]
        out[i] = float(sl.mean()) if len(sl) else 0.0
    return out


def atr_at(df: pd.DataFrame, idx: int, period: int = ATR_PERIOD) -> float:
    if df is None or idx < 1:
        return 0.0
    start = max(1, idx - period + 1)
    trs = [true_range(df, i) for i in range(start, idx + 1)]
    return sum(trs) / len(trs) if trs else 0.0


def atr_pct_at(df: pd.DataFrame, idx: int, period: int = ATR_PERIOD) -> float | None:
    atr = atr_at(df, idx, period)
    close = _f(df.iloc[idx]["close"]) if df is not None and 0 <= idx < len(df) else 0.0
    if atr <= 0 or close <= 0:
        return None
    return atr / close * 100.0


def rolling_pctile(values: Sequence[float], idx: int, lookback: int) -> float | None:
    if idx < 0 or lookback < 2:
        return None
    start = max(0, idx - lookback + 1)
    window = [float(v) for v in values[start : idx + 1] if v is not None and not math.isnan(float(v))]
    if len(window) < 5:
        return None
    cur = window[-1]
    below = sum(1 for v in window if v <= cur)
    return below / len(window) * 100.0


def price_z_at(df: pd.DataFrame, idx: int, lookback: int = 60) -> float | None:
    """PriceZ = (当前收益率 - 历史收益率均值) / 历史收益率标准差。"""
    if df is None or idx < lookback or "close" not in df.columns:
        return None
    closes = df["close"].astype(float).to_numpy()
    rets = np.diff(closes[idx - lookback : idx + 1]) / np.maximum(closes[idx - lookback : idx], 1e-12)
    if len(rets) < 10:
        return None
    mu = float(np.mean(rets[:-1]))
    sd = float(np.std(rets[:-1], ddof=0))
    if sd <= 1e-12:
        return None
    return (float(rets[-1]) - mu) / sd


def atr_deviation_at(df: pd.DataFrame, idx: int, period: int = ATR_PERIOD) -> float | None:
    """|close - prev_close| / ATR(14)。"""
    if df is None or idx < 1:
        return None
    atr = atr_at(df, idx, period)
    if atr <= 0:
        return None
    move = abs(_f(df.iloc[idx]["close"]) - _f(df.iloc[idx - 1]["close"]))
    return move / atr


def ema_at(df: pd.DataFrame, idx: int, period: int) -> float | None:
    if df is None or idx < period or "close" not in df.columns:
        return None
    s = df["close"].astype(float).iloc[: idx + 1]
    return float(s.ewm(span=period, adjust=False).mean().iloc[-1])


def rsi_at(df: pd.DataFrame, idx: int, period: int = 14) -> float | None:
    if df is None or idx < period + 1 or "close" not in df.columns:
        return None
    closes = df["close"].astype(float).iloc[idx - period : idx + 1].to_numpy()
    deltas = np.diff(closes)
    gains = np.clip(deltas, 0, None)
    losses = np.clip(-deltas, 0, None)
    avg_gain = float(gains.mean())
    avg_loss = float(losses.mean())
    if avg_loss <= 1e-12:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def lookback_high(df: pd.DataFrame, idx: int, lookback: int) -> float | None:
    """过去 lookback 根（不含当前）最高价。"""
    if df is None or idx < lookback:
        return None
    return float(df["high"].iloc[idx - lookback : idx].astype(float).max())


def lookback_low(df: pd.DataFrame, idx: int, lookback: int) -> float | None:
    if df is None or idx < lookback:
        return None
    return float(df["low"].iloc[idx - lookback : idx].astype(float).min())


def bar_ts(df: pd.DataFrame, idx: int, ts_col: str = "open_time") -> int | None:
    if df is None or idx < 0 or idx >= len(df) or ts_col not in df.columns:
        return None
    t = int(df.iloc[idx][ts_col])
    return t * 1000 if t < 1e12 else t
