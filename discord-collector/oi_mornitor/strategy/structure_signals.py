"""顶部/底部结构识别 — 头肩+Vegas、二次探底、2B Spring、流动性掠夺。

不依赖 scipy：局部高低点用滚动窗口实现。
输入 DataFrame 需含 open/high/low/close/volume；建议先经 enrich_indicators。
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from oi_mornitor.strategy.candle_signals import closed_bar_index

# 与用户规格对齐的可调默认
SWING_ORDER = 5
HS_SHOULDER_TOL = 0.03
HS_VEGAS_SCAN_BARS = 15
CLIMAX_VOL_MULT = 2.0
CLIMAX_WICK_RATIO = 0.4
BOTTOM_WAIT_BARS = 25
BOTTOM_L2_LO = 0.98
BOTTOM_L2_HI = 1.03
BOTTOM_CLOSE_PCT = 0.70
SPRING_RECLAIM_BARS = 3
SPRING_VOL_MULT = 1.3
SWEEP_WICK_MIN_PCT = 0.15  # 影线占 range
CURVE_LOOKBACK = 20


def _ensure_structure_cols(df: pd.DataFrame) -> pd.DataFrame:
    """补齐 Vegas 中轨 / 均量 / 影线等列（幂等）。"""
    out = df
    need_copy = False

    def _ensure(col: str, series: pd.Series) -> None:
        nonlocal out, need_copy
        if col in out.columns:
            return
        if not need_copy:
            out = out.copy()
            need_copy = True
        out[col] = series

    if "vegas_e1" in out.columns and "vegas_e2" in out.columns:
        mid = (out["vegas_e1"].astype(float) + out["vegas_e2"].astype(float)) / 2.0
        _ensure("vegas_mid", mid)
        _ensure("vegas_fast_lo", out[["vegas_e1", "vegas_e2"]].min(axis=1))
        _ensure("vegas_fast_hi", out[["vegas_e1", "vegas_e2"]].max(axis=1))
    elif "close" in out.columns:
        e144 = out["close"].ewm(span=144, adjust=False).mean()
        e169 = out["close"].ewm(span=169, adjust=False).mean()
        _ensure("ema144", e144)
        _ensure("ema169", e169)
        _ensure("vegas_mid", (e144 + e169) / 2.0)
        _ensure("vegas_fast_lo", pd.concat([e144, e169], axis=1).min(axis=1))
        _ensure("vegas_fast_hi", pd.concat([e144, e169], axis=1).max(axis=1))

    vol_src = out["vol_sma20"] if "vol_sma20" in out.columns else out["volume"].rolling(20).mean()
    if "vol_ma20" not in out.columns:
        if not need_copy:
            out = out.copy()
            need_copy = True
        out["vol_ma20"] = vol_src.astype(float)

    body_bottom = out[["open", "close"]].min(axis=1)
    body_top = out[["open", "close"]].max(axis=1)
    _ensure("body_bottom", body_bottom)
    _ensure("body_top", body_top)
    _ensure("lower_wick", body_bottom - out["low"])
    _ensure("upper_wick", out["high"] - body_top)
    _ensure("candle_range", (out["high"] - out["low"]).clip(lower=0))
    return out


def mark_swing_points(df: pd.DataFrame, *, order: int = SWING_ORDER) -> pd.DataFrame:
    """前后 order 根范围内的局部高低点（等价 argrelextrema）。"""
    out = df.copy()
    win = order * 2 + 1
    hi_roll = out["high"].rolling(win, center=True).max()
    lo_roll = out["low"].rolling(win, center=True).min()
    out["is_swing_high"] = (out["high"] >= hi_roll) & out["high"].notna() & hi_roll.notna()
    out["is_swing_low"] = (out["low"] <= lo_roll) & out["low"].notna() & lo_roll.notna()
    # 边缘 rolling 为 NaN，不标
    out["is_swing_high"] = out["is_swing_high"].fillna(False)
    out["is_swing_low"] = out["is_swing_low"].fillna(False)
    return out


def _ts_sec(open_time_ms: int) -> int:
    return int(open_time_ms // 1000)


def _vol_ratio(row: pd.Series) -> float | None:
    v = float(row.get("volume") or 0)
    ma = float(row.get("vol_ma20") or row.get("vol_sma20") or 0)
    if ma <= 0:
        return None
    return v / ma


def _neckline_between(
    df: pd.DataFrame, i_left: int, i_right: int
) -> tuple[float, int] | None:
    """两高点之间的最低低点作为颈线参考。"""
    if i_right <= i_left + 1:
        return None
    seg = df.iloc[i_left + 1 : i_right]
    if seg.empty:
        return None
    pos = int(seg["low"].astype(float).values.argmin())
    abs_pos = i_left + 1 + pos
    return float(df.iloc[abs_pos]["low"]), abs_pos


def detect_structure_events(df: pd.DataFrame) -> list[dict[str, Any]]:
    """全历史扫描，返回带元数据的结构事件（触发 K 位置）。"""
    if df is None or df.empty or len(df) < 40:
        return []
    work = _ensure_structure_cols(df)
    if "vegas_mid" not in work.columns:
        return []
    work = mark_swing_points(work, order=SWING_ORDER)
    events: list[dict[str, Any]] = []

    events.extend(_detect_hs_vegas(work))
    events.extend(_detect_m_top_vegas(work))
    events.extend(_detect_bottom_reversal(work))
    events.extend(_detect_spring_2b(work))
    events.extend(_detect_liquidity_sweep(work))
    events.extend(_detect_curvature_decay(work))
    return events


def find_last_closed_structure_hits(
    df: pd.DataFrame,
    *,
    now_ms: int | None = None,
) -> list[dict[str, Any]]:
    """仅保留落在最近已收盘 K 上的结构信号。"""
    if df is None or df.empty or "open_time" not in df.columns:
        return []
    idx = closed_bar_index(df, now_ms=now_ms)
    if idx < 0:
        return []
    closed_ts = _ts_sec(int(df.iloc[idx]["open_time"]))
    events = detect_structure_events(df)
    hits: list[dict[str, Any]] = []
    seen: set[str] = set()
    for ev in events:
        if int(ev.get("bar_index", -1)) != idx:
            continue
        kind = str(ev.get("kind") or "")
        if kind in seen:
            continue
        seen.add(kind)
        row = df.iloc[idx]
        hits.append({
            **ev,
            "time": closed_ts,
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "price": float(row["close"]),
        })
    return hits


def _detect_hs_vegas(df: pd.DataFrame) -> list[dict[str, Any]]:
    """头肩顶 + 右肩后跌破 Vegas 中轨。"""
    highs = [(i, float(df.iloc[i]["high"])) for i in range(len(df)) if bool(df.iloc[i]["is_swing_high"])]
    if len(highs) < 3:
        return []
    out: list[dict[str, Any]] = []
    used_triggers: set[int] = set()

    for a in range(len(highs) - 2):
        i1, p1 = highs[a]
        i2, p2 = highs[a + 1]
        i3, p3 = highs[a + 2]
        if not (p2 > p1 and p2 > p3):
            continue
        if p1 <= 0:
            continue
        if abs(p1 - p3) / p1 > HS_SHOULDER_TOL:
            continue
        neck = _neckline_between(df, i1, i3)
        neck_price = neck[0] if neck else min(
            float(df.iloc[i1]["low"]), float(df.iloc[i3]["low"])
        )

        end = min(len(df), i3 + 1 + HS_VEGAS_SCAN_BARS)
        for j in range(i3 + 1, end):
            if j in used_triggers:
                continue
            row = df.iloc[j]
            prev = df.iloc[j - 1]
            mid = float(row["vegas_mid"]) if pd.notna(row["vegas_mid"]) else None
            prev_mid = float(prev["vegas_mid"]) if pd.notna(prev["vegas_mid"]) else None
            if mid is None or prev_mid is None:
                continue
            # 实体跌破 Vegas 中轨（由上穿下）
            crossed = float(row["close"]) < mid and float(prev["close"]) >= prev_mid
            # 或同时跌破颈线
            broke_neck = float(row["close"]) < neck_price
            if not crossed and not (broke_neck and float(row["close"]) < mid):
                continue
            vr = _vol_ratio(row)
            out.append({
                "kind": "hs_vegas_break",
                "side": "bear",
                "type_label": "顶部结构确认",
                "pattern_label": "头肩顶 / 跌破维加斯通道",
                "bar_index": j,
                "head_high": p2,
                "left_shoulder": p1,
                "right_shoulder": p3,
                "neckline": neck_price,
                "vegas_mid": mid,
                "vol_ratio": vr,
                "defense": p3,
                "support_ref": neck_price,
            })
            used_triggers.add(j)
            break
    return out


def _detect_m_top_vegas(df: pd.DataFrame) -> list[dict[str, Any]]:
    """M 顶：两高近似等高，之后跌破 Vegas。与头肩去重（同触发柱优先保留 hs）。"""
    highs = [(i, float(df.iloc[i]["high"])) for i in range(len(df)) if bool(df.iloc[i]["is_swing_high"])]
    if len(highs) < 2:
        return []
    out: list[dict[str, Any]] = []
    used: set[int] = set()
    for a in range(len(highs) - 1):
        i1, p1 = highs[a]
        i2, p2 = highs[a + 1]
        if p1 <= 0:
            continue
        # 两峰接近，且间隔足够
        if abs(p1 - p2) / p1 > HS_SHOULDER_TOL:
            continue
        if i2 - i1 < SWING_ORDER:
            continue
        # 中间有明显回落
        mid_lo = float(df.iloc[i1:i2]["low"].min())
        if mid_lo >= min(p1, p2) * 0.985:
            continue
        end = min(len(df), i2 + 1 + HS_VEGAS_SCAN_BARS)
        for j in range(i2 + 1, end):
            if j in used:
                continue
            row = df.iloc[j]
            prev = df.iloc[j - 1]
            mid = float(row["vegas_mid"]) if pd.notna(row["vegas_mid"]) else None
            prev_mid = float(prev["vegas_mid"]) if pd.notna(prev["vegas_mid"]) else None
            if mid is None or prev_mid is None:
                continue
            if not (float(row["close"]) < mid and float(prev["close"]) >= prev_mid):
                continue
            vr = _vol_ratio(row)
            out.append({
                "kind": "m_top_vegas_break",
                "side": "bear",
                "type_label": "顶部结构确认",
                "pattern_label": "M顶 / 跌破维加斯通道",
                "bar_index": j,
                "head_high": max(p1, p2),
                "left_shoulder": p1,
                "right_shoulder": p2,
                "neckline": mid_lo,
                "vegas_mid": mid,
                "vol_ratio": vr,
                "defense": max(p1, p2),
                "support_ref": mid_lo,
            })
            used.add(j)
            break
    return out


def _detect_bottom_reversal(df: pd.DataFrame) -> list[dict[str, Any]]:
    """恐慌放量插针 + 二次回踩阳线确认。"""
    out: list[dict[str, Any]] = []
    used: set[int] = set()
    n = len(df)
    for i in range(20, n):
        row = df.iloc[i]
        rng = float(row["candle_range"] or 0)
        if rng <= 0:
            continue
        ma = float(row.get("vol_ma20") or 0)
        if ma <= 0:
            continue
        lw = float(row["lower_wick"] or 0)
        vol_ok = float(row["volume"]) >= CLIMAX_VOL_MULT * ma
        wick_ok = lw > CLIMAX_WICK_RATIO * rng
        # 大阴线超跌也算
        bear_body = float(row["close"]) < float(row["open"]) and (
            float(row["body_top"]) - float(row["body_bottom"])
        ) > 0.5 * rng
        if not (vol_ok and (wick_ok or bear_body)):
            continue
        l1 = float(row["low"])
        climax_vol_r = float(row["volume"]) / ma
        end = min(n, i + BOTTOM_WAIT_BARS + 1)
        for j in range(i + 3, end):
            if j in used:
                continue
            r2 = df.iloc[j]
            l2 = float(r2["low"])
            if not (BOTTOM_L2_LO * l1 <= l2 <= BOTTOM_L2_HI * l1):
                continue
            rng2 = float(r2["candle_range"] or 0) + 1e-8
            close_pos = (float(r2["close"]) - float(r2["low"])) / rng2
            is_bull = float(r2["close"]) > float(r2["open"]) and close_pos >= BOTTOM_CLOSE_PCT
            # 阳包阴
            engulf = (
                float(r2["close"]) > float(r2["open"])
                and float(df.iloc[j - 1]["close"]) < float(df.iloc[j - 1]["open"])
                and float(r2["close"]) >= float(df.iloc[j - 1]["open"])
                and float(r2["open"]) <= float(df.iloc[j - 1]["close"])
            )
            if not (is_bull or engulf):
                continue
            vegas_lo = float(r2["vegas_fast_hi"]) if pd.notna(r2.get("vegas_fast_hi")) else None
            out.append({
                "kind": "bottom_secondary_test",
                "side": "bull",
                "type_label": "底部二次探底确认",
                "pattern_label": "恐慌抛售 + 阳线支撑确认 (Double Bottom)",
                "bar_index": j,
                "l1": l1,
                "l2": l2,
                "climax_vol_ratio": climax_vol_r,
                "close_pct": close_pos,
                "defense": min(l1, l2),
                "resistance_ref": vegas_lo,
                "vol_ratio": _vol_ratio(r2),
            })
            used.add(j)
            break
    return out


def _detect_spring_2b(df: pd.DataFrame) -> list[dict[str, Any]]:
    """2B / Wyckoff Spring：跌破前低后 1~3 根内放量收回。"""
    lows = [(i, float(df.iloc[i]["low"])) for i in range(len(df)) if bool(df.iloc[i]["is_swing_low"])]
    if len(lows) < 2:
        return []
    out: list[dict[str, Any]] = []
    used: set[int] = set()
    n = len(df)
    for k in range(1, len(lows)):
        i_prev, lvl = lows[k - 1]
        # 在前低之后找刺破
        for i in range(i_prev + 1, min(n, i_prev + 40)):
            if float(df.iloc[i]["low"]) >= lvl:
                continue
            # 刺破后 1~3 根收回
            for j in range(i, min(n, i + SPRING_RECLAIM_BARS + 1)):
                if j in used:
                    continue
                r = df.iloc[j]
                if float(r["close"]) <= lvl:
                    continue
                if float(r["close"]) <= float(r["open"]):
                    continue
                ma = float(r.get("vol_ma20") or 0)
                if ma > 0 and float(r["volume"]) < SPRING_VOL_MULT * ma:
                    continue
                out.append({
                    "kind": "spring_2b",
                    "side": "bull",
                    "type_label": "破底翻确认",
                    "pattern_label": "2B假突破 / Wyckoff Spring",
                    "bar_index": j,
                    "l1": lvl,
                    "l2": float(df.iloc[i]["low"]),
                    "defense": float(df.iloc[i]["low"]),
                    "resistance_ref": float(r.get("vegas_mid") or r["close"]),
                    "vol_ratio": _vol_ratio(r),
                    "close_pct": (
                        (float(r["close"]) - float(r["low"]))
                        / (float(r["candle_range"]) + 1e-8)
                    ),
                    "climax_vol_ratio": _vol_ratio(df.iloc[i]),
                })
                used.add(j)
                break
            else:
                continue
            break
    return out


def _detect_liquidity_sweep(df: pd.DataFrame) -> list[dict[str, Any]]:
    """流动性掠夺：上影刺破前高后收在前高之下。"""
    highs = [(i, float(df.iloc[i]["high"])) for i in range(len(df)) if bool(df.iloc[i]["is_swing_high"])]
    if not highs:
        return []
    out: list[dict[str, Any]] = []
    used: set[int] = set()
    n = len(df)
    for i in range(SWING_ORDER + 1, n):
        prior = [h for h in highs if h[0] < i - 1]
        if not prior:
            continue
        pi, ph = prior[-1]
        if i - pi > 25:
            continue
        row = df.iloc[i]
        rng = float(row["candle_range"] or 0)
        if rng <= 0:
            continue
        uw = float(row["upper_wick"] or 0)
        if float(row["high"]) <= ph * 1.0005:
            continue
        if float(row["close"]) >= ph:
            continue
        if float(row["close"]) >= float(row["open"]):
            continue
        if uw / rng < 0.25:
            continue
        vr = _vol_ratio(row)
        oi_on = bool(row.get("oi_anomaly")) if "oi_anomaly" in row.index else False
        if not oi_on and (vr is None or vr < 1.3):
            continue
        if i in used:
            continue
        mid = float(row["vegas_mid"]) if pd.notna(row.get("vegas_mid")) else float(row["close"])
        out.append({
            "kind": "liquidity_sweep",
            "side": "bear",
            "type_label": "顶部结构确认",
            "pattern_label": "流动性掠夺 (Liquidity Sweep / SFP)",
            "bar_index": i,
            "head_high": float(row["high"]),
            "left_shoulder": ph,
            "right_shoulder": ph,
            "neckline": ph,
            "vegas_mid": mid,
            "vol_ratio": vr,
            "defense": float(row["high"]),
            "support_ref": mid,
            "oi_anomaly": oi_on,
        })
        used.add(i)
    return out


def _detect_curvature_decay(df: pd.DataFrame) -> list[dict[str, Any]]:
    """圆弧顶/动量衰竭：近 N 根斜率由正转负且二阶为负，未破布林上轨新高。"""
    n = len(df)
    if n < CURVE_LOOKBACK + 5:
        return []
    if "bb_upper" not in df.columns:
        return []
    out: list[dict[str, Any]] = []
    closes = df["close"].astype(float).values
    x = np.arange(CURVE_LOOKBACK, dtype=float)
    x = x - x.mean()
    denom = float((x * x).sum()) or 1.0
    last_emit = -999

    def _slope(end: int) -> float:
        y = closes[end - CURVE_LOOKBACK : end]
        y = y - y.mean()
        return float((x * y).sum() / denom)

    for i in range(CURVE_LOOKBACK + 5, n):
        if i - last_emit < 15:
            continue
        s1 = _slope(i - 2)
        s0 = _slope(i)
        if not (s1 > 0.02 and s0 < -0.01 and (s0 - s1) < -0.03):
            continue
        row = df.iloc[i]
        recent_hi = float(df.iloc[i - 5 : i + 1]["high"].max())
        prev_hi = float(df.iloc[i - 15 : i - 5]["high"].max())
        if recent_hi > prev_hi * 1.001:
            continue
        if pd.isna(row.get("vegas_mid")) or float(row["close"]) >= float(row["vegas_mid"]):
            continue
        if float(row["close"]) >= float(row["open"]):
            continue
        mid = float(row["vegas_mid"])
        out.append({
            "kind": "curvature_decay",
            "side": "bear",
            "type_label": "顶部结构确认",
            "pattern_label": "圆弧顶 / 动量衰竭 (Curvature Decay)",
            "bar_index": i,
            "head_high": recent_hi,
            "left_shoulder": prev_hi,
            "right_shoulder": float(row["high"]),
            "neckline": mid,
            "vegas_mid": mid,
            "vol_ratio": _vol_ratio(row),
            "defense": recent_hi,
            "support_ref": mid,
        })
        last_emit = i
    return out
