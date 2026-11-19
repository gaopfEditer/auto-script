"""量价级联 + 多周期放量插针/父形态 — 与前端 vpCascade / mtfVolPatternReinforce 对齐（回测用）。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
import pandas as pd

from oi_mornitor.range_extreme_volume import range_extreme_signal_series
from oi_mornitor.td_sequential import is_td9_oversold, is_td9_overbought, td_setup_series
from oi_mornitor.volume_price.features import DEFAULT_WINDOW

VP_FEATURE_WINDOW = DEFAULT_WINDOW
VOL_SPIKE_Z_MIN = 1.0
VOL_SPIKE_MA_MULT = 1.38
CHASE_AFTER_SPIKE_MAX = 3
CHASE_EFF_MIN = 0.45
CHASE_VOL_MA_MULT = 0.85
CHASE_PIN_EFF_MAX = 0.38
CHASE_MAX_WICK_BODY = 1.15
CHILD_VOL_MA_RELAX = 0.82
WATCH_BARS_1H_15M = 16
WARMUP_BARS_1H_15M = 4
PARENT_BAR_MS = 3_600_000
CHILD_BAR_MS = 900_000

VOL_PIN_MA_MULT = 1.5
VOL_PIN_MEGA_MA_MULT = 2.5
VOL_CLIMAX_Z_MIN = 2.2
VOL_CLIMAX_MA_MULT = 2.0
VOL_CLIMAX_MA_HARD = 3.5

SHOOT_WICK_RATIO = 1.5
SHOOT_WICK_MAX = 20
# 宽口径影线（非官方射星/倒锤时）：主导影线 >= 1.05×实体 且 >= 32% 振幅
LOOSE_PIN_WICK_BODY = 1.05
LOOSE_PIN_WICK_RANGE = 0.32

REVERSAL_LABEL_RANK = {"射星": 5, "倒锤": 5, "新低弱放量": 4, "新高弱放量": 4, "TD9": 1}


@dataclass
class VpMtfSignal:
    kind: str
    label: str
    side: Literal["long", "short"]
    bar_index_15m: int
    signal_ts_ms: int


def _vol_feats(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    vol = out["volume"].astype(float)
    ma = vol.rolling(VP_FEATURE_WINDOW, min_periods=VP_FEATURE_WINDOW).mean()
    std = vol.rolling(VP_FEATURE_WINDOW, min_periods=VP_FEATURE_WINDOW).std(ddof=0)
    out["vol_ma"] = ma
    out["vol_z"] = (vol - ma) / std.replace(0, np.nan)
    body = out["close"] - out["open"]
    rng = (out["high"] - out["low"]).clip(lower=0)
    out["body_sign"] = np.sign(body).astype(int)
    out["efficiency"] = body.abs() / rng.replace(0, np.nan)
    return out


def detect_shooting_star(row: pd.Series, *, at_lower: bool = False) -> bool:
    o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
    body = abs(c - o)
    uw = h - max(o, c)
    lw = min(o, c) - l
    if body <= 0 or uw <= 0:
        return False
    if uw < body * SHOOT_WICK_RATIO or uw > body * SHOOT_WICK_MAX:
        return False
    if lw > 0 and lw * 2 >= uw:
        return False
    if at_lower and c >= o:
        return False
    return True


def detect_inverted_hammer(row: pd.Series) -> bool:
    o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
    body = abs(c - o)
    lw = min(o, c) - l
    uw = h - max(o, c)
    if body <= 0 or lw <= 0:
        return False
    if lw < body * SHOOT_WICK_RATIO or lw > body * SHOOT_WICK_MAX:
        return False
    if uw > 0 and uw * 2 >= lw:
        return False
    return True


def _pin_side(row: pd.Series) -> Literal["short", "long"] | None:
    if detect_shooting_star(row, at_lower=False):
        return "short"
    if detect_inverted_hammer(row):
        return "long"
    o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
    body = abs(c - o)
    rng = max(0.0, h - l)
    if rng <= 0 or body <= 0:
        return None
    upper = h - max(o, c)
    lower = min(o, c) - l
    if upper >= body * LOOSE_PIN_WICK_BODY and upper >= rng * LOOSE_PIN_WICK_RANGE:
        return "short"
    if lower >= body * LOOSE_PIN_WICK_BODY and lower >= rng * LOOSE_PIN_WICK_RANGE:
        return "long"
    return None


def pin_side(row: pd.Series) -> Literal["short", "long"] | None:
    """主导影线方向：射击之星/倒锤子，否则宽口径上/下影。5m 放量影线与研究应复用此函数。"""
    return _pin_side(row)


def vol_pin_spike(vol: float, vol_ma: float) -> bool:
    return vol_ma > 0 and vol >= VOL_PIN_MA_MULT * vol_ma


def vol_climax(vol: float, vol_ma: float, vol_z: float | None) -> bool:
    if not vol_pin_spike(vol, vol_ma):
        return False
    if vol >= VOL_CLIMAX_MA_HARD * vol_ma:
        return True
    return vol_z is not None and vol_z >= VOL_CLIMAX_Z_MIN and vol >= VOL_CLIMAX_MA_MULT * vol_ma


def _vol_climax_side(row: pd.Series) -> Literal["short", "long"] | None:
    pin = _pin_side(row)
    if pin:
        return pin
    o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
    rng = max(0.0, h - l)
    if rng <= 0:
        return None
    upper = h - max(o, c)
    lower = min(o, c) - l
    if upper > lower * 1.08 and upper >= rng * 0.22:
        return "short"
    if lower > upper * 1.08 and lower >= rng * 0.22:
        return "long"
    body = c - o
    if body < 0:
        return "short"
    if body > 0:
        return "long"
    return None


def child_vol_pin_at(row: pd.Series) -> Literal["short", "long"] | None:
    vol = float(row["volume"])
    vol_ma = float(row.get("vol_ma") or 0)
    vol_z = row.get("vol_z")
    vz = float(vol_z) if vol_z is not None and not (isinstance(vol_z, float) and np.isnan(vol_z)) else None
    pin = _pin_side(row)
    if vol_pin_spike(vol, vol_ma) and pin:
        return pin
    if vol_climax(vol, vol_ma, vz):
        return _vol_climax_side(row)
    return None


def _vol_pin_label(vol: float, vol_ma: float) -> str:
    if vol_ma > 0 and vol >= VOL_PIN_MEGA_MA_MULT * vol_ma:
        return "放量插针（巨）"
    return "放量插针"


def _is_volume_spike(row: pd.Series) -> bool:
    vol = float(row["volume"])
    vol_ma = float(row.get("vol_ma") or 0)
    vol_z = row.get("vol_z")
    if vol_ma <= 0 or vol_z is None or (isinstance(vol_z, float) and np.isnan(vol_z)):
        return False
    return float(vol_z) >= VOL_SPIKE_Z_MIN and vol >= VOL_SPIKE_MA_MULT * vol_ma


def _is_pin_like_chase(row: pd.Series) -> bool:
    eff = row.get("efficiency")
    if eff is not None and not (isinstance(eff, float) and np.isnan(eff)) and float(eff) <= CHASE_PIN_EFF_MAX:
        return True
    if detect_shooting_star(row) or detect_inverted_hammer(row):
        return True
    o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
    body = abs(c - o)
    rng = max(0.0, h - l)
    if rng <= 0:
        return True
    upper = h - max(o, c)
    lower = min(o, c) - l
    dom = max(upper, lower)
    if eff is not None and not np.isnan(eff) and float(eff) <= CHASE_PIN_EFF_MAX:
        return True
    if body <= rng * 0.12 and dom / rng > 0.45:
        return True
    if body > 0 and dom >= body * CHASE_MAX_WICK_BODY:
        return True
    return False


def _chase_side(df: pd.DataFrame, i: int) -> Literal["buy", "sell"] | None:
    row = df.iloc[i]
    vol = float(row["volume"])
    vol_ma = float(row.get("vol_ma") or 0)
    eff = row.get("efficiency")
    if vol_ma <= 0 or eff is None or np.isnan(eff) or float(eff) < CHASE_EFF_MIN:
        return None
    if _is_pin_like_chase(row):
        return None
    if vol < CHASE_VOL_MA_MULT * vol_ma:
        return None
    prev_close = float(df.iloc[i - 1]["close"]) if i > 0 else float(row["open"])
    o, c = float(row["open"]), float(row["close"])
    price_up = c > o and c >= prev_close
    price_down = c < o and c <= prev_close
    bs = int(row.get("body_sign") or 0)
    if bs == 1 and price_up:
        return "buy"
    if bs == -1 and price_down:
        return "sell"
    return None


def _detect_vp_chases(df_1h: pd.DataFrame) -> list[dict]:
    through = len(df_1h) - 2
    if through < VP_FEATURE_WINDOW:
        return []
    spikes = {i for i in range(VP_FEATURE_WINDOW - 1, through + 1) if _is_volume_spike(df_1h.iloc[i])}
    hits: list[dict] = []
    used: set[int] = set()
    for sp in sorted(spikes):
        for gap in range(0, CHASE_AFTER_SPIKE_MAX + 1):
            i = sp + gap
            if i > through or i in used:
                continue
            if gap == 0 and _is_pin_like_chase(df_1h.iloc[i]):
                continue
            side = _chase_side(df_1h, i)
            if not side:
                continue
            open_sec = int(df_1h.iloc[i]["open_time"] // 1000)
            observe_close_sec = open_sec + PARENT_BAR_MS // 1000
            hits.append({"side": side, "observe_close_sec": observe_close_sec})
            used.add(i)
            break
    return hits


def _child_reversal(
    df_15: pd.DataFrame,
    i: int,
    td: list[int],
    rev: list[int],
    chase_side: Literal["buy", "sell"],
) -> tuple[str, Literal["short", "long"]] | None:
    row = df_15.iloc[i]
    vol = float(row["volume"])
    vol_ma = float(row.get("vol_ma") or 0)
    if vol_ma > 0 and vol < CHILD_VOL_MA_RELAX * vol_ma:
        return None
    if chase_side == "buy":
        if detect_shooting_star(row):
            return "射星", "short"
        if is_td9_overbought(td[i]):
            return "TD9", "short"
        if rev[i] == -1:
            return "新高弱放量", "short"
        return None
    if detect_inverted_hammer(row):
        return "倒锤", "long"
    if is_td9_oversold(td[i]):
        return "TD9", "long"
    if rev[i] == 1:
        return "新低弱放量", "long"
    return None


def _pick_cascade_entry(
    df_15: pd.DataFrame,
    td: list[int],
    rev: list[int],
    chase: dict,
) -> tuple[int, str, Literal["long", "short"]] | None:
    win_start = chase["observe_close_sec"]
    watch_sec = WATCH_BARS_1H_15M * (CHILD_BAR_MS // 1000)
    win_end = win_start + watch_sec
    times = (df_15["open_time"] // 1000).astype(int).tolist()
    through = len(df_15) - 2
    ptr = 0
    while ptr < len(times) and times[ptr] < win_start:
        ptr += 1
    entry_start = win_start
    skipped = 0
    idx = ptr
    while idx < len(times) and skipped < WARMUP_BARS_1H_15M:
        if times[idx] >= win_start:
            skipped += 1
        idx += 1
    if idx < len(times):
        entry_start = times[idx]

    best: tuple[int, str, Literal["long", "short"], int] | None = None
    for j in range(ptr, through + 1):
        t = times[j]
        if t < entry_start:
            continue
        if t > win_end:
            break
        hit = _child_reversal(df_15, j, td, rev, chase["side"])
        if not hit:
            continue
        lbl, side = hit
        rank = REVERSAL_LABEL_RANK.get(lbl, 0)
        if best is None or rank > best[3] or (rank == best[3] and t > times[best[0]]):
            best = (j, lbl, side, rank)
    if not best:
        return None
    return best[0], best[1], best[2]


def scan_vp_cascade_1h_15m(df_15: pd.DataFrame, df_1h: pd.DataFrame) -> list[VpMtfSignal]:
    df_15 = _vol_feats(df_15.reset_index(drop=True))
    df_1h = _vol_feats(df_1h.reset_index(drop=True))
    closes = df_15["close"].astype(float).tolist()
    td = td_setup_series(closes)
    rev = range_extreme_signal_series(
        df_15["high"].astype(float).tolist(),
        df_15["low"].astype(float).tolist(),
        df_15["open"].astype(float).tolist(),
        closes,
        df_15["volume"].astype(float).tolist(),
    )
    out: list[VpMtfSignal] = []
    for chase in _detect_vp_chases(df_1h):
        picked = _pick_cascade_entry(df_15, td, rev, chase)
        if not picked:
            continue
        j, trig, side = picked
        leg = "跌" if chase["side"] == "sell" else "涨"
        base = f"1h{leg}15m入"
        label = f"{base}·{trig}" if trig else base
        kind = "vp_cascade_long" if side == "long" else "vp_cascade_short"
        out.append(
            VpMtfSignal(
                kind=kind,
                label=label,
                side=side,
                bar_index_15m=j,
                signal_ts_ms=int(df_15.iloc[j]["open_time"]),
            )
        )
    return out


def scan_mtf_vol_pin_parent_pattern(df_15: pd.DataFrame, df_1h: pd.DataFrame) -> list[VpMtfSignal]:
    df_15 = _vol_feats(df_15.reset_index(drop=True))
    df_1h = _vol_feats(df_1h.reset_index(drop=True))
    through_1h = len(df_1h) - 2
    through_15 = len(df_15) - 2
    times_15 = (df_15["open_time"] // 1000).astype(int).tolist()
    out: list[VpMtfSignal] = []

    for i in range(VP_FEATURE_WINDOW - 1, through_1h + 1):
        pr = df_1h.iloc[i]
        p_vol = float(pr["volume"])
        p_ma = float(pr.get("vol_ma") or 0)
        if not vol_pin_spike(p_vol, p_ma):
            continue
        if detect_shooting_star(pr):
            p_side: Literal["short", "long"] = "short"
            parent_pat = "1h射击之星"
        elif detect_inverted_hammer(pr):
            p_side = "long"
            parent_pat = "1h倒锤子"
        else:
            continue

        win_start = int(pr["open_time"] // 1000)
        win_end = win_start + PARENT_BAR_MS // 1000
        child_j = -1
        child_side: Literal["short", "long"] | None = None
        vol_lbl = ""
        for j in range(VP_FEATURE_WINDOW - 1, through_15 + 1):
            t = times_15[j]
            if t < win_start:
                continue
            if t >= win_end:
                break
            side = child_vol_pin_at(df_15.iloc[j])
            if side != p_side:
                continue
            child_j = j
            child_side = side
            vol_lbl = _vol_pin_label(float(df_15.iloc[j]["volume"]), float(df_15.iloc[j].get("vol_ma") or 0))
            break

        if child_j < 0 or child_side is None:
            continue
        kind = "mtf_vol_pin_short" if child_side == "short" else "mtf_vol_pin_long"
        label = f"{vol_lbl}+{parent_pat}"
        out.append(
            VpMtfSignal(
                kind=kind,
                label=label,
                side=child_side,
                bar_index_15m=child_j,
                signal_ts_ms=int(df_15.iloc[child_j]["open_time"]),
            )
        )
    return out


def scan_all_vp_mtf(df_15: pd.DataFrame, df_1h: pd.DataFrame) -> list[VpMtfSignal]:
    cascade = scan_vp_cascade_1h_15m(df_15, df_1h)
    mtf = scan_mtf_vol_pin_parent_pattern(df_15, df_1h)
    return cascade + mtf