"""市场环境识别：4h/1h 趋势 / 震荡 / 转换；无前瞻摆动点。

摆动高低点只用已收盘 K：在 end_idx 处，仅确认「右侧已有 order 根」的极值
（等价于用到当前收盘为止的数据，不用未来 K 确认）。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Iterable

import pandas as pd

SWING_ORDER = 5
# 震荡区间：两高/两低相对水平的最大偏离（占区间高度或价格）。
RANGE_TOUCH_TOL = 0.012
RANGE_MID_SLOPE_MAX = 0.0015  # 中线斜率（相对价格 / 根）
RANGE_MIN_WIDTH_ATR = 1.2
RANGE_MAX_WIDTH_PCT = 0.12
RANGE_MIN_BARS = 16
EDGE_ZONE = 0.28  # 靠近上/下沿的区间比例；中间带不交易
EMA_FAST = 20
EMA_SLOW = 50


@dataclass(frozen=True)
class Regime:
    label: str  # trend_up / trend_down / range / transition
    tf: str
    ema_aligned: bool
    price_side: str  # above / below / inside
    vol_state: str  # expansion / contraction / unknown
    reason: str
    range_high: float | None = None
    range_low: float | None = None
    range_mid: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _ema(series: pd.Series, span: int) -> pd.Series:
    return series.astype(float).ewm(span=span, adjust=False).mean()


def confirmed_swings(
    df: pd.DataFrame,
    *,
    end_idx: int,
    order: int = SWING_ORDER,
    which: str = "high",
) -> list[tuple[int, float]]:
    """无前瞻摆动：摆动点 i 需满足 i+order <= end_idx，且 i 为 [i-order, i+order] 极值。"""
    if df is None or df.empty or end_idx < order * 2:
        return []
    end_idx = min(int(end_idx), len(df) - 1)
    col = "high" if which == "high" else "low"
    vals = df[col].astype(float).values
    out: list[tuple[int, float]] = []
    last_ok = end_idx - order
    for i in range(order, last_ok + 1):
        window = vals[i - order : i + order + 1]
        v = vals[i]
        if which == "high":
            if v >= float(window.max()) and (window.argmax() == order or v == float(window.max())):
                # 若并列，取窗口内最左的高点；仅当本 i 是该最大值的代表
                if float(window.max()) == v and int(window.argmax()) == order:
                    out.append((i, float(v)))
        else:
            if v <= float(window.min()) and int(window.argmin()) == order:
                out.append((i, float(v)))
    return out


def last_confirmed_swing(
    df: pd.DataFrame,
    *,
    end_idx: int,
    which: str,
    order: int = SWING_ORDER,
) -> tuple[int, float] | None:
    swings = confirmed_swings(df, end_idx=end_idx, order=order, which=which)
    return swings[-1] if swings else None


def bos_by_close(
    df: pd.DataFrame,
    *,
    bar_idx: int,
    side: str,
    order: int = SWING_ORDER,
) -> bool:
    """1h 有效突破：收盘价确认越过最近已确认摆动，而非仅影线刺破。"""
    if bar_idx < 0 or bar_idx >= len(df):
        return False
    close = float(df.iloc[bar_idx]["close"])
    if side in ("long", "bull", "up"):
        sw = last_confirmed_swing(df, end_idx=bar_idx - 1, which="high", order=order)
        return bool(sw and close > sw[1])
    sw = last_confirmed_swing(df, end_idx=bar_idx - 1, which="low", order=order)
    return bool(sw and close < sw[1])


def wick_only_break(
    df: pd.DataFrame,
    *,
    bar_idx: int,
    level: float,
    side: str,
) -> bool:
    row = df.iloc[bar_idx]
    close = float(row["close"])
    high = float(row["high"])
    low = float(row["low"])
    if side in ("long", "bull", "up"):
        return high > level and close <= level
    return low < level and close >= level


def close_confirms_break(row: pd.Series, level: float, *, side: str) -> bool:
    close = float(row["close"])
    if side in ("long", "bull", "up"):
        return close > level
    return close < level


def choch_by_close(
    df: pd.DataFrame,
    *,
    bar_idx: int,
    prior_trend: str,
    order: int = SWING_ORDER,
) -> bool:
    """结构转变：先前下跌趋势中收盘突破最近摆动高（看多 CHoCH），反之亦然。"""
    if prior_trend in ("down", "trend_down", "short"):
        return bos_by_close(df, bar_idx=bar_idx, side="long", order=order)
    if prior_trend in ("up", "trend_up", "long"):
        return bos_by_close(df, bar_idx=bar_idx, side="short", order=order)
    return False


def _vol_state(df: pd.DataFrame, idx: int, lookback: int = 20) -> str:
    if "volume" not in df.columns or idx < lookback:
        return "unknown"
    vol = df["volume"].astype(float)
    ma = float(vol.iloc[max(0, idx - lookback) : idx].mean() or 0)
    if ma <= 0:
        return "unknown"
    cur = float(vol.iloc[idx])
    if cur >= ma * 1.2:
        return "expansion"
    if cur <= ma * 0.8:
        return "contraction"
    return "unknown"


def classify_trend_regime(df: pd.DataFrame, *, end_idx: int, tf: str = "1h") -> Regime:
    """均线方向一致 + 价格处于趋势有利一侧 → trend；否则看是否构成严格区间。"""
    end_idx = min(int(end_idx), len(df) - 1)
    if df is None or df.empty or end_idx < EMA_SLOW + 2:
        return Regime("transition", tf, False, "inside", "unknown", "insufficient_bars")
    close = df["close"].astype(float)
    ema_f = _ema(close, EMA_FAST)
    ema_s = _ema(close, EMA_SLOW)
    px = float(close.iloc[end_idx])
    f = float(ema_f.iloc[end_idx])
    s = float(ema_s.iloc[end_idx])
    f_prev = float(ema_f.iloc[end_idx - 3])
    s_prev = float(ema_s.iloc[end_idx - 3])
    f_up = f > f_prev and f > s
    f_dn = f < f_prev and f < s
    s_up = s >= s_prev
    s_dn = s <= s_prev
    vol = _vol_state(df, end_idx)
    aligned_up = f_up and s_up and px > f and px > s
    aligned_dn = f_dn and s_dn and px < f and px < s
    if aligned_up:
        return Regime("trend_up", tf, True, "above", vol, "ema_aligned_price_above")
    if aligned_dn:
        return Regime("trend_down", tf, True, "below", vol, "ema_aligned_price_below")

    rng = identify_range(df, end_idx=end_idx)
    if rng is not None:
        return Regime(
            "range",
            tf,
            False,
            "inside",
            vol,
            "strict_range",
            range_high=rng["high"],
            range_low=rng["low"],
            range_mid=rng["mid"],
        )
    side = "above" if px > f else ("below" if px < s else "inside")
    return Regime("transition", tf, False, side, vol, "emas_not_aligned")


def identify_range(df: pd.DataFrame, *, end_idx: int, order: int = SWING_ORDER) -> dict[str, float] | None:
    """严格区间：至少两高两低贴近水平边界、中线走平、宽度合理，且当前非趋势突破。

    不用「近摆动波幅/close ≤ 4%」或单纯 trend==transition 当震荡。
    趋势行情（更高高/更低低 + 均线展开）不得标成区间。
    """
    if end_idx < RANGE_MIN_BARS:
        return None
    close = df["close"].astype(float)
    px = float(close.iloc[end_idx])
    ema_f = _ema(close, EMA_FAST)
    ema_s = _ema(close, EMA_SLOW)
    f = float(ema_f.iloc[end_idx])
    s = float(ema_s.iloc[end_idx])
    # 均线明显展开且价格单侧 → 趋势，禁止当震荡
    sep = abs(f - s) / px if px else 0.0
    if sep > 0.02 and ((px > f > s) or (px < f < s)):
        f_slope = (f - float(ema_f.iloc[max(0, end_idx - 8)])) / px
        if abs(f_slope) > RANGE_MID_SLOPE_MAX * 4:
            return None

    highs = confirmed_swings(df, end_idx=end_idx, order=order, which="high")
    lows = confirmed_swings(df, end_idx=end_idx, order=order, which="low")
    if len(highs) < 2 or len(lows) < 2:
        return None
    # 取最近若干摆动估水平
    recent_h = highs[-4:]
    recent_l = lows[-4:]
    # 需要至少两个高点彼此接近
    h_level = None
    for i, (_, a) in enumerate(recent_h):
        near = [v for _, v in recent_h if abs(v - a) / a <= RANGE_TOUCH_TOL]
        if len(near) >= 2:
            h_level = sum(near) / len(near)
            break
    l_level = None
    for i, (_, a) in enumerate(recent_l):
        near = [v for _, v in recent_l if a > 0 and abs(v - a) / a <= RANGE_TOUCH_TOL]
        if len(near) >= 2:
            l_level = sum(near) / len(near)
            break
    if h_level is None or l_level is None or h_level <= l_level:
        return None
    mid = (h_level + l_level) / 2.0
    width = h_level - l_level
    width_pct = width / mid if mid else 0.0
    if width_pct <= 0 or width_pct > RANGE_MAX_WIDTH_PCT:
        return None
    atr = _atr(df, end_idx)
    if atr > 0 and width < RANGE_MIN_WIDTH_ATR * atr:
        return None
    # 中线走平：区间跨越期内 close 中值斜率
    span_start = min(recent_h[0][0], recent_l[0][0])
    n = max(1, end_idx - span_start)
    mid_series_start = float(close.iloc[span_start])
    mid_slope = (px - mid_series_start) / mid_series_start / n if mid_series_start else 0.0
    if abs(mid_slope) > RANGE_MID_SLOPE_MAX:
        return None
    # 收盘有效突破区间后不再视为震荡（影线扫荡仍可）
    if px > h_level * (1 + RANGE_TOUCH_TOL) or px < l_level * (1 - RANGE_TOUCH_TOL):
        return None
    return {"high": float(h_level), "low": float(l_level), "mid": float(mid), "width": float(width)}


def _atr(df: pd.DataFrame, end_idx: int, period: int = 14) -> float:
    if end_idx < period:
        return 0.0
    trs: list[float] = []
    start = max(1, end_idx - period + 1)
    for i in range(start, end_idx + 1):
        row = df.iloc[i]
        prev = df.iloc[i - 1]
        h, l, pc = float(row["high"]), float(row["low"]), float(prev["close"])
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return sum(trs) / len(trs) if trs else 0.0


def at_range_edge(price: float, rng: dict[str, float], *, side: str | None = None) -> bool:
    """只在区间边缘交易，接近中位不追。"""
    hi, lo, mid = rng["high"], rng["low"], rng["mid"]
    width = hi - lo
    if width <= 0:
        return False
    if side == "long":
        return price <= lo + EDGE_ZONE * width
    if side == "short":
        return price >= hi - EDGE_ZONE * width
    return price <= lo + EDGE_ZONE * width or price >= hi - EDGE_ZONE * width


def near_range_mid(price: float, rng: dict[str, float]) -> bool:
    hi, lo = rng["high"], rng["low"]
    width = hi - lo
    if width <= 0:
        return True
    mid = rng["mid"]
    return abs(price - mid) <= (0.5 - EDGE_ZONE) * width


def range_valid_break(df: pd.DataFrame, *, bar_idx: int, rng: dict[str, float]) -> bool:
    """收盘确认有效突破区间（不是假突破），此后停止均值回归。"""
    close = float(df.iloc[bar_idx]["close"])
    if close > rng["high"] and close_confirms_break(df.iloc[bar_idx], rng["high"], side="long"):
        return True
    if close < rng["low"] and close_confirms_break(df.iloc[bar_idx], rng["low"], side="short"):
        return True
    return False


def immediately_reclaimed(df: pd.DataFrame, *, break_idx: int, level: float, side: str, look: int = 2) -> bool:
    """突破后迅速收回原区间（禁止条件）。"""
    n = len(df)
    for j in range(break_idx + 1, min(n, break_idx + 1 + look)):
        close = float(df.iloc[j]["close"])
        if side in ("long", "bull", "up") and close < level:
            return True
        if side in ("short", "bear", "down") and close > level:
            return True
    return False


def classify_pair(
    df_1h: pd.DataFrame | None,
    df_4h: pd.DataFrame | None,
    *,
    idx_1h: int | None = None,
    idx_4h: int | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {"regime_1h": None, "regime_4h": None}
    if df_1h is not None and len(df_1h):
        i = len(df_1h) - 1 if idx_1h is None else idx_1h
        out["regime_1h"] = classify_trend_regime(df_1h, end_idx=i, tf="1h").to_dict()
    if df_4h is not None and len(df_4h):
        i = len(df_4h) - 1 if idx_4h is None else idx_4h
        out["regime_4h"] = classify_trend_regime(df_4h, end_idx=i, tf="4h").to_dict()
    return out
