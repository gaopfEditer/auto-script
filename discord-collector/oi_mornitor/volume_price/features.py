"""量价特征：rolling 20，仅用历史窗口，无未来函数。"""
from __future__ import annotations

import numpy as np
import pandas as pd

DEFAULT_WINDOW = 20
_MIN_PERIODS = 20


def _group_rolling(
    s: pd.Series,
    grouper: pd.Series,
    *,
    window: int,
    fn: str,
) -> pd.Series:
    parts: list[pd.Series] = []
    for _, idx in s.groupby(grouper).groups.items():
        part = s.loc[idx]
        if fn == "mean":
            rolled = part.rolling(window, min_periods=_MIN_PERIODS).mean()
        elif fn == "std":
            rolled = part.rolling(window, min_periods=_MIN_PERIODS).std(ddof=0)
        else:
            raise ValueError(fn)
        parts.append(rolled)
    out = pd.concat(parts).sort_index()
    return out.reindex(s.index)


def add_volume_price_features(
    df: pd.DataFrame,
    *,
    window: int = DEFAULT_WINDOW,
) -> pd.DataFrame:
    """为 K 线表增加量价特征列。

    需要列: symbol, tf, open, high, low, close, volume；oi 可空。
    """
    if df.empty:
        return df.copy()

    out = df.copy()
    grp_key = out["symbol"].astype(str) + "|" + out["tf"].astype(str)

    out["range"] = (out["high"] - out["low"]).clip(lower=0)
    out["body"] = out["close"] - out["open"]
    out["body_abs"] = out["body"].abs()
    out["efficiency"] = out["body_abs"] / out["range"].replace(0, np.nan)

    out["vol_ma20"] = _group_rolling(out["volume"], grp_key, window=window, fn="mean")
    vol_std = _group_rolling(out["volume"], grp_key, window=window, fn="std")
    out["vol_z"] = (out["volume"] - out["vol_ma20"]) / vol_std.replace(0, np.nan)

    range_ma = _group_rolling(out["range"], grp_key, window=window, fn="mean")
    range_std = _group_rolling(out["range"], grp_key, window=window, fn="std")
    out["range_z"] = (out["range"] - range_ma) / range_std.replace(0, np.nan)

    # 努力（量）与结果（波动）的落差：量大但走得少 → 正 gap
    out["effort_result_gap"] = out["vol_z"] - out["range_z"]

    has_oi = "oi" in out.columns and out["oi"].notna().any()
    if has_oi:
        oi = pd.to_numeric(out["oi"], errors="coerce")
        out["oi"] = oi
        out["oi_change"] = oi.groupby([out["symbol"], out["tf"]]).diff()
        oi_ma = _group_rolling(oi, grp_key, window=window, fn="mean")
        oi_std = _group_rolling(oi, grp_key, window=window, fn="std")
        out["oi_z"] = (oi - oi_ma) / oi_std.replace(0, np.nan)
    else:
        out["oi_change"] = np.nan
        out["oi_z"] = np.nan

    return out
