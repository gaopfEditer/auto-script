"""Sequoia 共用指标（仅用 OHLCV，不绑死 BB/Vegas）。"""
from __future__ import annotations

import numpy as np
import pandas as pd


def ensure_ohlcv(df: pd.DataFrame) -> pd.DataFrame:
    need = ("open", "high", "low", "close", "volume")
    if df is None or df.empty:
        return pd.DataFrame()
    missing = [c for c in need if c not in df.columns]
    if missing:
        return pd.DataFrame()
    out = df
    if "open_time" not in out.columns and "ts" in out.columns:
        out = out.copy()
        out["open_time"] = out["ts"]
    return out


def add_basic_cols(df: pd.DataFrame, *, vol_sma: int = 20) -> pd.DataFrame:
    out = df.copy()
    out["open"] = out["open"].astype(float)
    out["high"] = out["high"].astype(float)
    out["low"] = out["low"].astype(float)
    out["close"] = out["close"].astype(float)
    out["volume"] = out["volume"].astype(float)
    out["vol_sma"] = out["volume"].rolling(int(vol_sma), min_periods=max(3, vol_sma // 2)).mean()
    out["body"] = (out["close"] - out["open"]).abs()
    out["is_bull"] = out["close"] > out["open"]
    out["is_bear"] = out["close"] < out["open"]
    out["ret_pct"] = out["close"].pct_change() * 100.0
    return out


def sma(series: pd.Series, n: int) -> pd.Series:
    return series.rolling(int(n), min_periods=max(2, n // 2)).mean()


def prior_high(high: pd.Series, n: int) -> pd.Series:
    """不含当前根的前 N 根最高价。"""
    return high.shift(1).rolling(int(n), min_periods=max(2, n // 2)).max()


def prior_low(low: pd.Series, n: int) -> pd.Series:
    return low.shift(1).rolling(int(n), min_periods=max(2, n // 2)).min()


def vol_ok(row: pd.Series, mult: float) -> bool:
    ma = row.get("vol_sma")
    if ma is None or (isinstance(ma, float) and (not np.isfinite(ma) or ma <= 0)):
        return False
    return float(row["volume"]) >= float(mult) * float(ma)


def pct_change_lookback(close: pd.Series, lookback: int) -> pd.Series:
    base = close.shift(int(lookback))
    return (close - base) / base.replace(0, np.nan) * 100.0
