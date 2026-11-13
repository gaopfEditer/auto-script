"""V2 共用指标：RVOL、OI 变化、ATR、RSI、PriceZ、EMA、分位。"""
from __future__ import annotations

import math
from typing import Any, Sequence

import numpy as np
import pandas as pd

from oi_mornitor.strategy.short_term_v2.params import ATR_PERIOD, RVOL_LOOKBACK

_CACHE_KEY = "_stv2_indicator_cache"


def _f(x: object, default: float = 0.0) -> float:
    try:
        v = float(x)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    if math.isnan(v) or math.isinf(v):
        return default
    return v


def _col(df: pd.DataFrame, name: str) -> np.ndarray | None:
    if df is None or name not in df.columns:
        return None
    return df[name].to_numpy(dtype=float, copy=False)


def get_indicator_cache(df: pd.DataFrame | None) -> dict[str, Any] | None:
    if df is None:
        return None
    cache = getattr(df, "attrs", None)
    if not isinstance(cache, dict):
        return None
    got = cache.get(_CACHE_KEY)
    return got if isinstance(got, dict) else None


def precompute_indicators(
    df: pd.DataFrame | None,
    *,
    atr_period: int = ATR_PERIOD,
    rvol_lookback: int = RVOL_LOOKBACK,
) -> dict[str, Any]:
    """一次向量化算好 ATR/RVOL/ATR%，挂到 df.attrs，避免按根重算拖垮回测。"""
    empty: dict[str, Any] = {
        "atr": np.zeros(0, dtype=float),
        "atr_pct": np.full(0, np.nan),
        "rvol": np.full(0, np.nan),
        "high": np.zeros(0, dtype=float),
        "low": np.zeros(0, dtype=float),
        "close": np.zeros(0, dtype=float),
        "volume": np.zeros(0, dtype=float),
        "open_time": np.zeros(0, dtype=np.int64),
    }
    if df is None or len(df) == 0:
        return empty
    existing = get_indicator_cache(df)
    if existing and int(existing.get("n", -1)) == len(df):
        return existing

    n = len(df)
    high = _col(df, "high")
    low = _col(df, "low")
    close = _col(df, "close")
    volume = _col(df, "volume")
    if high is None or low is None or close is None:
        return empty
    if volume is None:
        volume = np.zeros(n, dtype=float)

    tr = np.zeros(n, dtype=float)
    tr[0] = max(float(high[0] - low[0]), 0.0)
    if n > 1:
        hl = high[1:] - low[1:]
        hc = np.abs(high[1:] - close[:-1])
        lc = np.abs(low[1:] - close[:-1])
        tr[1:] = np.maximum(np.maximum(hl, hc), lc)

    atr = np.zeros(n, dtype=float)
    # 简单滑动均值 ATR（与原先 atr_at 一致：窗口均值，非 Wilder）
    csum = np.cumsum(tr)
    for i in range(1, n):
        start = max(1, i - atr_period + 1)
        total = csum[i] - (csum[start - 1] if start > 0 else 0.0)
        atr[i] = total / (i - start + 1)

    atr_pct = np.full(n, np.nan, dtype=float)
    pos = close > 0
    atr_pct[pos] = atr[pos] / close[pos] * 100.0

    rvol = np.full(n, np.nan, dtype=float)
    if rvol_lookback > 0 and n > rvol_lookback:
        # 过去 lookback 根均值（不含当前）
        vol_csum = np.cumsum(volume)
        for i in range(rvol_lookback, n):
            prev = vol_csum[i - 1] - (vol_csum[i - rvol_lookback - 1] if i - rvol_lookback - 1 >= 0 else 0.0)
            mean = prev / rvol_lookback
            if mean > 0:
                rvol[i] = volume[i] / mean

    ot = None
    if "open_time" in df.columns:
        ot = df["open_time"].to_numpy(dtype=np.int64, copy=False)
        if ot.size and int(ot[-1]) < 1_000_000_000_000:
            ot = ot * 1000

    out = {
        "n": n,
        "atr": atr,
        "atr_pct": atr_pct,
        "rvol": rvol,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
        "open_time": ot if ot is not None else np.zeros(n, dtype=np.int64),
        "atr_period": atr_period,
        "rvol_lookback": rvol_lookback,
    }
    try:
        df.attrs[_CACHE_KEY] = out
    except Exception:  # noqa: BLE001 — attrs 不可写时仍返回内存缓存
        pass
    return out


def rvol_at(df: pd.DataFrame, idx: int, lookback: int = RVOL_LOOKBACK) -> float | None:
    """RVOL = 当前成交量 / 过去 lookback 根同周期成交量均值（不含当前根）。"""
    if df is None or "volume" not in df.columns or idx < lookback:
        return None
    cache = get_indicator_cache(df)
    if cache and int(cache.get("rvol_lookback", lookback)) == lookback:
        arr = cache.get("rvol")
        if arr is not None and 0 <= idx < len(arr):
            v = float(arr[idx])
            return None if math.isnan(v) else v
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
    cache = precompute_indicators(df, atr_period=period)
    return np.asarray(cache.get("atr") or np.zeros(0), dtype=float)


def atr_at(df: pd.DataFrame, idx: int, period: int = ATR_PERIOD) -> float:
    if df is None or idx < 1:
        return 0.0
    cache = get_indicator_cache(df)
    if cache is None or int(cache.get("atr_period", period)) != period or int(cache.get("n", -1)) != len(df):
        cache = precompute_indicators(df, atr_period=period)
    arr = cache.get("atr")
    if arr is not None and 0 <= idx < len(arr):
        return float(arr[idx])
    start = max(1, idx - period + 1)
    trs = [true_range(df, i) for i in range(start, idx + 1)]
    return sum(trs) / len(trs) if trs else 0.0


def atr_pct_at(df: pd.DataFrame, idx: int, period: int = ATR_PERIOD) -> float | None:
    if df is None or idx < 0 or idx >= len(df):
        return None
    cache = get_indicator_cache(df)
    if cache is None or int(cache.get("atr_period", period)) != period or int(cache.get("n", -1)) != len(df):
        cache = precompute_indicators(df, atr_period=period)
    arr = cache.get("atr_pct")
    if arr is not None and 0 <= idx < len(arr):
        v = float(arr[idx])
        return None if math.isnan(v) else v
    atr = atr_at(df, idx, period)
    close = _f(df.iloc[idx]["close"])
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
    cache = get_indicator_cache(df)
    if cache and "high" in cache:
        arr = cache["high"]
        if idx <= len(arr):
            return float(np.max(arr[idx - lookback : idx]))
    return float(df["high"].iloc[idx - lookback : idx].astype(float).max())


def lookback_low(df: pd.DataFrame, idx: int, lookback: int) -> float | None:
    if df is None or idx < lookback:
        return None
    cache = get_indicator_cache(df)
    if cache and "low" in cache:
        arr = cache["low"]
        if idx <= len(arr):
            return float(np.min(arr[idx - lookback : idx]))
    return float(df["low"].iloc[idx - lookback : idx].astype(float).min())


def bar_ts(df: pd.DataFrame, idx: int, ts_col: str = "open_time") -> int | None:
    if df is None or idx < 0 or idx >= len(df) or ts_col not in df.columns:
        return None
    cache = get_indicator_cache(df)
    if cache and "open_time" in cache and idx < len(cache["open_time"]):
        return int(cache["open_time"][idx])
    t = int(df.iloc[idx][ts_col])
    return t * 1000 if t < 1e12 else t
