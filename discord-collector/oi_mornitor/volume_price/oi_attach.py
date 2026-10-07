"""将 OI 历史序列合并进量价 K 线表。"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


def attach_oi_maps(
    df: pd.DataFrame,
    oi_maps: dict[tuple[str, str], dict[int, float]] | None,
) -> pd.DataFrame:
    """oi_maps: (SYMBOL, tf) -> {open_time_sec: oi}。"""
    if df.empty or not oi_maps:
        return df
    out = df.copy()
    vals: list[float] = []
    for _, row in out.iterrows():
        sym = str(row.get("symbol") or "").upper()
        tf = str(row.get("tf") or "")
        ts_ms = int(row.get("ts") or 0)
        ts_sec = ts_ms // 1000
        mp = oi_maps.get((sym, tf)) or oi_maps.get((sym, tf.lower())) or {}
        v = mp.get(ts_sec)
        if v is None:
            # 允许 ±1 根对齐
            v = mp.get(ts_sec - 900) or mp.get(ts_sec + 900)
        vals.append(float(v) if v is not None else np.nan)
    out["oi"] = vals
    return out
