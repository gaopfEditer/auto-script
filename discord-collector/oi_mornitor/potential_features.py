"""潜力扫描 · 公共特征库（仅用已收盘 K 线）。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd


def closed_df(df: pd.DataFrame) -> pd.DataFrame:
    """去掉最后一根（视为未收盘）。"""
    if df is None or df.empty:
        return df
    if len(df) <= 1:
        return df.iloc[:0].copy()
    return df.iloc[:-1].copy()


def last_closed_bar_open_ms(df: pd.DataFrame) -> int | None:
    """最近一根已收盘 K 的 open_time（毫秒）。"""
    if df is None or df.empty or "open_time" not in df.columns:
        return None
    try:
        return int(df.iloc[-1]["open_time"])
    except (TypeError, ValueError, KeyError):
        return None


def ms_to_utc8_str(ms: int | None) -> str | None:
    if ms is None:
        return None
    from datetime import datetime, timedelta, timezone

    tz = timezone(timedelta(hours=8))
    try:
        return datetime.fromtimestamp(int(ms) / 1000.0, tz=tz).strftime("%Y-%m-%d %H:%M")
    except (TypeError, ValueError, OSError):
        return None


def _col(df: pd.DataFrame, name: str) -> pd.Series:
    if name not in df.columns:
        return pd.Series(dtype=float)
    return df[name].astype(float)


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def wilder_atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    hi, lo, c = _col(df, "high"), _col(df, "low"), _col(df, "close")
    prev = c.shift(1)
    tr = pd.concat([(hi - lo), (hi - prev).abs(), (lo - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def ret_pct(df: pd.DataFrame, bars: int) -> float | None:
    c = _col(df, "close")
    if len(c) <= bars:
        return None
    a, b = float(c.iloc[-1]), float(c.iloc[-1 - bars])
    if b <= 0:
        return None
    return a / b - 1.0


def volume_ratio(df: pd.DataFrame, ma: int = 20) -> float | None:
    v = _col(df, "volume")
    if len(v) < ma + 1:
        return None
    ma_v = float(v.iloc[-ma - 1 : -1].mean())
    if ma_v <= 0:
        return None
    return float(v.iloc[-1]) / ma_v


def volume_ratio_at(df: pd.DataFrame, bar_off: int, ma: int = 20) -> float | None:
    """bar_off=0 为最后一根；量比相对其前 ma 根均量。"""
    v = _col(df, "volume")
    i = len(v) - 1 - int(bar_off)
    if i < ma or i < 0:
        return None
    ma_v = float(v.iloc[i - ma : i].mean())
    if ma_v <= 0:
        return None
    return float(v.iloc[i]) / ma_v


def volume_quiet_ratio(df: pd.DataFrame, short_bars: int, long_bars: int) -> float | None:
    """近期成交量中位数 / 长期中位数（越低表示量越沉寂）。"""
    v = _col(df, "volume")
    if len(v) < long_bars:
        return None
    short = float(np.median(v.iloc[-short_bars:]))
    long = float(np.median(v.iloc[-long_bars:]))
    if long <= 0:
        return None
    return short / long


def volume_quiet_ratio_pre_spike(
    df: pd.DataFrame,
    short_bars: int,
    long_bars: int,
    exclude_tail: int,
) -> float | None:
    """放量前：紧邻事件窗的短期量 / 再往前长期基线（越低越沉寂）。"""
    v = _col(df, "volume")
    tail = max(0, int(exclude_tail))
    end = len(v) - tail
    need = short_bars + long_bars
    if end < need:
        return None
    seg = v.iloc[:end]
    short = float(np.median(seg.iloc[-short_bars:]))
    long = float(np.median(seg.iloc[-need:-short_bars]))
    if long <= 0:
        return None
    return short / long


def recent_volume_spike_offset(
    df: pd.DataFrame,
    lookback: int,
    ma: int,
    spike_min: float,
) -> int | None:
    """最近 lookback 根内（不含当前）最近一次量比 >= spike_min 的 bar_off；无则 None。"""
    for off in range(1, int(lookback) + 1):
        vr = volume_ratio_at(df, off, ma)
        if vr is not None and vr >= float(spike_min):
            return off
    return None


def volume_sustain_after_spike(
    df: pd.DataFrame,
    spike_off: int,
    sustain_bars: int,
    mild_min: float,
    ma: int = 20,
) -> tuple[bool, int, float | None]:
    """
    放量柱之后 sustain_bars 根（含当前）量能均 >= mild_min×均量，且收盘未跌破 spike 收盘过多。
    返回 (ok, bars_ok, price_ret_since_spike)。
    """
    v = _col(df, "volume")
    c = _col(df, "close")
    spike_i = len(v) - 1 - int(spike_off)
    if spike_i < ma or spike_i >= len(v) - 1:
        return False, 0, None
    spike_close = float(c.iloc[spike_i])
    if spike_close <= 0:
        return False, 0, None
    need = int(sustain_bars)
    ok_bars = 0
    for j in range(spike_i + 1, len(v)):
        ma_v = float(v.iloc[j - ma : j].mean()) if j >= ma else float(v.iloc[:j].mean())
        if ma_v <= 0:
            continue
        if float(v.iloc[j]) / ma_v >= float(mild_min):
            ok_bars += 1
    price_ret = float(c.iloc[-1]) / spike_close - 1.0
    sustained = ok_bars >= need and price_ret >= -0.02
    return sustained, ok_bars, price_ret


def vol_z(df: pd.DataFrame, idx: int = -1, n: int = 20) -> float | None:
    v = _col(df, "volume")
    if len(v) < n + 1:
        return None
    i = len(v) + idx if idx < 0 else idx
    window = v.iloc[max(0, i - n + 1) : i + 1]
    if len(window) < 3:
        return None
    mu, sd = float(window.mean()), float(window.std())
    if sd <= 0:
        return 0.0
    return (float(v.iloc[i]) - mu) / sd


def atr_pctile(df: pd.DataFrame, window: int = 90) -> float | None:
    c = _col(df, "close")
    atr = wilder_atr(df, 14)
    pct = (atr / c.replace(0, np.nan)).astype(float)
    if len(pct) < window:
        window = len(pct)
    if window < 10:
        return None
    cur = float(pct.iloc[-1])
    hist = pct.iloc[-window:]
    return float((hist <= cur).sum()) / len(hist)


def range_width(df: pd.DataFrame, n: int) -> float | None:
    if len(df) < n:
        return None
    seg = df.iloc[-n:]
    hi = float(_col(seg, "high").max())
    lo = float(_col(seg, "low").min())
    mid = float(_col(seg, "close").mean())
    if mid <= 0:
        return None
    return (hi - lo) / mid


def oi_series(df: pd.DataFrame) -> pd.Series:
    if "open_interest" not in df.columns:
        return pd.Series(dtype=float)
    return df["open_interest"].astype(float)


def oi_chg_pct(df: pd.DataFrame, bars: int) -> float | None:
    oi = oi_series(df)
    if len(oi) <= bars:
        return None
    now, prev = float(oi.iloc[-1]), float(oi.iloc[-1 - bars])
    if prev <= 0 or pd.isna(now) or pd.isna(prev):
        return None
    return now / prev - 1.0


def oi_slope(df: pd.DataFrame, k: int) -> float | None:
    oi = oi_series(df).dropna()
    if len(oi) < k:
        return None
    seg = oi.iloc[-k:].values.astype(float)
    x = np.arange(len(seg))
    coef = np.polyfit(x, seg, 1)[0]
    mean = float(seg.mean())
    if mean <= 0:
        return None
    return coef / mean


def oi_quiet_ratio(df: pd.DataFrame, short_bars: int, long_bars: int) -> float | None:
    oi = oi_series(df).dropna()
    if len(oi) < long_bars:
        return None
    short = float(np.median(oi.iloc[-short_bars:]))
    long = float(np.median(oi.iloc[-long_bars:]))
    if long <= 0:
        return None
    return short / long


def oi_accel(df: pd.DataFrame) -> float | None:
    s3, s7 = oi_slope(df, 3), oi_slope(df, 7)
    if s3 is None or s7 is None:
        return None
    return s3 - s7


def fund_mean(rates: list[float], n: int) -> float | None:
    if not rates:
        return None
    seg = rates[-n:]
    if not seg:
        return None
    return float(sum(seg) / len(seg))


def fund_neg_streak(rates: list[float]) -> int:
    streak = 0
    for r in reversed(rates):
        if r < 0:
            streak += 1
        else:
            break
    return streak


def fund_pctile(rates: list[float], mean_n: int = 3, window: int = 30) -> float | None:
    if len(rates) < mean_n + 5:
        return None
    cur = fund_mean(rates, mean_n)
    if cur is None:
        return None
    hist = [fund_mean(rates[: i + 1], mean_n) for i in range(mean_n - 1, min(len(rates), window + mean_n))]
    hist = [h for h in hist if h is not None]
    if len(hist) < 5:
        return None
    return float(sum(1 for h in hist if h <= cur) / len(hist))


def vs_btc(coin_df: pd.DataFrame, btc_df: pd.DataFrame, bars: int) -> float | None:
    rc, rb = ret_pct(coin_df, bars), ret_pct(btc_df, bars)
    if rc is None or rb is None:
        return None
    return rc - rb


def btc_regime(btc_df: pd.DataFrame, bars: int, down_th: float, flat_th: float) -> str:
    r = ret_pct(btc_df, bars)
    if r is None:
        return "flat"
    if r < down_th:
        return "down"
    if abs(r) < flat_th:
        return "flat"
    return "up"


def new_low(df: pd.DataFrame, lookback: int) -> bool:
    if len(df) < lookback + 1:
        return False
    lo = float(_col(df, "low").iloc[-1])
    prev_min = float(_col(df.iloc[-lookback - 1 : -1], "low").min())
    return lo <= prev_min * 1.0001


def coin_btc_ema_bull(coin_df: pd.DataFrame, btc_df: pd.DataFrame) -> bool:
    if len(coin_df) < 55 or len(btc_df) < 55:
        return False
    ratio = _col(coin_df, "close").values / _col(btc_df, "close").replace(0, np.nan).values
    ratio = pd.Series(ratio[-len(coin_df) :])
    if ratio.isna().all():
        return False
    e20, e50 = ema(ratio, 20), ema(ratio, 50)
    if len(e20) < 3:
        return False
    slope = float(e20.iloc[-1] - e20.iloc[-3])
    return float(e20.iloc[-1]) > float(e50.iloc[-1]) and slope > 0


def detect_btc_turn(btc_1h: pd.DataFrame) -> bool:
    """1h 止跌：前序偏弱后出现阳吞没或站回 EMA20。"""
    df = closed_df(btc_1h)
    if len(df) < 25:
        return False
    c, o, h, l = _col(df, "close"), _col(df, "open"), _col(df, "high"), _col(df, "low")
    e20 = ema(c, 20)
    prev_down = float(c.iloc[-4]) > float(c.iloc[-2])
    bull_engulf = float(c.iloc[-1]) > float(o.iloc[-1]) and float(c.iloc[-1]) > float(h.iloc[-2])
    reclaim = float(c.iloc[-1]) >= float(e20.iloc[-1])
    return (bull_engulf or reclaim) and prev_down


def swing_points(df: pd.DataFrame, L: int = 3) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
    hi, lo = _col(df, "high"), _col(df, "low")
    sh: list[tuple[int, float]] = []
    sl: list[tuple[int, float]] = []
    for i in range(L, len(df) - L):
        if hi.iloc[i] >= hi.iloc[i - L : i + L + 1].max():
            sh.append((i, float(hi.iloc[i])))
        if lo.iloc[i] <= lo.iloc[i - L : i + L + 1].min():
            sl.append((i, float(lo.iloc[i])))
    return sh, sl


def equal_levels(
    points: list[tuple[int, float]],
    tol_pct: float,
    min_sep: int,
    max_sep: int,
) -> tuple[float, float] | None:
    if len(points) < 2:
        return None
    for i in range(len(points) - 1, 0, -1):
        i2, p2 = points[i]
        for j in range(i - 1, -1, -1):
            i1, p1 = points[j]
            gap = i2 - i1
            if gap < min_sep or gap > max_sep:
                continue
            mid = (p1 + p2) / 2
            if mid <= 0:
                continue
            if abs(p1 - p2) / mid <= tol_pct:
                return (p1 + p2) / 2, float(gap)
    return None


@dataclass
class SymbolFeed:
    symbol: str
    quote_volume_24h: float = 0.0
    mcap_usd: float | None = None
    funding_rates: list[float] = field(default_factory=list)
    spot_premium: float | None = None
    candles: dict[str, pd.DataFrame] = field(default_factory=dict)
    btc_candles: dict[str, pd.DataFrame] = field(default_factory=dict)
    notes: str = ""
    scan_profile: str = ""  # "fast" | "slow" | ""

    def df(self, tf: str) -> pd.DataFrame:
        raw = self.candles.get(tf)
        if raw is None or raw.empty:
            return pd.DataFrame()
        return closed_df(raw)

    def btc(self, tf: str) -> pd.DataFrame:
        raw = self.btc_candles.get(tf)
        if raw is None or raw.empty:
            return pd.DataFrame()
        return closed_df(raw)
