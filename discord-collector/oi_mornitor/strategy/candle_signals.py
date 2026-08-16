"""K 线形态信号 — 对齐 tradingview-bollinger-wicks.pine。"""
from __future__ import annotations

import time
from typing import Any

import pandas as pd

from oi_mornitor.config import (
    PATTERN_WICK_RATIO,
    STRATEGY_SHOOT_WICK_MAX_RATIO,
    STRATEGY_SHOOT_WICK_RATIO,
)
from oi_mornitor.strategy.indicators import detect_inverted_hammer, detect_shooting_star

CONT_WICK_COUNT = 2
SHOOT_REPEAT_BARS = 5
VEGAS_TOL_BB_PCT = 20.0
OI_LOOKBACK = 20
OI_TRIM_HIGH = 4
OI_BAR_MULT = 2.0
OI_VOL_MULT = 1.1
OI_VOL_Z = 0.8


def _ts_sec(open_time_ms: int) -> int:
    return int(open_time_ms // 1000)


def sig_prefix(name: str, *, near_vegas: bool, oi_anomaly: bool) -> str:
    base = f"V{name}" if near_vegas else name
    return f"{base}(oi异动)" if oi_anomaly else base


def near_vegas_channel(row: pd.Series) -> bool:
    upper = float(row["bb_upper"])
    lower = float(row["bb_lower"])
    width = upper - lower
    if width <= 0 or pd.isna(width):
        return False
    tol = width * VEGAS_TOL_BB_PCT / 100.0
    h = float(row["high"])
    l = float(row["low"])
    c = float(row["close"])
    dists: list[float] = []
    for col in ("vegas_e1", "vegas_e2", "vegas_e3", "vegas_e4"):
        if col not in row.index or pd.isna(row[col]):
            continue
        e = float(row[col])
        dists.extend([abs(h - e), abs(l - e), abs(c - e)])
    if not dists:
        return False
    return min(dists) <= tol


def at_lower_band(row: pd.Series) -> bool:
    basis = float(row["bb_basis"])
    lower = float(row["bb_lower"])
    mid_to_lower = basis - lower
    zone = lower + mid_to_lower * 0.15
    return float(row["low"]) <= zone


def detect_bb_wick(row: pd.Series) -> tuple[bool, bool]:
    body = abs(float(row["close"]) - float(row["open"]))
    uw = float(row["high"]) - max(float(row["open"]), float(row["close"]))
    lw = min(float(row["open"]), float(row["close"])) - float(row["low"])
    upper = (
        float(row["high"]) > float(row["bb_upper"])
        and uw > 0
        and (body == 0 or uw / max(body, 1e-12) >= PATTERN_WICK_RATIO)
    )
    lower = (
        float(row["low"]) < float(row["bb_lower"])
        and lw > 0
        and (body == 0 or lw / max(body, 1e-12) >= PATTERN_WICK_RATIO)
    )
    return upper, lower


def _trimmed_mean_abs_prev(
    abs_bars: list[float | None],
    i: int,
    lookback: int,
    trim_high: int,
) -> float | None:
    arr: list[float] = []
    for k in range(1, lookback + 1):
        if i - k < 0:
            break
        v = abs_bars[i - k]
        if v is not None:
            arr.append(v)
    if len(arr) < 3:
        return None
    arr.sort()
    trim_n = min(trim_high, len(arr) - 1)
    keep = len(arr) - trim_n
    if keep < 1:
        return None
    return sum(arr[:keep]) / keep


PATTERN_MARKER_KINDS = frozenset({
    "shooting_star",
    "inverted_hammer",
    "continuous_upper_wick",
    "continuous_lower_wick",
    "continuous_non_upper_wick",
    "continuous_non_lower_wick",
})


def compute_oi_anomaly_flags(df: pd.DataFrame) -> tuple[list[bool], list[float | None]]:
    """返回 (异动 flags, 当根 ΔOI；无则为 None)。"""
    n = len(df)
    flags = [False] * n
    delta_signed: list[float | None] = [None] * n
    if n == 0 or "oi" not in df.columns:
        return flags, delta_signed

    delta_abs: list[float | None] = [None] * n
    oi_vals = df["oi"].tolist()
    vols = df["volume"].astype(float).tolist()

    for i in range(1, n):
        a = oi_vals[i]
        b = oi_vals[i - 1]
        if pd.isna(a) or pd.isna(b):
            continue
        a_f, b_f = float(a), float(b)
        if a_f <= 0 or b_f <= 0:
            continue
        d = a_f - b_f
        delta_signed[i] = d
        delta_abs[i] = abs(d)

    for i in range(n):
        d_abs = delta_abs[i]
        if d_abs is None:
            continue
        base = _trimmed_mean_abs_prev(delta_abs, i, OI_LOOKBACK, OI_TRIM_HIGH)
        if base is None or base <= 0 or not (d_abs > OI_BAR_MULT * base):
            continue
        if i + 1 < OI_LOOKBACK:
            continue
        window = vols[i - OI_LOOKBACK + 1 : i + 1]
        vol_sma = sum(window) / OI_LOOKBACK
        if vol_sma <= 0:
            continue
        var = sum((v - vol_sma) ** 2 for v in window) / OI_LOOKBACK
        vol_std = var**0.5
        vol = vols[i]
        vol_huge_mult = vol > vol_sma * OI_VOL_MULT
        vol_huge_z = OI_VOL_Z <= 0 or vol > vol_sma + OI_VOL_Z * vol_std
        if vol_huge_mult and vol_huge_z:
            flags[i] = True
    return flags, delta_signed


def _oi_only_label(delta: float | None) -> str:
    if delta is None:
        return "OI异动"
    if delta > 0:
        return "OI异动↑"
    if delta < 0:
        return "OI异动↓"
    return "OI异动"


def _append_marker(
    markers: list[dict[str, Any]],
    *,
    time: int,
    position: str,
    color: str,
    shape: str,
    text: str,
    price: float,
    kind: str,
    oi_anomaly: bool = False,
) -> None:
    markers.append({
        "time": time,
        "position": position,
        "color": color,
        "shape": shape,
        "text": text,
        "price": price,
        "kind": kind,
        "oi_anomaly": bool(oi_anomaly),
    })


def collect_candle_signal_markers(df: pd.DataFrame) -> list[dict[str, Any]]:
    """扫描 DataFrame（需含 bb_* / vegas_e*，可选 oi）产出 markers。

    - 形态命中且柱级 OI 异动：text 带 (oi异动)
    - 仅有 OI 异动、无形态：单独打「OI异动」标签
    """
    markers: list[dict[str, Any]] = []
    if df.empty or "bb_basis" not in df.columns:
        return markers

    oi_flags, oi_deltas = compute_oi_anomaly_flags(df)
    cont_upper = 0
    cont_lower = 0
    non_zone_upper: list[int] = []
    non_zone_lower: list[int] = []
    last_shoot_i = -1

    for i, (_, row) in enumerate(df.iterrows()):
        if pd.isna(row.get("bb_basis")) or pd.isna(row.get("bb_upper")):
            continue
        width = float(row["bb_upper"]) - float(row["bb_lower"])
        if width <= 0:
            continue

        near_v = near_vegas_channel(row)
        oi_on = bool(oi_flags[i]) if i < len(oi_flags) else False
        oi_delta = oi_deltas[i] if i < len(oi_deltas) else None
        t = _ts_sec(int(row["open_time"]))
        h = float(row["high"])
        l = float(row["low"])
        o = float(row["open"])
        c = float(row["close"])
        body = abs(c - o)
        uw = h - max(o, c)
        lw = min(o, c) - l
        basis = float(row["bb_basis"])
        upper = float(row["bb_upper"])
        lower = float(row["bb_lower"])
        pattern_hit = False
        before_n = len(markers)

        mid_to_upper = upper - basis
        upper_zone = basis + mid_to_upper * 0.85
        in_upper = h >= upper_zone
        valid_upper = in_upper and uw > body and uw > 0
        if valid_upper:
            cont_upper += 1
            if cont_upper == CONT_WICK_COUNT:
                _append_marker(
                    markers,
                    time=t,
                    position="aboveBar",
                    color="#9c27b0",
                    shape="arrowDown",
                    text=sig_prefix("连续上插针", near_vegas=near_v, oi_anomaly=oi_on),
                    price=h,
                    kind="continuous_upper_wick",
                    oi_anomaly=oi_on,
                )
        else:
            cont_upper = 0

        mid_to_lower = basis - lower
        lower_zone = lower + mid_to_lower * 0.15
        in_lower = l <= lower_zone
        valid_lower = in_lower and lw > body and lw > 0
        if valid_lower:
            cont_lower += 1
            if cont_lower == CONT_WICK_COUNT:
                _append_marker(
                    markers,
                    time=t,
                    position="belowBar",
                    color="#9c27b0",
                    shape="arrowUp",
                    text=sig_prefix("连续下插针", near_vegas=near_v, oi_anomaly=oi_on),
                    price=l,
                    kind="continuous_lower_wick",
                    oi_anomaly=oi_on,
                )
        else:
            cont_lower = 0

        bb_up, bb_lo = detect_bb_wick(row)
        if bb_up and not in_upper:
            non_zone_upper.append(i)
            if len(non_zone_upper) > 20:
                non_zone_upper.pop(0)
            if len(non_zone_upper) >= 3:
                recent = 1
                last = i
                for k in range(len(non_zone_upper) - 2, -1, -1):
                    wb = non_zone_upper[k]
                    gap = last - wb - 1
                    if gap <= 2:
                        recent += 1
                        last = wb
                    else:
                        break
                if recent >= 3:
                    _append_marker(
                        markers,
                        time=t,
                        position="aboveBar",
                        color="#7b1fa2",
                        shape="arrowDown",
                        text=sig_prefix(
                            "非上轨连续上插针", near_vegas=near_v, oi_anomaly=oi_on
                        ),
                        price=h,
                        kind="continuous_non_upper_wick",
                        oi_anomaly=oi_on,
                    )
        if bb_lo and not in_lower:
            non_zone_lower.append(i)
            if len(non_zone_lower) > 20:
                non_zone_lower.pop(0)
            if len(non_zone_lower) >= 3:
                recent = 1
                last = i
                for k in range(len(non_zone_lower) - 2, -1, -1):
                    wb = non_zone_lower[k]
                    gap = last - wb - 1
                    if gap <= 2:
                        recent += 1
                        last = wb
                    else:
                        break
                if recent >= 3:
                    _append_marker(
                        markers,
                        time=t,
                        position="belowBar",
                        color="#7b1fa2",
                        shape="arrowUp",
                        text=sig_prefix(
                            "非下轨连续下插针", near_vegas=near_v, oi_anomaly=oi_on
                        ),
                        price=l,
                        kind="continuous_non_lower_wick",
                        oi_anomaly=oi_on,
                    )

        at_lo = at_lower_band(row)
        shoot = detect_shooting_star(
            row,
            at_lower=at_lo,
            wick_ratio=STRATEGY_SHOOT_WICK_RATIO,
            max_ratio=STRATEGY_SHOOT_WICK_MAX_RATIO,
        )
        if shoot:
            is_second = (
                last_shoot_i >= 0
                and i > last_shoot_i
                and i - last_shoot_i <= SHOOT_REPEAT_BARS
            )
            name = "射击之星（2）" if is_second else "射击之星"
            _append_marker(
                markers,
                time=t,
                position="aboveBar",
                color="#ff4081",
                shape="arrowDown",
                text=sig_prefix(name, near_vegas=near_v, oi_anomaly=oi_on),
                price=h,
                kind="shooting_star",
                oi_anomaly=oi_on,
            )
            last_shoot_i = i
            pattern_hit = True
        else:
            below_mid = l <= basis
            if below_mid and detect_inverted_hammer(
                row, wick_ratio=STRATEGY_SHOOT_WICK_RATIO
            ):
                _append_marker(
                    markers,
                    time=t,
                    position="belowBar",
                    color="#00bcd4",
                    shape="arrowUp",
                    text=sig_prefix("倒锤子", near_vegas=near_v, oi_anomaly=oi_on),
                    price=l,
                    kind="inverted_hammer",
                    oi_anomaly=oi_on,
                )

        if len(markers) > before_n:
            pattern_hit = True

        # 仅有 OI 异动、无 K 线形态：仍以标签标出
        if oi_on and not pattern_hit:
            up = oi_delta is not None and oi_delta > 0
            _append_marker(
                markers,
                time=t,
                position="aboveBar" if up or oi_delta is None else "belowBar",
                color="#ff9800",
                shape="circle",
                text=_oi_only_label(oi_delta),
                price=h if up or oi_delta is None else l,
                kind="oi_anomaly",
                oi_anomaly=True,
            )

    return markers


def find_last_closed_pattern_oi_combos(
    df: pd.DataFrame,
    *,
    now_ms: int | None = None,
) -> list[dict[str, Any]]:
    """最近一根已收盘 K 上「形态 ∩ OI异动」→ 短线推荐信号。"""
    if df.empty or "open_time" not in df.columns:
        return []
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    # 未收盘柱（close_time 在未来）跳过，取上一根
    idx = len(df) - 1
    if "close_time" in df.columns:
        try:
            ct = int(df.iloc[idx]["close_time"])
            if ct > now and idx > 0:
                idx -= 1
        except (TypeError, ValueError):
            pass
    closed_ts = _ts_sec(int(df.iloc[idx]["open_time"]))
    markers = collect_candle_signal_markers(df)
    combos: list[dict[str, Any]] = []
    for m in markers:
        if int(m.get("time") or 0) != closed_ts:
            continue
        kind = str(m.get("kind") or "")
        if kind not in PATTERN_MARKER_KINDS:
            continue
        if not m.get("oi_anomaly"):
            continue
        combos.append({
            "time": closed_ts,
            "kind": kind,
            "text": str(m.get("text") or kind),
            "price": float(m.get("price") or 0),
            "position": str(m.get("position") or ""),
        })
    return combos
