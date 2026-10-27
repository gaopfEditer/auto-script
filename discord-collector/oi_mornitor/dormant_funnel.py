"""沉寂 → 试盘 → 突破点火：三阶段漏斗 + 打分（1h K 线 + OI）。"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from oi_mornitor.dormant_ignition_config import (
    FUNNEL_ATR_RATIO_MAX,
    FUNNEL_BB_WIDTH_MAX,
    FUNNEL_FUNDING_HIGH_PCT,
    FUNNEL_OI_MA72_MULT,
    FUNNEL_TEST_VOL_MULT,
    FUNNEL_VOL168_VS720,
    FUNNEL_VOL5_VS20,
    FUNNEL_VOL_BAR_MULT,
)
from oi_mornitor.pattern_detector import enrich_indicators


def _ensure_columns(df: pd.DataFrame) -> pd.DataFrame:
    work = enrich_indicators(df.copy())
    work["vol_ma5"] = work["volume"].rolling(5, min_periods=5).mean()
    work["vol_ma20"] = work["volume"].rolling(20, min_periods=20).mean()
    work["vol_ma168"] = work["volume"].rolling(168, min_periods=80).mean()
    work["vol_ma720"] = work["volume"].rolling(720, min_periods=168).mean()
    work["ema99"] = work["close"].ewm(span=99, adjust=False).mean()
    work["ema144"] = work["close"].ewm(span=144, adjust=False).mean()

    hi, lo, prev_c = work["high"], work["low"], work["close"].shift(1)
    tr = pd.concat([(hi - lo), (hi - prev_c).abs(), (lo - prev_c).abs()], axis=1).max(axis=1)
    work["atr14"] = tr.rolling(14, min_periods=14).mean()
    work["atr_ratio"] = work["atr14"] / work["close"].replace(0, np.nan)

    mid = work["bb_basis"]
    work["bb_width"] = (work["bb_upper"] - work["bb_lower"]) / mid.replace(0, np.nan)

    if "open_interest" not in work.columns:
        work["open_interest"] = np.nan
    work["oi_ma72"] = work["open_interest"].rolling(72, min_periods=36).mean()
    return work


def _phase1_dormant(work: pd.DataFrame) -> tuple[bool, int, dict[str, Any]]:
    """阶段 1：地量 + 波动收敛 + 大均线下方横盘。"""
    n = len(work)
    if n < 200:
        return False, 0, {"reason": "K线不足"}

    curr = work.iloc[-1]
    # 考察 -168 ~ -24（约 7 天前至 1 天前）
    past = work.iloc[-168:-24] if n >= 192 else work.iloc[-120:-12]
    if past.empty:
        return False, 0, {}

    vol_ma720 = float(curr["vol_ma720"]) if pd.notna(curr["vol_ma720"]) else float(
        work["volume"].tail(min(720, n)).mean()
    )
    vol_ma168 = float(past["volume"].mean())
    cond_a = vol_ma720 > 0 and vol_ma168 < vol_ma720 * FUNNEL_VOL168_VS720

    atr_mean = float(past["atr_ratio"].mean()) if past["atr_ratio"].notna().any() else 1.0
    bb_mean = float(past["bb_width"].mean()) if past["bb_width"].notna().any() else 1.0
    cond_b = atr_mean < FUNNEL_ATR_RATIO_MAX or bb_mean < FUNNEL_BB_WIDTH_MAX

    ema99 = float(curr["ema99"]) if pd.notna(curr["ema99"]) else None
    ema144 = float(curr["ema144"]) if pd.notna(curr["ema144"]) else None
    close_now = float(curr["close"])
    under_long_ma = (
        (ema99 and close_now < ema99 * 1.02)
        or (ema144 and close_now < ema144 * 1.02)
    )
    if ema99 and len(past) >= 48:
        slope = float(past["close"].iloc[-1] - past["close"].iloc[0]) / max(
            float(past["close"].iloc[0]), 1e-9
        )
        flat = abs(slope) < 0.08
    else:
        flat = True
    cond_c = under_long_ma and flat

    ok = cond_a and cond_b and cond_c
    score = 0
    if cond_a:
        score += 15
    if cond_b:
        score += 15
    if cond_c:
        score += 10
    return ok, score, {
        "vol168_vs720": round(vol_ma168 / vol_ma720, 3) if vol_ma720 else None,
        "atr_ratio_mean": round(atr_mean, 4),
        "bb_width_mean": round(bb_mean, 4),
        "under_long_ma": under_long_ma,
        "flat": flat,
    }


def _phase2_test(work: pd.DataFrame) -> tuple[bool, int, dict[str, Any]]:
    """阶段 2：3~10 天前试盘放量且未深破。"""
    n = len(work)
    if n < 120:
        return False, 0, {}

    test_window = work.iloc[-240:-6] if n >= 246 else work.iloc[-168:-6]
    if test_window.empty:
        return False, 0, {}

    has_test = False
    spike_idx = None
    for idx in test_window.index:
        row = work.loc[idx]
        vma20 = row["vol_ma20"]
        if pd.isna(vma20) or float(vma20) <= 0:
            continue
        if float(row["volume"]) >= float(vma20) * FUNNEL_TEST_VOL_MULT:
            spike_idx = idx
            base_low = min(float(row["open"]), float(row["low"]))
            after = work.loc[idx:]
            if len(after) > 1:
                min_after = float(after.iloc[1:]["low"].min())
                if min_after >= base_low * 0.98:
                    has_test = True
                    break

    score = 30 if has_test else 0
    detail: dict[str, Any] = {"has_test_volume": has_test}
    if spike_idx is not None:
        detail["test_bar_time"] = int(work.loc[spike_idx, "open_time"])
    return has_test, score, detail


def _phase3_ignition(
    work: pd.DataFrame,
    *,
    has_test: bool,
    funding_rate_pct: float | None = None,
) -> tuple[bool, int, str, dict[str, Any]]:
    """阶段 3：突破 + 量能 + OI。"""
    n = len(work)
    if n < 80:
        return False, 0, "LOW", {}

    curr = work.iloc[-1]
    close = float(curr["close"])
    recent = work.iloc[-72:-1] if n >= 73 else work.iloc[:-1]
    box_high = float(recent["close"].max()) if len(recent) else close
    ema99 = float(curr["ema99"]) if pd.notna(curr["ema99"]) else 0.0
    ema144 = float(curr["ema144"]) if pd.notna(curr["ema144"]) else 0.0
    price_break = close > box_high and (close > ema99 or close > ema144)

    vma5 = float(curr["vol_ma5"]) if pd.notna(curr["vol_ma5"]) else 0.0
    vma20 = float(curr["vol_ma20"]) if pd.notna(curr["vol_ma20"]) else 0.0
    vol = float(curr["volume"])
    vol_ok = False
    if vma20 > 0:
        vol_ok = vma5 > vma20 * FUNNEL_VOL5_VS20 or vol > vma20 * FUNNEL_VOL_BAR_MULT

    oi_now = float(curr["open_interest"]) if pd.notna(curr["open_interest"]) else None
    oi_ma72 = float(curr["oi_ma72"]) if pd.notna(curr["oi_ma72"]) else None
    oi_ok = (
        oi_now is not None
        and oi_ma72 is not None
        and oi_ma72 > 0
        and oi_now > oi_ma72 * FUNNEL_OI_MA72_MULT
    )

    ok = price_break and vol_ok and oi_ok
    score = 0
    if price_break:
        score += 12
    if vol_ok:
        score += 10
    if oi_ok:
        score += 8

    confidence = "LOW"
    if ok:
        confidence = "HIGH" if has_test else "MEDIUM"
        if funding_rate_pct is not None and funding_rate_pct < FUNNEL_FUNDING_HIGH_PCT:
            confidence = "HIGH"

    metrics = {
        "close": close,
        "box_high": box_high,
        "vol_ratio": round(vol / vma20, 2) if vma20 > 0 else None,
        "oi_bias_pct": round((oi_now - oi_ma72) / oi_ma72 * 100, 2)
        if oi_now is not None and oi_ma72 and oi_ma72 > 0
        else None,
        "funding_rate_pct": funding_rate_pct,
        "has_previous_test": has_test,
    }
    return ok, score, confidence, metrics


def evaluate_dormant_funnel_df(
    df: pd.DataFrame,
    *,
    funding_rate_pct: float | None = None,
) -> dict[str, Any]:
    if df is None or df.empty or len(df) < 300:
        return {
            "stage": "NONE",
            "signal": False,
            "phase1": False,
            "phase2": False,
            "score": 0,
            "confidence": "LOW",
            "reason": "数据长度不足",
        }

    work = _ensure_columns(df)
    p1, s1, d1 = _phase1_dormant(work)
    p2, s2, d2 = _phase2_test(work)
    p3, s3, conf, d3 = _phase3_ignition(work, has_test=p2, funding_rate_pct=funding_rate_pct)

    score = min(100, s1 + s2 + (s3 if p3 else 0))
    if p3:
        stage = "IGNITION"
    elif p1 and p2:
        stage = "CANDIDATE"
    elif p1:
        stage = "DORMANT"
    else:
        stage = "NONE"

    out: dict[str, Any] = {
        "stage": stage,
        "signal": p3,
        "phase1": p1,
        "phase2": p2,
        "score": score,
        "confidence": conf if p3 else ("MEDIUM" if p1 and p2 else "LOW"),
        "detail": {**d1, **d2, **d3},
    }
    if not p3 and stage == "NONE":
        out["reason"] = "未满足沉寂/试盘条件"
    return out
