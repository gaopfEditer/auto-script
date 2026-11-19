"""BTC/ETH 已收盘 5 分钟放量影线（多空）。

这是气泡 / 报告队列 / 图表标记与后续研究应共用的口径。阈值全部是命名常量，
几何与放量判定复用 ``volume_price.vp_mtf_signals`` 的「放量插针」定义，
但 **不含** ``vol_climax`` 仅凭阴阳线判向的回退（那不是影线信号）。

触发（须同时满足；调用方只传入已收盘 K）：

1. 放量：``volume >= VOL_RATIO_MIN(1.5) × vol_ma``，
   ``vol_ma = SMA(volume, VOL_MA_PERIOD=20)``，量能看信号柱本身，不向前看。
2. 影线（``pin_side``），按优先级只给一个方向：
   a. 射击之星 → 空：上影 ∈ [WICK_BODY_RATIO(1.5), WICK_BODY_MAX(20)] × 实体，
      且（无下影，或下影 × 2 < 上影）
   b. 倒锤子 → 多：下影 ∈ [1.5, 20] × 实体，且（无上影，或上影 × 2 < 下影）
   c. 宽口径上影 → 空：上影 >= LOOSE_PIN_WICK_BODY(1.05)×实体
      且 >= LOOSE_PIN_WICK_RANGE(0.32)×振幅
   d. 宽口径下影 → 多：下影 >= 1.05×实体 且 >= 0.32×振幅

不使用 15m/1h 趋势否决，也不使用 5m POP 的 4 项打分（score≥3）。
方向：下影为多，上影为空。默认标的 BTCUSDT / ETHUSDT，周期 5m。
"""
from __future__ import annotations

from typing import Any, Literal

import pandas as pd

from oi_mornitor.volume_price.vp_mtf_signals import (
    LOOSE_PIN_WICK_BODY as _LOOSE_BODY,
    LOOSE_PIN_WICK_RANGE as _LOOSE_RANGE,
    SHOOT_WICK_MAX,
    SHOOT_WICK_RATIO,
    VOL_PIN_MA_MULT,
    VP_FEATURE_WINDOW,
    _vol_feats,
    detect_inverted_hammer,
    detect_shooting_star,
    pin_side,
    vol_pin_spike,
)

STRATEGY_ID = "st_5m_vol_wick_btc_eth_v0"
VOL_MA_PERIOD = int(VP_FEATURE_WINDOW)  # 20
VOL_RATIO_MIN = float(VOL_PIN_MA_MULT)  # 1.5
WICK_BODY_RATIO = float(SHOOT_WICK_RATIO)  # 1.5
WICK_BODY_MAX = float(SHOOT_WICK_MAX)  # 20
LOOSE_PIN_WICK_BODY = float(_LOOSE_BODY)  # 1.05
LOOSE_PIN_WICK_RANGE = float(_LOOSE_RANGE)  # 0.32

PatternKind = Literal["shooting_star", "inverted_hammer", "upper_wick", "lower_wick"]

_PATTERN_LABEL = {
    "shooting_star": "放量射击之星",
    "inverted_hammer": "放量倒锤子",
    "upper_wick": "放量上影",
    "lower_wick": "放量下影",
}


def klines_to_df(rows: list[list[Any]]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(
        rows,
        columns=[
            "open_time",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "close_time",
            "qav",
            "ntr",
            "tbv",
            "tbq",
            "ignore",
        ],
    )
    for c in ("open", "high", "low", "close", "volume"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["open_time"] = pd.to_numeric(df["open_time"], errors="coerce").astype("int64")
    return df.sort_values("open_time").reset_index(drop=True)


def _pattern_kind(row: pd.Series) -> PatternKind | None:
    """与 ``_pin_side`` 同一优先级，额外标出是官方形态还是宽口径影线。"""
    if detect_shooting_star(row, at_lower=False):
        return "shooting_star"
    if detect_inverted_hammer(row):
        return "inverted_hammer"
    side = pin_side(row)
    if side == "short":
        return "upper_wick"
    if side == "long":
        return "lower_wick"
    return None


def _event(df: pd.DataFrame, idx: int, *, symbol: str, interval: str) -> dict[str, Any] | None:
    if idx < VOL_MA_PERIOD - 1 or idx >= len(df):
        return None
    row = df.iloc[idx]
    vol = float(row.get("volume") or 0)
    vol_ma = float(row.get("vol_ma") or 0)
    ratio = (vol / vol_ma) if vol_ma > 0 else None
    surged = vol_pin_spike(vol, vol_ma)
    kind = _pattern_kind(row)
    side_pin = pin_side(row)
    triggered = bool(surged and kind and side_pin)
    ts = int(row["open_time"])
    side = "long" if side_pin == "long" else "short" if side_pin == "short" else None
    return {
        "strategy": STRATEGY_ID,
        "symbol": symbol,
        "interval": interval,
        "signalTs": ts,
        "barOpenTime": ts,
        "side": side,
        "patternKind": kind,
        "pattern": _PATTERN_LABEL.get(kind or "", ""),
        "volumeRatio": None if ratio is None else round(float(ratio), 4),
        "volumeSurge": surged,
        "volMaPeriod": VOL_MA_PERIOD,
        "thresholds": {
            "volRatioMin": VOL_RATIO_MIN,
            "volMaPeriod": VOL_MA_PERIOD,
            "wickBodyRatio": WICK_BODY_RATIO,
            "wickBodyMax": WICK_BODY_MAX,
            "looseWickBody": LOOSE_PIN_WICK_BODY,
            "looseWickRange": LOOSE_PIN_WICK_RANGE,
        },
        "entryRef": float(row["close"]),
        "wickExtreme": float(row["low"]) if side == "long" else float(row["high"]) if side == "short" else None,
        "triggered": triggered,
    }


def evaluate_bar_at(
    df: pd.DataFrame,
    idx: int,
    *,
    symbol: str,
    interval: str = "5m",
) -> dict[str, Any] | None:
    """评估已带 vol_ma 的 DataFrame 中第 idx 根（0-based）。"""
    featured = df if "vol_ma" in df.columns else _vol_feats(df)
    return _event(featured, idx, symbol=symbol, interval=interval)


def evaluate_last_closed_bar(
    df5: pd.DataFrame,
    *,
    symbol: str,
    interval: str = "5m",
) -> dict[str, Any] | None:
    """仅评估最后一根；调用方须已去掉未收盘棒。"""
    if df5 is None or len(df5) < VOL_MA_PERIOD:
        return None
    featured = _vol_feats(df5)
    return _event(featured, len(featured) - 1, symbol=symbol, interval=interval)


def scan_closed_bars(
    df5: pd.DataFrame,
    *,
    symbol: str,
    interval: str = "5m",
    triggered_only: bool = True,
) -> list[dict[str, Any]]:
    """扫描全部已收盘柱（调用方勿含未收盘棒）。研究复用入口。"""
    if df5 is None or len(df5) < VOL_MA_PERIOD:
        return []
    featured = _vol_feats(df5)
    out: list[dict[str, Any]] = []
    for i in range(VOL_MA_PERIOD - 1, len(featured)):
        ev = _event(featured, i, symbol=symbol, interval=interval)
        if ev is None:
            continue
        if triggered_only and not ev.get("triggered"):
            continue
        out.append(ev)
    return out
