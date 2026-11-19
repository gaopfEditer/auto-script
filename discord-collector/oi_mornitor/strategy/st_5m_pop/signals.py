"""ST 5m POP short v0 — 进场固定 %，出场阈值 × session_amp（exit_only）。"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

from oi_mornitor.strategy.st_5m_pop.session_amp import amp_mult, session_tag

BASE_RUSH_PCT = 0.35
BASE_WICK_PCT = 0.15
BASE_BB_TOL_PCT = 0.10
BASE_EMA_DIST_PCT = 0.25
SL_ABOVE_WICK_PCT = 0.05
TP_HALF_PCT = 0.5
TP_FULL_PCT = 1.2
SESSION_AMP_SCOPE = "exit_only"
STRATEGY_ID = "st_5m_pop_short_btc_eth_v0"


def klines_to_df(rows: list[list[Any]]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(
        rows,
        columns=["open_time", "open", "high", "low", "close", "volume", "close_time", "qav", "ntr", "tbv", "tbq", "ignore"],
    )
    for c in ("open", "high", "low", "close", "volume"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["open_time"] = pd.to_numeric(df["open_time"], errors="coerce").astype("int64")
    return df.sort_values("open_time").reset_index(drop=True)


def _prep(df: pd.DataFrame) -> pd.DataFrame:
    # 5m 入场仍要求 200 根；15m/1h 趋势否决只要算得出 ema72。
    if df is None or len(df) < 2:
        return df if df is not None else pd.DataFrame()
    df = df.copy()
    c, h, l, v = df["close"], df["high"], df["low"], df["volume"]
    df["ret_1"] = c.pct_change() * 100.0
    df["rush_3"] = df["ret_1"].rolling(3).sum()
    hl = (h - l).replace(0, np.nan)
    df["upper_wick_ratio"] = (h - c) / hl
    df["upper_wick_pct"] = (h - c) / c * 100.0
    vol_mean = v.rolling(48).mean()
    vol_std = v.rolling(48).std().replace(0, np.nan)
    df["vol_z"] = (v - vol_mean) / vol_std
    mid = c.rolling(20).mean()
    std = c.rolling(20).std()
    df["bb_upper"] = mid + 2 * std
    df["ema72"] = c.ewm(span=72, adjust=False).mean()
    df["ema144"] = c.ewm(span=144, adjust=False).mean()
    return df


def _pct_params(ts: int) -> dict[str, float]:
    m = amp_mult(ts)
    scale_exit = m if SESSION_AMP_SCOPE in ("both", "exit_only") else 1.0
    return {
        "ampMult": round(m, 4),
        "rushPct": BASE_RUSH_PCT,
        "wickPct": BASE_WICK_PCT,
        "bbTolPct": BASE_BB_TOL_PCT,
        "emaDistPct": BASE_EMA_DIST_PCT,
        "slAbovePct": SL_ABOVE_WICK_PCT * scale_exit,
        "tpHalfPct": TP_HALF_PCT * scale_exit,
        "tpFullPct": TP_FULL_PCT * scale_exit,
    }


def _trend_veto(df15: pd.DataFrame, df1h: pd.DataFrame, ts: int) -> bool:
    i15 = int(df15["open_time"].searchsorted(ts, side="right")) - 1
    i1h = int(df1h["open_time"].searchsorted(ts, side="right")) - 1
    if i15 < 8 or i1h < 1:
        return True
    r15, r1h = df15.iloc[i15], df1h.iloc[i1h]
    try:
        e15 = float(r15["ema72"])
        e1h = float(r1h["ema72"])
    except (KeyError, TypeError, ValueError):
        return True
    if math.isnan(e15) or math.isnan(e1h):
        return True
    if not (float(r15["close"]) > e15 and float(r1h["close"]) > e1h):
        return False
    lows = df15.iloc[i15 - 7 : i15 + 1]["low"].astype(float)
    return int((lows.diff() < 0).sum()) == 0


def evaluate_last_closed_bar(
    df5: pd.DataFrame,
    df15: pd.DataFrame,
    df1h: pd.DataFrame,
    *,
    symbol: str,
) -> dict[str, Any] | None:
    """仅在最后一根已收盘 5m 上评估（调用方勿含未收盘棒）。"""
    df5 = _prep(df5)
    df15 = _prep(df15) if df15 is not None and len(df15) else pd.DataFrame()
    df1h = _prep(df1h) if df1h is not None and len(df1h) else pd.DataFrame()
    if len(df5) < 200:
        return None
    i = len(df5) - 1
    row = df5.iloc[i]
    ts = int(row["open_time"])
    p = _pct_params(ts)
    score = 0
    checks: dict[str, bool] = {}
    checks["rush"] = float(row.get("rush_3") or 0) >= p["rushPct"]
    ur = float(row.get("upper_wick_ratio") or 0)
    uw = float(row.get("upper_wick_pct") or 0)
    checks["wick"] = ur >= 0.45 and uw >= p["wickPct"]
    checks["vol_z"] = float(row.get("vol_z") or -9) >= 1.5
    c, u = float(row["close"]), float(row.get("bb_upper") or 0)
    bb = c > 0 and u > 0 and not math.isnan(u) and abs(c - u) / c * 100.0 <= p["bbTolPct"]
    e72, e144 = float(row["ema72"]), float(row["ema144"])
    ema = c > e72 and c > e144 and min((c - e72) / c, (c - e144) / c) * 100.0 <= p["emaDistPct"]
    checks["resistance"] = bb or ema
    score = sum(1 for v in checks.values() if v)
    veto = _trend_veto(df15, df1h, ts) if len(df15) and len(df1h) else False
    return {
        "strategy": STRATEGY_ID,
        "symbol": symbol,
        "signalTs": ts,
        "barOpenTime": ts,
        "score": score,
        "checks": checks,
        "trendVeto": veto,
        "session": session_tag(ts),
        "side": "short",
        "entryRef": float(row["close"]),
        "slRef": float(row["high"]) * (1 + p["slAbovePct"] / 100.0),
        "thresholds": p,
        "triggered": score >= 3 and not veto,
    }