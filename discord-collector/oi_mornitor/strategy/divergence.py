"""MACD 常规顶/底背离：因果摆动点 + 确认条件。"""
from __future__ import annotations

import os
from typing import Any

import pandas as pd

from oi_mornitor.strategy.features import add_core_features, confirmed_swings, mark_causal_swings
from oi_mornitor.strategy.params import SWING_RIGHT

DIV_MIN_GAP = int(os.getenv("OI_MACD_DIV_MIN_GAP", "5"))
DIV_MAX_GAP = int(os.getenv("OI_MACD_DIV_MAX_GAP", "60"))
CONFIRM_BARS = int(os.getenv("OI_MACD_DIV_CONFIRM_BARS", "5"))
STRENGTH_K = float(os.getenv("OI_MACD_DIV_STRENGTH_K", "2.0"))


def _meta(df: pd.DataFrame, i: int) -> dict[str, Any]:
    row = df.iloc[i]
    open_ts = int(row["open_time"]) if "open_time" in df.columns else int(row.get("ts") or 0)
    close_ts = int(row["close_time"]) if "close_time" in df.columns else open_ts
    return {
        "bar_index": i,
        "bar_open_ts": open_ts,
        "bar_close_ts": close_ts,
        "price_close": float(row["close"]),
    }


def detect_macd_divergence(df: pd.DataFrame) -> list[dict[str, Any]]:
    if df is None or len(df) < 80:
        return []
    work = add_core_features(df) if "macd" not in df.columns else df
    work = mark_causal_swings(work)
    n = len(work)
    out: list[dict[str, Any]] = []

    highs = confirmed_swings(work, n - 1, which="high")
    for a in range(len(highs) - 1):
        i1, p1 = highs[a]
        i2, p2 = highs[a + 1]
        gap = i2 - i1
        if gap < DIV_MIN_GAP or gap > DIV_MAX_GAP or p2 <= p1:
            continue
        dif1 = float(work.iloc[i1]["macd"]) if pd.notna(work.iloc[i1].get("macd")) else None
        dif2 = float(work.iloc[i2]["macd"]) if pd.notna(work.iloc[i2].get("macd")) else None
        if dif1 is None or dif2 is None or dif1 <= 0 or not (dif2 < dif1):
            continue
        confirm_from = i2 + SWING_RIGHT
        atr = float(work.iloc[i2]["atr14"]) if pd.notna(work.iloc[i2].get("atr14")) else 0.0
        strength = min(1.0, abs(dif1 - dif2) / (atr * STRENGTH_K) if atr > 0 else 0.5)
        p2_low = float(work.iloc[i2]["low"])
        for j in range(confirm_from, min(n, confirm_from + CONFIRM_BARS)):
            row = work.iloc[j]
            prev = work.iloc[j - 1]
            cross_down = float(row["macd"]) < float(row["macd_signal"]) and float(prev["macd"]) >= float(
                prev["macd_signal"]
            )
            break_low = float(row["close"]) < p2_low
            if not (cross_down or break_low):
                continue
            out.append(
                {
                    "family": "divergence",
                    "kind": "macd_bear_div",
                    "side": "short",
                    **_meta(work, j),
                    "strength": strength,
                    "p1_ts": int(work.iloc[i1].get("open_time") or 0),
                    "p2_ts": int(work.iloc[i2].get("open_time") or 0),
                    "dif_p1": dif1,
                    "dif_p2": dif2,
                }
            )
            break

    lows = confirmed_swings(work, n - 1, which="low")
    for a in range(len(lows) - 1):
        i1, p1 = lows[a]
        i2, p2 = lows[a + 1]
        gap = i2 - i1
        if gap < DIV_MIN_GAP or gap > DIV_MAX_GAP or p2 >= p1:
            continue
        dif1 = float(work.iloc[i1]["macd"]) if pd.notna(work.iloc[i1].get("macd")) else None
        dif2 = float(work.iloc[i2]["macd"]) if pd.notna(work.iloc[i2].get("macd")) else None
        if dif1 is None or dif2 is None or dif1 >= 0 or not (dif2 > dif1):
            continue
        confirm_from = i2 + SWING_RIGHT
        atr = float(work.iloc[i2]["atr14"]) if pd.notna(work.iloc[i2].get("atr14")) else 0.0
        strength = min(1.0, abs(dif2 - dif1) / (atr * STRENGTH_K) if atr > 0 else 0.5)
        p2_high = float(work.iloc[i2]["high"])
        for j in range(confirm_from, min(n, confirm_from + CONFIRM_BARS)):
            row = work.iloc[j]
            prev = work.iloc[j - 1]
            cross_up = float(row["macd"]) > float(row["macd_signal"]) and float(prev["macd"]) <= float(
                prev["macd_signal"]
            )
            break_high = float(row["close"]) > p2_high
            if not (cross_up or break_high):
                continue
            out.append(
                {
                    "family": "divergence",
                    "kind": "macd_bull_div",
                    "side": "long",
                    **_meta(work, j),
                    "strength": strength,
                    "p1_ts": int(work.iloc[i1].get("open_time") or 0),
                    "p2_ts": int(work.iloc[i2].get("open_time") or 0),
                    "dif_p1": dif1,
                    "dif_p2": dif2,
                }
            )
            break
    return out
