"""K 线量价形态分类（阈值来自训练集分位数）。"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

BAR_CLASSES = ("thrust", "effort_no_result", "climax", "confirm", "other")


@dataclass
class ClassifyThresholds:
    efficiency_high: float
    efficiency_low: float
    vol_z_high: float
    vol_z_low: float
    range_z_high: float
    range_z_low: float
    quantile: float = 0.8

    def to_dict(self) -> dict[str, float]:
        return {
            "efficiency_high": self.efficiency_high,
            "efficiency_low": self.efficiency_low,
            "vol_z_high": self.vol_z_high,
            "vol_z_low": self.vol_z_low,
            "range_z_high": self.range_z_high,
            "range_z_low": self.range_z_low,
            "quantile": self.quantile,
        }


def fit_classify_thresholds(
    df: pd.DataFrame,
    *,
    quantile: float = 0.8,
) -> ClassifyThresholds:
    """在训练集上拟合分位数阈值。"""
    q_hi = float(quantile)
    q_lo = 1.0 - q_hi
    valid = df.dropna(subset=["efficiency", "vol_z", "range_z"])
    if valid.empty:
        return ClassifyThresholds(
            efficiency_high=0.65,
            efficiency_low=0.25,
            vol_z_high=1.0,
            vol_z_low=-0.5,
            range_z_high=1.0,
            range_z_low=-0.5,
            quantile=quantile,
        )
    return ClassifyThresholds(
        efficiency_high=float(valid["efficiency"].quantile(q_hi)),
        efficiency_low=float(valid["efficiency"].quantile(q_lo)),
        vol_z_high=float(valid["vol_z"].quantile(q_hi)),
        vol_z_low=float(valid["vol_z"].quantile(q_lo)),
        range_z_high=float(valid["range_z"].quantile(q_hi)),
        range_z_low=float(valid["range_z"].quantile(q_lo)),
        quantile=quantile,
    )


def _classify_one(
    row: pd.Series,
    th: ClassifyThresholds,
    *,
    trend_end: bool = False,
    h1_dir: int = 0,
) -> str:
    """单根 K 分类。h1_dir: 1 多 -1 空 0 中性。"""
    eff = row.get("efficiency")
    vol_z = row.get("vol_z")
    range_z = row.get("range_z")
    gap = row.get("effort_result_gap")
    body = row.get("body")

    if any(pd.isna(x) for x in (eff, vol_z, range_z)):
        return "other"

    eff = float(eff)
    vol_z = float(vol_z)
    range_z = float(range_z)
    gap = float(gap) if pd.notna(gap) else vol_z - range_z
    body_sign = 0 if pd.isna(body) else (1 if float(body) > 0 else (-1 if float(body) < 0 else 0))

    vol_high = vol_z >= th.vol_z_high
    range_high = range_z >= th.range_z_high
    vol_low = vol_z <= th.vol_z_low
    range_low = range_z <= th.range_z_low
    eff_high = eff >= th.efficiency_high
    eff_low = eff <= th.efficiency_low

    # climax：量与波动都极端，且处于 1h 趋势末端
    if vol_high and range_high and trend_end:
        return "climax"

    # confirm：量大 + 波动大 + 与 1h 方向一致
    if vol_high and range_high and h1_dir != 0 and body_sign == h1_dir:
        return "confirm"

    # effort_no_result：量大、波动小、效率低
    if vol_high and (range_low or range_z <= th.range_z_low + 0.25) and eff_low:
        return "effort_no_result"
    if vol_high and gap >= (th.vol_z_high - th.range_z_low) and eff_low:
        return "effort_no_result"

    # thrust：价效能高，量不必很大
    if eff_high and not (vol_high and range_low):
        return "thrust"

    return "other"


def classify_bars(
    df: pd.DataFrame,
    thresholds: ClassifyThresholds,
    *,
    trend_end_col: str = "h1_trend_end",
    h1_dir_col: str = "h1_dir",
) -> pd.DataFrame:
    """为每根 K 增加 bar_class 列。"""
    out = df.copy()
    classes: list[str] = []
    for _, row in out.iterrows():
        trend_end = bool(row[trend_end_col]) if trend_end_col in out.columns else False
        h1_dir = int(row[h1_dir_col]) if h1_dir_col in out.columns and pd.notna(row.get(h1_dir_col)) else 0
        classes.append(_classify_one(row, thresholds, trend_end=trend_end, h1_dir=h1_dir))
    out["bar_class"] = classes
    return out
