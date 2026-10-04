"""顶部/底部结构识别 — 头肩+Vegas、二次探底、2B Spring、流动性掠夺。

不依赖 scipy：局部高低点用滚动窗口实现。
输入 DataFrame 需含 open/high/low/close/volume；建议先经 enrich_indicators。
"""
from __future__ import annotations

import logging
from typing import Any, Callable

import numpy as np
import pandas as pd

from oi_mornitor.config import (
    STRUCTURE_BREAK_VOL_MULT,
    STRUCTURE_CURVE_DECEL,
    STRUCTURE_CURVE_DOWN_SLOPE,
    STRUCTURE_CURVE_UP_SLOPE,
)
from oi_mornitor.signal_policy import is_blocked_structure_kind
from oi_mornitor.strategy.candle_signals import closed_bar_index, compute_oi_anomaly_flags
from oi_mornitor.strategy.features import (
    apply_vegas_mid,
    confirmed_swings,
    mark_causal_swings,
)
from oi_mornitor.strategy.params import SWING_LEFT, SWING_RIGHT

logger = logging.getLogger(__name__)

# 与用户规格对齐的可调默认
SWING_ORDER = 5
HS_SHOULDER_TOL = 0.03
HS_VEGAS_SCAN_BARS = 15
HS_HEAD_MIN_ABOVE = 0.015
HS_RIGHT_SHOULDER_MAX = 0.01
HS_CLOSE_LOWER_PCT = 0.40
M_TOP_PEAK_TOL = 0.02
M_TOP_VALLEY_MAX = 0.97
M_TOP_PEAK2_VOL_MAX = 0.85
TOP_BREAK_VOL_MULT = STRUCTURE_BREAK_VOL_MULT
TOP_RISK_MAX_PCT = 0.025
TOP_PRIOR_UP_PCT = 0.04
TOP_PRIOR_LOOKBACK = 20
TOP_VEGAS_SLOPE_BARS = 5
SWEEP_PIERCE_LO = 0.001
SWEEP_PIERCE_HI = 0.012
SWEEP_CLOSE_BELOW_PH = 0.997
SWEEP_CLOSE_LOWER_PCT = 0.50
ENABLE_CURVATURE_DECAY = False
TOP_BEAR_KINDS = frozenset({
    "hs_vegas_break",
    "m_top_vegas_break",
    "liquidity_sweep",
    "curvature_decay",
})
TOP_KIND_PRIORITY = (
    "hs_vegas_break",
    "m_top_vegas_break",
    "liquidity_sweep",
    "curvature_decay",
)
STRUCTURE_CARD_INTERVALS = frozenset({"15m", "1h", "4h"})
STRUCTURE_PUSH_COOLDOWN_BARS = 8
CLIMAX_VOL_MULT = 2.0
CLIMAX_WICK_RATIO = 0.4
BOTTOM_L2_MIN_GAP = 3
BOTTOM_L2_MAX_GAP = 18
BOTTOM_L2_LO = 0.98
BOTTOM_L2_HI = 1.03
BOTTOM_L2_VOL_MAX_RATIO = 0.8
BOTTOM_L2_BODY_MAX_RATIO = 0.7
BOTTOM_CONFIRM_VOL_MULT = 1.3
BOTTOM_CLOSE_PCT = 0.70
BOTTOM_RECOVERY_CLOSE_RATIO = 0.4
BOTTOM_RISK_MAX_PCT = 0.025
BOTTOM_RR_MIN = 1.5
BOTTOM_ENGULF_BODY_RATIO = 0.8
SPRING_RECLAIM_BARS = 3
SPRING_VOL_MULT = 1.3
SWEEP_WICK_MIN_PCT = 0.25  # 上影占 range
CURVE_LOOKBACK = 20


def _ensure_structure_cols(df: pd.DataFrame) -> pd.DataFrame:
    """补齐 Vegas 中轨 / 均量 / 影线等列。vegas_mid 一律按 A 组中点覆盖。"""
    out = apply_vegas_mid(df)

    vol_src = out["vol_sma20"] if "vol_sma20" in out.columns else out["volume"].rolling(20).mean()
    if "vol_ma20" not in out.columns:
        out["vol_ma20"] = vol_src.astype(float)

    body_bottom = out[["open", "close"]].min(axis=1)
    body_top = out[["open", "close"]].max(axis=1)
    if "body_bottom" not in out.columns:
        out["body_bottom"] = body_bottom
    if "body_top" not in out.columns:
        out["body_top"] = body_top
    if "lower_wick" not in out.columns:
        out["lower_wick"] = body_bottom - out["low"]
    if "upper_wick" not in out.columns:
        out["upper_wick"] = out["high"] - body_top
    if "candle_range" not in out.columns:
        out["candle_range"] = (out["high"] - out["low"]).clip(lower=0)
    return out


def mark_swing_points(
    df: pd.DataFrame,
    *,
    order: int = SWING_ORDER,
    left: int | None = None,
    right: int | None = None,
) -> pd.DataFrame:
    """因果摆动点：左 left 右 right，禁止 center=True（避免前视）。

    ``order`` 仅作兼容参数；实际窗口取 ``left``/``right``（默认 5/3）。
    """
    del order  # 旧对称窗口已废弃
    return mark_causal_swings(
        df,
        left=SWING_LEFT if left is None else left,
        right=SWING_RIGHT if right is None else right,
    )


def _ts_sec(open_time_ms: int) -> int:
    return int(open_time_ms // 1000)


def _vol_ratio(row: pd.Series) -> float | None:
    v = float(row.get("volume") or 0)
    ma = float(row.get("vol_ma20") or row.get("vol_sma20") or 0)
    if ma <= 0:
        return None
    return v / ma


def _break_vol_ok(row: pd.Series) -> bool:
    """结构破位柱量能 ≥ STRUCTURE_BREAK_VOL_MULT × MA20（默认 1.3）。"""
    vr = _vol_ratio(row)
    return vr is not None and vr >= TOP_BREAK_VOL_MULT


def _atr_at(df: pd.DataFrame, idx: int, period: int = 14) -> float:
    if idx < 1:
        return 0.0
    start = max(1, idx - period + 1)
    trs: list[float] = []
    for i in range(start, idx + 1):
        row = df.iloc[i]
        prev = df.iloc[i - 1]
        h = float(row["high"])
        l = float(row["low"])
        pc = float(prev["close"])
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if not trs:
        return 0.0
    return sum(trs) / len(trs)


def _top_break_quality_ok(df: pd.DataFrame, j: int, mid: float) -> bool:
    """破位质量：跌破幅度 ≥ 0.6×ATR，或已连续 2 根收在中轨下。"""
    if j < 0 or j >= len(df):
        return False
    close_j = float(df.iloc[j]["close"])
    if close_j >= mid:
        return False
    depth = mid - close_j
    atr = _atr_at(df, j)
    if atr > 0 and depth >= 0.6 * atr:
        return True
    streak = 1
    for k in range(j - 1, max(-1, j - 3), -1):
        if float(df.iloc[k]["close"]) < mid:
            streak += 1
        else:
            break
    return streak >= 2


def _candle_body(row: pd.Series) -> float:
    return max(0.0, float(row["body_top"]) - float(row["body_bottom"]))


def _oi_delta(df: pd.DataFrame, idx: int) -> float | None:
    if "oi" not in df.columns or idx < 1:
        return None
    cur = df.iloc[idx].get("oi")
    prev = df.iloc[idx - 1].get("oi")
    if pd.isna(cur) or pd.isna(prev):
        return None
    c, p = float(cur), float(prev)
    if c <= 0 or p <= 0:
        return None
    return c - p


def _close_pos_from_low(row: pd.Series) -> float:
    rng = float(row["candle_range"] or 0) + 1e-8
    return (float(row["close"]) - float(row["low"])) / rng


def _close_in_lower_pct(row: pd.Series, max_pct_from_low: float) -> bool:
    return _close_pos_from_low(row) <= max_pct_from_low


def _vegas_mid_slope_ok(df: pd.DataFrame, idx: int, *, lookback: int = TOP_VEGAS_SLOPE_BARS) -> bool:
    """ema144-ema169 差值的 lookback 根变化 ≤ 0（中轨走平或向下）。"""
    if idx < lookback:
        return False
    if "ema144" in df.columns and "ema169" in df.columns:
        e1 = df["ema144"].astype(float)
        e2 = df["ema169"].astype(float)
    elif "vegas_e1" in df.columns and "vegas_e2" in df.columns:
        e1 = df["vegas_e1"].astype(float)
        e2 = df["vegas_e2"].astype(float)
    else:
        return False
    spread_now = float(e1.iloc[idx] - e2.iloc[idx])
    spread_prev = float(e1.iloc[idx - lookback] - e2.iloc[idx - lookback])
    if not (np.isfinite(spread_now) and np.isfinite(spread_prev)):
        return False
    return spread_now <= spread_prev


def _top_common_ok(df: pd.DataFrame, j: int, entry: float, guard: float) -> bool:
    """顶部公共闸：收阴、中轨下、量能、先涨后跌、风险宽度。"""
    if j < TOP_PRIOR_LOOKBACK:
        return False
    row = df.iloc[j]
    close_j = float(row["close"])
    open_j = float(row["open"])
    if close_j >= open_j:
        return False
    mid = float(row["vegas_mid"]) if pd.notna(row.get("vegas_mid")) else None
    if mid is None or close_j >= mid:
        return False
    if not _vegas_mid_slope_ok(df, j):
        return False
    ma = float(row.get("vol_ma20") or 0)
    if ma <= 0 or float(row["volume"]) < TOP_BREAK_VOL_MULT * ma:
        return False
    close_ago = float(df.iloc[j - TOP_PRIOR_LOOKBACK]["close"])
    if close_ago <= 0:
        return False
    max_hi = float(df.iloc[j - TOP_PRIOR_LOOKBACK : j]["high"].max())
    if max_hi < close_ago * (1 + TOP_PRIOR_UP_PCT):
        return False
    risk = guard - entry
    if risk <= 0 or risk > entry * TOP_RISK_MAX_PCT:
        return False
    return True


def _attach_oi_anomaly(df: pd.DataFrame) -> pd.DataFrame:
    if "oi" not in df.columns:
        return df
    flags, _ = compute_oi_anomaly_flags(df)
    out = df.copy()
    out["oi_anomaly"] = flags
    return out


def _us_open_sweep_blocked(now_ms: int | None) -> bool:
    """美盘开盘前后 15 分钟（北京时间 21/22 点档）禁用 sweep。"""
    if now_ms is None:
        return False
    from datetime import datetime, timedelta, timezone

    cn = timezone(timedelta(hours=8))
    dt = datetime.fromtimestamp(now_ms / 1000, tz=cn)
    minutes = dt.hour * 60 + dt.minute
    for hour in (21, 22):
        lo = hour * 60 + 15
        hi = hour * 60 + 45
        if lo <= minutes <= hi:
            return True
    return False


def filter_structure_card_hits(
    hits: list[dict[str, Any]],
    *,
    interval: str,
    now_ms: int | None = None,
) -> list[dict[str, Any]]:
    """推送层：周期白名单 + 美盘 sweep 禁推。"""
    if interval not in STRUCTURE_CARD_INTERVALS:
        return []
    out: list[dict[str, Any]] = []
    block_sweep = _us_open_sweep_blocked(now_ms)
    for hit in hits:
        kind = str(hit.get("kind") or "")
        if is_blocked_structure_kind(kind):
            continue
        if block_sweep and kind == "liquidity_sweep":
            continue
        out.append(hit)
    return out


def _bottom_reversal_oi_ok(df: pd.DataFrame, l1_idx: int, confirm_idx: int) -> bool:
    """L1 空头加仓砸盘 + 确认柱 OI 不再增；无 OI 列时不挡。"""
    d1 = _oi_delta(df, l1_idx)
    d2 = _oi_delta(df, confirm_idx)
    if d1 is None or d2 is None:
        return True
    row_l1 = df.iloc[l1_idx]
    price_down = float(row_l1["close"]) < float(row_l1["open"])
    if not (d1 > 0 and price_down):
        return False
    return d2 <= 0


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


def _run_detector(
    name: str,
    fn: Callable[[pd.DataFrame], list[dict[str, Any]]],
    work: pd.DataFrame,
) -> list[dict[str, Any]]:
    try:
        return fn(work)
    except Exception:
        logger.exception("结构检测器 %s 失败，已隔离", name)
        return []


def detect_structure_events(df: pd.DataFrame) -> list[dict[str, Any]]:
    """全历史扫描，返回带元数据的结构事件（触发 K 位置）。

    每个检测器单独隔离异常，避免一个 NameError 吞掉全部结构信号。
    """
    if df is None or df.empty or len(df) < 40:
        return []
    work = _ensure_structure_cols(df)
    if "vegas_mid" not in work.columns:
        return []
    work = _attach_oi_anomaly(work)
    work = mark_swing_points(work, order=SWING_ORDER)
    events: list[dict[str, Any]] = []
    detectors: list[tuple[str, Callable[[pd.DataFrame], list[dict[str, Any]]]]] = [
        ("hs_vegas_break", _detect_hs_vegas),
        ("m_top_vegas_break", _detect_m_top_vegas),
        ("bottom_secondary_test", _detect_bottom_reversal),
        ("liquidity_sweep", _detect_liquidity_sweep),
    ]
    # events.extend(_detect_spring_2b(work))  # 破底翻确认：已停用
    if ENABLE_CURVATURE_DECAY:
        detectors.append(("curvature_decay", _detect_curvature_decay))
    for name, fn in detectors:
        events.extend(_run_detector(name, fn, work))
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
    row = df.iloc[idx]
    for ev in events:
        if int(ev.get("bar_index", -1)) != idx:
            continue
        kind = str(ev.get("kind") or "")
        if not kind or kind in seen:
            continue
        seen.add(kind)
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
    """头肩顶 + 右肩后跌破 Vegas 中轨（或破颈线且收在中轨下）。"""
    highs = confirmed_swings(df, len(df) - 1, which="high")
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
        for j in range(max(i3 + 1, i3 + SWING_RIGHT), end):
            if j in used_triggers:
                continue
            highs_j = [h[0] for h in confirmed_swings(df, j, which="high") if h[0] <= i3]
            if len(highs_j) < 3 or highs_j[-3:] != [i1, i2, i3]:
                continue
            row = df.iloc[j]
            prev = df.iloc[j - 1]
            mid = float(row["vegas_mid"]) if pd.notna(row["vegas_mid"]) else None
            prev_mid = float(prev["vegas_mid"]) if pd.notna(prev["vegas_mid"]) else None
            if mid is None or prev_mid is None:
                continue
            close_j = float(row["close"])
            crossed = close_j < mid and float(prev["close"]) >= prev_mid
            broke_neck = close_j < neck_price
            if not crossed and not (broke_neck and close_j < mid):
                continue
            if not _break_vol_ok(row):
                continue
            if not _top_break_quality_ok(df, j, mid):
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
    """M 顶：两高近似等高，之后实体跌破 Vegas 中轨。"""
    highs = confirmed_swings(df, len(df) - 1, which="high")
    if len(highs) < 2:
        return []
    out: list[dict[str, Any]] = []
    used: set[int] = set()
    for a in range(len(highs) - 1):
        i1, p1 = highs[a]
        i2, p2 = highs[a + 1]
        if p1 <= 0:
            continue
        if abs(p1 - p2) / p1 > HS_SHOULDER_TOL:
            continue
        if i2 - i1 < SWING_ORDER:
            continue
        mid_lo = float(df.iloc[i1:i2]["low"].min())
        if mid_lo >= min(p1, p2) * 0.985:
            continue

        end = min(len(df), i2 + 1 + HS_VEGAS_SCAN_BARS)
        for j in range(max(i2 + 1, i2 + SWING_RIGHT), end):
            if j in used:
                continue
            highs_j = [h[0] for h in confirmed_swings(df, j, which="high") if h[0] <= i2]
            if len(highs_j) < 2 or highs_j[-2:] != [i1, i2]:
                continue
            row = df.iloc[j]
            prev = df.iloc[j - 1]
            mid = float(row["vegas_mid"]) if pd.notna(row["vegas_mid"]) else None
            prev_mid = float(prev["vegas_mid"]) if pd.notna(prev["vegas_mid"]) else None
            if mid is None or prev_mid is None:
                continue
            if not (float(row["close"]) < mid and float(prev["close"]) >= prev_mid):
                continue
            if not _break_vol_ok(row):
                continue
            if not _top_break_quality_ok(df, j, mid):
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
    """恐慌放量插针 + 二次回踩阳线确认（Double Bottom）。"""
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
        bear_body = float(row["close"]) < float(row["open"]) and _candle_body(row) > 0.5 * rng
        if not (vol_ok and (wick_ok or bear_body)):
            continue
        l1 = float(row["low"])
        climax_vol_r = float(row["volume"]) / ma
        end = min(n, i + BOTTOM_L2_MAX_GAP + 1)
        for j in range(i + BOTTOM_L2_MIN_GAP, end):
            if j in used:
                continue
            r2 = df.iloc[j]
            l2 = float(r2["low"])
            if not (BOTTOM_L2_LO * l1 <= l2 <= BOTTOM_L2_HI * l1):
                continue
            rng2 = float(r2["candle_range"] or 0) + 1e-8
            close_j = float(r2["close"])
            open_j = float(r2["open"])
            close_pos = (close_j - float(r2["low"])) / rng2
            is_bull = close_j > open_j and close_pos >= BOTTOM_CLOSE_PCT
            prev = df.iloc[j - 1]
            engulf = (
                close_j > open_j
                and float(prev["close"]) < float(prev["open"])
                and close_j >= float(prev["open"])
                and open_j <= float(prev["close"])
            )
            if not (is_bull or engulf):
                continue
            vegas_hi = float(r2["vegas_fast_hi"]) if pd.notna(r2.get("vegas_fast_hi")) else None
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
                "resistance_ref": vegas_hi,
                "vol_ratio": _vol_ratio(r2),
            })
            used.add(j)
            break
    return out


def _detect_spring_2b(df: pd.DataFrame) -> list[dict[str, Any]]:
    """2B / Wyckoff Spring：跌破前低后 1~3 根内放量收回。"""
    lows = confirmed_swings(df, len(df) - 1, which="low")
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
    """流动性掠夺：浅刺前高 + 长上影收阴 + 收在前高之下。"""
    highs = confirmed_swings(df, len(df) - 1, which="high")
    if not highs:
        return []
    out: list[dict[str, Any]] = []
    used: set[int] = set()
    n = len(df)
    for i in range(SWING_ORDER + 1, n):
        prior = [h for h in highs if h[0] < i - 1 and h[0] + SWING_RIGHT <= i]
        if not prior:
            continue
        pi, ph = prior[-1]
        if i - pi > 25 or ph <= 0:
            continue
        row = df.iloc[i]
        rng = float(row["candle_range"] or 0)
        if rng <= 0:
            continue
        high_i = float(row["high"])
        close_j = float(row["close"])
        pierce_lo = ph * (1 + SWEEP_PIERCE_LO)
        pierce_hi = ph * (1 + SWEEP_PIERCE_HI)
        if not (pierce_lo < high_i <= pierce_hi):
            continue
        if close_j >= ph or close_j >= ph * SWEEP_CLOSE_BELOW_PH:
            continue
        if not _close_in_lower_pct(row, SWEEP_CLOSE_LOWER_PCT):
            continue
        uw = float(row["upper_wick"] or 0)
        if uw / rng < SWEEP_WICK_MIN_PCT:
            continue
        vr = _vol_ratio(row)
        if not _break_vol_ok(row):
            continue
        if i in used:
            continue
        mid = float(row["vegas_mid"]) if pd.notna(row.get("vegas_mid")) else float(row["close"])
        oi_on = False
        if "oi_anomaly" in row.index:
            raw_oi = row.get("oi_anomaly")
            oi_on = bool(raw_oi) if pd.notna(raw_oi) else False
        out.append({
            "kind": "liquidity_sweep",
            "side": "bear",
            "type_label": "顶部结构确认",
            "pattern_label": "流动性掠夺 (Liquidity Sweep / SFP)",
            "bar_index": i,
            "head_high": high_i,
            "left_shoulder": ph,
            "right_shoulder": ph,
            "neckline": ph,
            "vegas_mid": mid,
            "vol_ratio": vr,
            "defense": high_i,
            "support_ref": mid,
            "oi_anomaly": oi_on,
        })
        used.add(i)
    return out


def _detect_curvature_decay(df: pd.DataFrame) -> list[dict[str, Any]]:
    """圆弧顶/动量衰竭：当前 20 根斜率对比 10 根前转为下行/走平，未破布林上轨新高。

    斜率按窗口均价相对变化（%/根）归一化，避免高价主流/低价山寨尺度失衡。
    用「10 根前窗口」作对比基准：前段真实上涨 + 当前段转负 → 动量衰竭。
    """
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
        scale = float(np.mean(y)) or 1.0
        y = (y - y.mean()) / scale * 100.0  # 相对价格变化（%/根），消除币种价格尺度差异
        return float((x * y).sum() / denom)

    # 需要 i-10 ≥ CURVE_LOOKBACK（对比窗口不越界），故起点 +10
    for i in range(CURVE_LOOKBACK + 10, n):
        if i - last_emit < 15:
            continue
        s_now = _slope(i)
        s_prev = _slope(i - 10)
        if not (
            s_prev > STRUCTURE_CURVE_UP_SLOPE
            and s_now < STRUCTURE_CURVE_DOWN_SLOPE
            and (s_now - s_prev) < STRUCTURE_CURVE_DECEL
        ):
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
