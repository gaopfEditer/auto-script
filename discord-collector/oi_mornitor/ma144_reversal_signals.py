"""144 均线附近射击之星 / 倒锤子（前 N 根均线上放量背景）。"""
from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.candle_card_config import volume_ratio_from_row
from oi_mornitor.ma144_reversal_config import (
    MA144_NEAR_TOL_PCT,
    MA144_VOL_LOOKBACK,
    MA144_VOL_MIN_BARS,
    MA144_VOL_MULT,
)
from oi_mornitor.strategy.candle_signals import CARD_REF_LOOKBACK, closed_bar_index, _ts_sec
from oi_mornitor.strategy.indicators import detect_inverted_hammer, detect_shooting_star

EMA144_SPAN = 144


def enrich_ema144(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    if "ema144" not in out.columns:
        out["ema144"] = out["close"].ewm(span=EMA144_SPAN, adjust=False).mean()
    return out


def near_ema144(row: pd.Series, *, tol_pct: float = MA144_NEAR_TOL_PCT) -> bool:
    ema = row.get("ema144")
    if ema is None or pd.isna(ema):
        return False
    level = float(ema)
    if level <= 0:
        return False
    tol = level * float(tol_pct)
    low = float(row["low"])
    high = float(row["high"])
    return low <= level + tol and high >= level - tol


def count_prior_vol_bars_above_ema144(
    df: pd.DataFrame,
    idx: int,
    *,
    lookback: int = MA144_VOL_LOOKBACK,
    vol_mult: float = MA144_VOL_MULT,
) -> int:
    """信号柱前 lookback 根（不含 idx）：收盘 > EMA144 且 vol/vol_ma ≥ mult。"""
    n = 0
    for k in range(1, int(lookback) + 1):
        j = idx - k
        if j < 0:
            break
        row = df.iloc[j]
        ema = row.get("ema144")
        if ema is None or pd.isna(ema):
            continue
        if float(row["close"]) <= float(ema):
            continue
        ratio = volume_ratio_from_row(row)
        if ratio is not None and float(ratio) >= float(vol_mult):
            n += 1
    return n


def find_last_closed_ma144_reversal_hits(
    df: pd.DataFrame,
    *,
    now_ms: int | None = None,
) -> list[dict[str, Any]]:
    """最近一根已收盘 K：144 附近 + 前 N 根均线上放量背景 + 射击之星/倒锤子。"""
    if df.empty or "open_time" not in df.columns:
        return []
    work = enrich_ema144(df)
    if "vol_sma20" not in work.columns:
        work["vol_sma20"] = work["volume"].rolling(20).mean()
    if "bb_basis" not in work.columns:
        work["bb_basis"] = work["close"].rolling(20).mean()

    idx = closed_bar_index(work, now_ms=now_ms)
    if idx < EMA144_SPAN:
        return []

    row = work.iloc[idx]
    if pd.isna(row.get("ema144")):
        return []
    if not near_ema144(row):
        return []

    vol_bars = count_prior_vol_bars_above_ema144(work, idx)
    if vol_bars < MA144_VOL_MIN_BARS:
        return []

    closed_ts = _ts_sec(int(row["open_time"]))
    o = float(row["open"])
    h = float(row["high"])
    l = float(row["low"])
    c = float(row["close"])
    ema144 = float(row["ema144"])
    prior_high = float(work.iloc[max(0, idx - CARD_REF_LOOKBACK) : idx]["high"].max())
    prior_low = float(work.iloc[max(0, idx - CARD_REF_LOOKBACK) : idx]["low"].min())
    vol_ratio = volume_ratio_from_row(row)
    bb_mid = float(row["bb_basis"]) if pd.notna(row.get("bb_basis")) else None

    hits: list[dict[str, Any]] = []
    if detect_shooting_star(row):
        hits.append(
            _hit_payload(
                closed_ts=closed_ts,
                idx=idx,
                kind="shooting_star",
                type_label="射击之星",
                side="bear",
                o=o,
                h=h,
                l=l,
                c=c,
                ema144=ema144,
                bb_mid=bb_mid,
                prior_high=prior_high,
                prior_low=prior_low,
                vol_ratio=vol_ratio,
                vol_bars=vol_bars,
            )
        )
    if detect_inverted_hammer(row):
        hits.append(
            _hit_payload(
                closed_ts=closed_ts,
                idx=idx,
                kind="inverted_hammer",
                type_label="倒锤子",
                side="bull",
                o=o,
                h=h,
                l=l,
                c=c,
                ema144=ema144,
                bb_mid=bb_mid,
                prior_high=prior_high,
                prior_low=prior_low,
                vol_ratio=vol_ratio,
                vol_bars=vol_bars,
            )
        )
    return hits


def _hit_payload(
    *,
    closed_ts: int,
    idx: int,
    kind: str,
    type_label: str,
    side: str,
    o: float,
    h: float,
    l: float,
    c: float,
    ema144: float,
    bb_mid: float | None,
    prior_high: float,
    prior_low: float,
    vol_ratio: float | None,
    vol_bars: int,
) -> dict[str, Any]:
    return {
        "time": closed_ts,
        "bar_index": idx,
        "kind": kind,
        "type_label": type_label,
        "side": side,
        "open": o,
        "high": h,
        "low": l,
        "close": c,
        "price": c,
        "ema144": ema144,
        "bb_mid": bb_mid,
        "prior_high": prior_high,
        "prior_low": prior_low,
        "vol_ratio": vol_ratio,
        "ma144_vol_bars": vol_bars,
    }
