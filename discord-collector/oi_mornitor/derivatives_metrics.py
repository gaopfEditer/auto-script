"""
衍生品资金面 + 多周期共振（4h / 1d），供形态图表与扫描过滤。
"""
from __future__ import annotations

import logging
from typing import Any

import aiohttp
import pandas as pd

from oi_mornitor.pattern_detector import (
    _macd_top_weak,
    enrich_indicators,
    klines_to_df,
)

logger = logging.getLogger(__name__)

SANDBOX_TREND_SLOPE_MIN = 0.002
SANDBOX_RANGE_SLOPE_MAX = 0.001

# 资金费率绝对值超过该阈值视为「过热」（8h 费率，约 0.05% = 0.0005）
FUNDING_EXTREME = 0.0005
# OI 变化率阈值（相对前一根）
OI_CHANGE_PCT_THRESHOLD = 0.015
# 价格变化率阈值（相对前一根）
PRICE_CHANGE_PCT_THRESHOLD = 0.003


async def fetch_premium_index(
    session: aiohttp.ClientSession,
    *,
    base_url: str,
    symbol: str,
) -> dict[str, Any]:
    """币安 premiumIndex → 当前资金费率与标记价。"""
    sym = symbol.strip().upper()
    url = f"{base_url.rstrip('/')}/fapi/v1/premiumIndex?symbol={sym}"
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=8)) as resp:
            if resp.status != 200:
                return {}
            data = await resp.json()
    except Exception as exc:
        logger.debug("premiumIndex 失败 %s: %s", sym, exc)
        return {}
    if not isinstance(data, dict):
        return {}
    try:
        rate = float(data.get("lastFundingRate") or 0)
        mark = float(data.get("markPrice") or 0)
    except (TypeError, ValueError):
        return {}
    return {
        "funding_rate": rate,
        "funding_rate_pct": round(rate * 100, 4),
        "mark_price": mark,
        "extreme_positive": rate >= FUNDING_EXTREME,
        "extreme_negative": rate <= -FUNDING_EXTREME,
    }


def _pct_change(cur: float, prev: float) -> float:
    if prev <= 0 or cur <= 0:
        return 0.0
    return (cur - prev) / prev


def classify_oi_price_regime(
    klines: list[list],
    oi_by_time: dict[int, float] | None,
) -> dict[str, Any]:
    """
    价 + OI 共振分类：
    - breakout：价涨 + OI 增（真突破）
    - squeeze：价涨 + OI 降（空头挤仓）
    - dump_oi_up：价跌 + OI 增（空头主动）
    - neutral
    """
    if not klines or len(klines) < 3 or not oi_by_time:
        return {"regime": "neutral", "label": "OI 数据不足", "price_chg_pct": 0.0, "oi_chg_pct": 0.0}

    df = klines_to_df(klines)
    last = df.iloc[-1]
    prev = df.iloc[-2]
    t_last = int(last["open_time"]) // 1000
    t_prev = int(prev["open_time"]) // 1000
    oi_last = oi_by_time.get(t_last)
    oi_prev = oi_by_time.get(t_prev)
    if oi_last is None or oi_prev is None or oi_prev <= 0:
        return {"regime": "neutral", "label": "OI 序列不足", "price_chg_pct": 0.0, "oi_chg_pct": 0.0}

    price_chg = _pct_change(float(last["close"]), float(prev["close"]))
    oi_chg = _pct_change(float(oi_last), float(oi_prev))
    price_up = price_chg >= PRICE_CHANGE_PCT_THRESHOLD
    price_down = price_chg <= -PRICE_CHANGE_PCT_THRESHOLD
    oi_up = oi_chg >= OI_CHANGE_PCT_THRESHOLD
    oi_down = oi_chg <= -OI_CHANGE_PCT_THRESHOLD

    if price_up and oi_up:
        return {
            "regime": "breakout",
            "label": "价涨+OI增 · 真突破",
            "price_chg_pct": round(price_chg * 100, 3),
            "oi_chg_pct": round(oi_chg * 100, 3),
        }
    if price_up and oi_down:
        return {
            "regime": "squeeze",
            "label": "价涨+OI降 · 挤空假突破",
            "price_chg_pct": round(price_chg * 100, 3),
            "oi_chg_pct": round(oi_chg * 100, 3),
        }
    if price_down and oi_up:
        return {
            "regime": "dump_oi_up",
            "label": "价跌+OI增 · 空头建仓",
            "price_chg_pct": round(price_chg * 100, 3),
            "oi_chg_pct": round(oi_chg * 100, 3),
        }
    return {
        "regime": "neutral",
        "label": "价/OI 未共振",
        "price_chg_pct": round(price_chg * 100, 3),
        "oi_chg_pct": round(oi_chg * 100, 3),
    }


def estimate_liquidation_zones(
    *,
    price: float,
    swing_high: float,
    swing_low: float,
    leverage_tiers: tuple[int, ...] = (10, 20, 50, 100),
) -> list[dict[str, Any]]:
    """
    估算清算密集区（无第三方热力图时的启发式）：
    以近期 swing 高/低为锚，按常见杠杆推算空单/多单爆仓价带。
    """
    if price <= 0:
        return []
    hi = max(swing_high, price)
    lo = min(swing_low, price) if swing_low > 0 else price * 0.95
    lines: list[dict[str, Any]] = []
    for lev in leverage_tiers:
        if lev <= 0:
            continue
        move = 1.0 / lev
        # 空单清算：价格向上扫
        short_liq = hi * (1.0 + move * 0.9)
        lines.append({
            "kind": "liq_short",
            "price": round(short_liq, 8),
            "color": "#ff6b6b",
            "title": f"空清算≈{lev}x",
            "leverage": lev,
            "side": "short",
        })
        # 多单清算：价格向下扫
        long_liq = lo * (1.0 - move * 0.9)
        if long_liq > 0:
            lines.append({
                "kind": "liq_long",
                "price": round(long_liq, 8),
                "color": "#4fc3f7",
                "title": f"多清算≈{lev}x",
                "leverage": lev,
                "side": "long",
            })
    return lines


def _enrich_mtf_df(df: pd.DataFrame) -> pd.DataFrame:
    """pattern_detector 指标 + Vegas 中轨/斜率。"""
    out = enrich_indicators(df)
    out["vegas_fast_mid"] = (out["vegas_e1"] + out["vegas_e2"]) / 2.0
    out["vegas_slow_mid"] = (out["vegas_e3"] + out["vegas_e4"]) / 2.0
    out["vegas_slow_slope"] = out["vegas_e3"].pct_change(20)
    return out


def _vegas_direction(df: pd.DataFrame) -> str:
    if len(df) < 30:
        return "FLAT"
    last = df.iloc[-1]
    if pd.isna(last.get("vegas_fast_mid")) or pd.isna(last.get("vegas_slow_mid")):
        return "FLAT"
    fast = float(last["vegas_fast_mid"])
    slow = float(last["vegas_slow_mid"])
    close = float(last["close"])
    if fast <= 0 or slow <= 0 or close <= 0:
        return "FLAT"
    tol = close * 1e-4
    if fast > slow + tol:
        return "UP"
    if fast < slow - tol:
        return "DOWN"
    return "FLAT"


def _trend_status(df: pd.DataFrame) -> str:
    if len(df) < 30:
        return "RANGE"
    last = df.iloc[-1]
    if pd.isna(last.get("vegas_slow_slope")) or pd.isna(last.get("vegas_slow_mid")):
        return "RANGE"
    slope = float(last["vegas_slow_slope"])
    close = float(last["close"])
    slow = float(last["vegas_slow_mid"])
    if close <= 0:
        return "RANGE"
    if pd.notna(last.get("vegas_e1")) and pd.notna(last.get("vegas_e3")):
        entangle = abs(float(last["vegas_e1"]) - float(last["vegas_e3"])) / close
        if entangle < 0.02 and abs(slope) <= SANDBOX_RANGE_SLOPE_MAX:
            return "RANGE"
    if slope >= SANDBOX_TREND_SLOPE_MIN and close > slow:
        return "BULL"
    if slope <= -SANDBOX_TREND_SLOPE_MIN and close < slow:
        return "BEAR"
    return "RANGE"


def build_mtf_context(klines_by_tf: dict[str, list[list]]) -> dict[str, Any]:
    """
    4h / 1d 多周期：Vegas 方向 + 趋势 + MACD 顶部走弱。
    allow_short：大周期非强烈多头，或已过热/顶背离。
    """
    out: dict[str, Any] = {
        "4h": {},
        "1d": {},
        "allow_short": True,
        "allow_long": True,
        "summary": "",
        "block_reason": "",
    }
    tf_labels = {"4h": "4h", "1d": "日线"}
    bull_count = 0
    overheated = False

    for tf, label in tf_labels.items():
        raw = klines_by_tf.get(tf) or []
        if len(raw) < 40:
            out[tf] = {"ready": False, "label": f"{label} 数据不足"}
            continue
        df = _enrich_mtf_df(klines_to_df(raw))
        vd = _vegas_direction(df)
        ts = _trend_status(df)
        macd_weak = bool(_macd_top_weak(df))
        last_close = float(df.iloc[-1]["close"])
        slow_mid = float(df.iloc[-1].get("vegas_slow_mid") or 0)
        near_resistance = slow_mid > 0 and last_close >= slow_mid * 0.995
        out[tf] = {
            "ready": True,
            "vegas_direction": vd,
            "vegas_label": {"UP": "蓝>红↑", "DOWN": "红>蓝↓", "FLAT": "纠缠"}.get(vd, vd),
            "trend": ts,
            "macd_top_weak": macd_weak,
            "near_resistance": near_resistance,
        }
        if ts == "BULL" and vd == "UP":
            bull_count += 1
        if macd_weak and (vd == "UP" or near_resistance):
            overheated = True

    h4 = out.get("4h") or {}
    d1 = out.get("1d") or {}

    # 大周期强烈多头 → 过滤小周期看空形态（LH / 顶背离类）
    if h4.get("ready") and h4.get("vegas_direction") == "UP" and h4.get("trend") == "BULL":
        if not (h4.get("macd_top_weak") or h4.get("near_resistance")):
            out["allow_short"] = False
            out["block_reason"] = "4h Vegas 多头排列，暂不看空"
        elif overheated:
            out["allow_short"] = True
            out["summary"] = "4h 多头但过热/顶弱，看空形态有效"
        else:
            out["allow_short"] = False
            out["block_reason"] = "4h 多头趋势中，需等阻力位+指标过热"

    if d1.get("ready") and d1.get("trend") == "BULL" and d1.get("vegas_direction") == "UP":
        if bull_count >= 1 and not overheated:
            out["allow_short"] = False
            out["block_reason"] = out["block_reason"] or "日线多头，过滤小周期空信号"

    if h4.get("ready") and h4.get("trend") == "BEAR" and h4.get("vegas_direction") == "DOWN":
        out["allow_long"] = False
        out["block_reason"] = out.get("block_reason") or "4h 空头排列，谨慎做多扳机"

    if not out["summary"]:
        if out["allow_short"]:
            out["summary"] = "多周期允许小周期空信号"
        elif out["block_reason"]:
            out["summary"] = out["block_reason"]
        else:
            out["summary"] = "多周期中性"

    return out


def build_derivatives_context(
    *,
    klines: list[list],
    oi_by_time: dict[int, float] | None,
    funding: dict[str, Any] | None,
    mtf: dict[str, Any] | None,
    structure: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """汇总图表 analysis.derivatives 字段。"""
    structure = structure or {}
    last_price = float(klines[-1][4]) if klines else 0.0
    hi = float(structure.get("hh_price") or structure.get("h_max") or last_price)
    lo = float(structure.get("l1") or structure.get("hl") or 0.0)
    oi_regime = classify_oi_price_regime(klines, oi_by_time)
    liq_zones = estimate_liquidation_zones(price=last_price, swing_high=hi, swing_low=lo)

    funding = funding or {}
    mtf = mtf or {}
    high_funding_short_bias = bool(
        funding.get("extreme_positive") and oi_regime.get("regime") in ("squeeze", "breakout")
    )

    return {
        "funding_rate": funding.get("funding_rate"),
        "funding_rate_pct": funding.get("funding_rate_pct"),
        "funding_extreme": funding.get("extreme_positive") or funding.get("extreme_negative"),
        "funding_extreme_positive": funding.get("extreme_positive"),
        "oi_regime": oi_regime.get("regime"),
        "oi_regime_label": oi_regime.get("label"),
        "oi_price_chg_pct": oi_regime.get("price_chg_pct"),
        "oi_chg_pct": oi_regime.get("oi_chg_pct"),
        "high_funding_short_bias": high_funding_short_bias,
        "liquidation_zones": liq_zones,
        "mtf": mtf,
    }
