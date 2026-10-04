"""均线 + 布林底部/顶部共振。"""
from __future__ import annotations

import os
from typing import Any

import pandas as pd

from oi_mornitor.strategy.candle_signals import at_lower_band
from oi_mornitor.strategy.features import add_core_features
from oi_mornitor.strategy.indicators import (
    detect_hammer,
    detect_inverted_hammer,
    detect_shooting_star,
    inverted_hammer_confirmed,
    near_bb_upper,
)

TOUCH_ATR = float(os.getenv("OI_MA_TOUCH_ATR", "0.25"))
RVOL_MIN = float(os.getenv("OI_MA_CONF_RVOL", "1.3"))
RR_DOWNGRADE = float(os.getenv("OI_MA_RR_DOWNGRADE", "1.2"))


def _touch_ema(row: pd.Series, period: int, *, side: str) -> bool:
    ema = row.get(f"ema{period}")
    atr = row.get("atr14")
    if pd.isna(ema) or pd.isna(atr) or float(atr) <= 0:
        return False
    ema_f = float(ema)
    atr_f = float(atr)
    if side == "long":
        low = float(row["low"])
        close = float(row["close"])
        return abs(low - ema_f) <= TOUCH_ATR * atr_f or (low < ema_f < close)
    high = float(row["high"])
    close = float(row["close"])
    return abs(high - ema_f) <= TOUCH_ATR * atr_f or (close < ema_f < high)


def _pattern_long(row: pd.Series) -> bool:
    return bool(detect_hammer(row) or detect_inverted_hammer(row))


def _pattern_short(row: pd.Series) -> bool:
    return bool(detect_shooting_star(row))


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


def detect_ma_confluence(df: pd.DataFrame) -> list[dict[str, Any]]:
    if df is None or len(df) < 160:
        return []
    work = add_core_features(df) if "ema144" not in df.columns else df
    n = len(work)
    out: list[dict[str, Any]] = []
    for i in range(1, n):
        prev = work.iloc[i - 1]
        row = work.iloc[i]
        if pd.isna(prev.get("bb_lower")) or pd.isna(prev.get("atr14")):
            continue
        rvol = float(prev["rvol"]) if pd.notna(prev.get("rvol")) else 0.0
        loc_ok = float(prev["low"]) <= float(prev["bb_lower"]) * 1.002 or at_lower_band(prev)
        touch144 = _touch_ema(prev, 144, side="long")
        touch99 = _touch_ema(prev, 99, side="long")
        pat = _pattern_long(prev)
        vol_ok = rvol >= RVOL_MIN or float(row["low"]) >= float(prev["low"])
        confirmed = float(row["close"]) > float(prev["high"]) or (
            pd.notna(row.get("ema13")) and float(row["close"]) > float(row["ema13"])
        )
        if loc_ok and (touch144 or touch99) and pat and vol_ok and confirmed:
            strength = 1.0 if touch144 else 0.8
            if detect_inverted_hammer(prev) and not inverted_hammer_confirmed(prev, row):
                continue
            out.append(
                {
                    "family": "ma",
                    "kind": "bb_ema144_hammer",
                    "side": "long",
                    **_meta(work, i),
                    "strength": strength,
                    "rr_note": "confirm_bar",
                }
            )

        loc_top = near_bb_upper(prev) or float(prev["high"]) >= float(prev["bb_upper"]) * 0.998
        touch144s = _touch_ema(prev, 144, side="short")
        touch99s = _touch_ema(prev, 99, side="short")
        pat_s = _pattern_short(prev)
        vol_s = rvol >= RVOL_MIN
        confirmed_s = float(row["close"]) < float(prev["low"]) or (
            pd.notna(row.get("ema13")) and float(row["close"]) < float(row["ema13"])
        )
        if loc_top and (touch144s or touch99s) and pat_s and vol_s and confirmed_s:
            out.append(
                {
                    "family": "ma",
                    "kind": "bb_ema_shooting_star",
                    "side": "short",
                    **_meta(work, i),
                    "strength": 1.0 if touch144s else 0.8,
                }
            )
    return out


def ema_alignment(row: pd.Series) -> str:
    vals = [row.get(f"ema{p}") for p in (13, 33, 99, 144)]
    if any(pd.isna(v) for v in vals):
        return "unknown"
    e13, e33, e99, e144 = (float(v) for v in vals)
    atr = float(row["atr14"]) if pd.notna(row.get("atr14")) else 0.0
    if e13 > e33 > e99 > e144:
        return "bull"
    if e13 < e33 < e99 < e144:
        return "bear"
    if atr > 0 and (max(e13, e33, e99, e144) - min(e13, e33, e99, e144)) < atr:
        return "tangle"
    return "mixed"
