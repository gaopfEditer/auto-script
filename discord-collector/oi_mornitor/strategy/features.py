"""统一特征：EMA / BOLL / ATR / MACD / 量能 / 因果摆动点 / vegas_mid。

摆动点用「左 left 右 right」因果确认：在 i+right 才确认 i 是摆动点，禁止 center=True。
vegas_mid 统一定义为 Vegas A 组中点：(EMA144 + EMA169) / 2。
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from oi_mornitor.config import (
    PATTERN_BB_LENGTH,
    PATTERN_BB_MULT,
    STRATEGY_VEGAS_FILTER,
    STRATEGY_VEGAS_PERIODS,
)
from oi_mornitor.strategy.params import SWING_LEFT, SWING_RIGHT

EMA_PERIODS = (13, 33, 99, 144)
TF_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}


def vegas_a_mid(df: pd.DataFrame) -> pd.Series:
    """Vegas A 组中点 = (EMA144 + EMA169) / 2，也即 (vegas_e1 + vegas_e2) / 2。"""
    if "vegas_e1" in df.columns and "vegas_e2" in df.columns:
        e1 = df["vegas_e1"].astype(float)
        e2 = df["vegas_e2"].astype(float)
        return (e1 + e2) / 2.0
    close = df["close"].astype(float)
    e144 = close.ewm(span=144, adjust=False).mean()
    e169 = close.ewm(span=169, adjust=False).mean()
    return (e144 + e169) / 2.0


def apply_vegas_mid(df: pd.DataFrame) -> pd.DataFrame:
    """就地保证 vegas_mid / vegas_fast_lo / vegas_fast_hi 与 A 组定义一致。"""
    out = df if df is None else df.copy()
    mid = vegas_a_mid(out)
    out["vegas_mid"] = mid
    if "vegas_e1" in out.columns and "vegas_e2" in out.columns:
        out["vegas_fast_lo"] = out[["vegas_e1", "vegas_e2"]].min(axis=1)
        out["vegas_fast_hi"] = out[["vegas_e1", "vegas_e2"]].max(axis=1)
    elif "ema144" in out.columns and "ema169" in out.columns:
        out["vegas_fast_lo"] = out[["ema144", "ema169"]].min(axis=1)
        out["vegas_fast_hi"] = out[["ema144", "ema169"]].max(axis=1)
    return out


def add_core_features(df: pd.DataFrame) -> pd.DataFrame:
    """EMA13/33/99/144 + BOLL(20,2) + ATR14 + MACD + RVOL + CPOS + vegas。"""
    out = df.copy()
    close = out["close"].astype(float)
    high = out["high"].astype(float)
    low = out["low"].astype(float)
    open_ = out["open"].astype(float)
    volume = out["volume"].astype(float)

    for period in EMA_PERIODS:
        out[f"ema{period}"] = close.ewm(span=period, adjust=False).mean()

    out["bb_basis"] = close.rolling(PATTERN_BB_LENGTH).mean()
    out["bb_std"] = close.rolling(PATTERN_BB_LENGTH).std(ddof=0)
    out["bb_upper"] = out["bb_basis"] + PATTERN_BB_MULT * out["bb_std"]
    out["bb_lower"] = out["bb_basis"] - PATTERN_BB_MULT * out["bb_std"]
    out["bb_width"] = out["bb_upper"] - out["bb_lower"]

    tr = pd.concat(
        [
            high - low,
            (high - close.shift(1)).abs(),
            (low - close.shift(1)).abs(),
        ],
        axis=1,
    ).max(axis=1)
    out["atr14"] = tr.rolling(14, min_periods=14).mean()

    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    out["macd"] = ema12 - ema26
    out["macd_signal"] = out["macd"].ewm(span=9, adjust=False).mean()
    out["macd_hist"] = out["macd"] - out["macd_signal"]
    out["dif"] = out["macd"]
    out["dea"] = out["macd_signal"]

    vol_sma = volume.rolling(20, min_periods=20).mean().shift(1)
    out["vol_sma20"] = volume.rolling(20, min_periods=20).mean()
    out["rvol"] = volume / vol_sma.replace(0, np.nan)

    rng = (high - low).clip(lower=0)
    out["candle_range"] = rng
    out["cpos"] = np.where(rng > 0, (close - low) / rng, 0.5)
    out["spread"] = rng / out["atr14"].replace(0, np.nan)
    out["body"] = (close - open_).abs()
    out["body_signed"] = close - open_
    out["upper_wick"] = high - np.maximum(open_, close)
    out["lower_wick"] = np.minimum(open_, close) - low

    for i, period in enumerate(STRATEGY_VEGAS_PERIODS, start=1):
        col = f"vegas_e{i}"
        if col not in out.columns:
            out[col] = close.ewm(span=period, adjust=False).mean()
    if "vegas_filter" not in out.columns:
        out["vegas_filter"] = close.ewm(span=STRATEGY_VEGAS_FILTER, adjust=False).mean()
    if "ema144" not in out.columns:
        out["ema144"] = close.ewm(span=144, adjust=False).mean()
    if "ema169" not in out.columns:
        out["ema169"] = close.ewm(span=169, adjust=False).mean()
    out = apply_vegas_mid(out)
    return out


def mark_causal_swings(
    df: pd.DataFrame,
    *,
    left: int = SWING_LEFT,
    right: int = SWING_RIGHT,
) -> pd.DataFrame:
    """因果摆动点：bar i 为高/低点，当且仅当 i 是 [i-left, i+right] 的极值，且 i+right 已存在。"""
    out = df.copy()
    n = len(out)
    is_high = np.zeros(n, dtype=bool)
    is_low = np.zeros(n, dtype=bool)
    confirm_at = np.full(n, -1, dtype=int)
    if n == 0 or "high" not in out.columns or "low" not in out.columns:
        out["is_swing_high"] = is_high
        out["is_swing_low"] = is_low
        out["swing_confirm_at"] = confirm_at
        return out

    highs = out["high"].astype(float).to_numpy()
    lows = out["low"].astype(float).to_numpy()
    last_pivot = n - right
    for i in range(left, last_pivot):
        window_h = highs[i - left : i + right + 1]
        window_l = lows[i - left : i + right + 1]
        if not np.isfinite(highs[i]) or not np.isfinite(lows[i]):
            continue
        if highs[i] >= np.nanmax(window_h):
            is_high[i] = True
            confirm_at[i] = i + right
        if lows[i] <= np.nanmin(window_l):
            is_low[i] = True
            confirm_at[i] = i + right
    out["is_swing_high"] = is_high
    out["is_swing_low"] = is_low
    out["swing_confirm_at"] = confirm_at
    return out


def confirmed_swing_prefixes(
    df: pd.DataFrame,
    *,
    which: str = "high",
    left: int = SWING_LEFT,
    right: int = SWING_RIGHT,
) -> list[list[tuple[int, float]]]:
    """by_asof[j] = 截至 j 已确认的摆动点列表。"""
    n = 0 if df is None else len(df)
    if n == 0:
        return []
    col = "is_swing_high" if which == "high" else "is_swing_low"
    price_col = "high" if which == "high" else "low"
    work = df if col in df.columns else mark_causal_swings(df, left=left, right=right)
    pending: list[tuple[int, int, float]] = []
    for i in range(n):
        if not bool(work.iloc[i][col]):
            continue
        confirm = int(work.iloc[i].get("swing_confirm_at", i + right) or (i + right))
        if confirm < 0:
            confirm = i + right
        pending.append((confirm, i, float(work.iloc[i][price_col])))
    pending.sort()
    prefixes: list[list[tuple[int, float]]] = []
    acc: list[tuple[int, float]] = []
    k = 0
    for j in range(n):
        while k < len(pending) and pending[k][0] <= j:
            acc.append((pending[k][1], pending[k][2]))
            k += 1
        prefixes.append(list(acc))
    return prefixes


def confirmed_swings(
    df: pd.DataFrame,
    asof_idx: int,
    *,
    which: str = "high",
    left: int = SWING_LEFT,
    right: int = SWING_RIGHT,
) -> list[tuple[int, float]]:
    """截至 asof_idx 已确认的摆动点 (pivot_index, price)。"""
    if df is None or df.empty or asof_idx < 0:
        return []
    col = "is_swing_high" if which == "high" else "is_swing_low"
    price_col = "high" if which == "high" else "low"
    if col not in df.columns:
        work = mark_causal_swings(df, left=left, right=right)
    else:
        work = df
    out: list[tuple[int, float]] = []
    n = min(len(work), asof_idx + 1)
    for i in range(n):
        if not bool(work.iloc[i][col]):
            continue
        confirm = int(work.iloc[i].get("swing_confirm_at", i + right) or (i + right))
        if confirm < 0:
            confirm = i + right
        if confirm > asof_idx:
            continue
        out.append((i, float(work.iloc[i][price_col])))
    return out


def ensure_close_time(df: pd.DataFrame, *, tf: str | None = None) -> pd.DataFrame:
    """保证 close_time 列存在。优先用已有列；否则用 open/ts + 周期。"""
    if df is None or df.empty:
        return df.copy() if df is not None else pd.DataFrame()
    if "close_time" in df.columns and df["close_time"].notna().any():
        return df
    out = df.copy()
    if tf is None and "tf" in out.columns:
        span = out["tf"].map(TF_MS).fillna(900_000)
    else:
        span = TF_MS.get(str(tf or "15m"), 900_000)
    base = out["open_time"] if "open_time" in out.columns else out.get("ts")
    if base is None:
        return out
    out["close_time"] = base.astype("int64") + span - 1
    return out


def snapshot_bar_features(row: pd.Series) -> dict[str, Any]:
    keys = (
        "open",
        "high",
        "low",
        "close",
        "volume",
        "atr14",
        "bb_upper",
        "bb_basis",
        "bb_lower",
        "ema13",
        "ema33",
        "ema99",
        "ema144",
        "macd",
        "dif",
        "dea",
        "macd_hist",
        "rvol",
        "cpos",
        "vegas_mid",
    )
    out: dict[str, Any] = {}
    for k in keys:
        if k not in row.index:
            continue
        val = row.get(k)
        if pd.isna(val):
            continue
        try:
            out[k] = float(val)
        except (TypeError, ValueError):
            continue
    return out
