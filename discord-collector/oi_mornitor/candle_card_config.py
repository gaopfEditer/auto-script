"""形态卡片群推送：量能确认 + 射击之星/倒锤子卡片门控（env 可覆盖）。"""
from __future__ import annotations

import os

CANDLE_CARD_REQUIRE_VOL = os.environ.get("OI_CANDLE_CARD_REQUIRE_VOL", "1").strip().lower() not in (
    "0",
    "false",
    "no",
)
# 默认略放宽：形态 + 放量即可进列表/TG
CANDLE_CARD_VOL_MULT = float(os.environ.get("OI_CANDLE_CARD_VOL_MULT") or "1.2")

# 位置/趋势背景（默认关趋势；位置仅当未走「放量直通」时可选）
CANDLE_SHOOT_REQUIRE_POSITION = os.environ.get(
    "OI_CANDLE_SHOOT_REQUIRE_POSITION", "0"
).strip().lower() not in ("0", "false", "no")
CANDLE_SHOOT_TREND_LOOKBACK = int(os.environ.get("OI_CANDLE_SHOOT_TREND_LOOKBACK") or "20")
CANDLE_SHOOT_TREND_MIN_PCT = float(os.environ.get("OI_CANDLE_SHOOT_TREND_MIN_PCT") or "0")
CANDLE_HAMMER_TREND_LOOKBACK = int(os.environ.get("OI_CANDLE_HAMMER_TREND_LOOKBACK") or "20")
CANDLE_HAMMER_TREND_MIN_PCT = float(os.environ.get("OI_CANDLE_HAMMER_TREND_MIN_PCT") or "0")
# 量能 ≥ 倍数时跳过位置+趋势（与「结合放量就出信号」一致）
CANDLE_VOL_BYPASS_CONTEXT = os.environ.get("OI_CANDLE_VOL_BYPASS_CONTEXT", "1").strip().lower() not in (
    "0",
    "false",
    "no",
)


def volume_ratio_from_row(row) -> float | None:
    try:
        vol = float(row.get("volume") if hasattr(row, "get") else row["volume"])
    except (TypeError, ValueError, KeyError):
        return None
    ma = None
    if hasattr(row, "get"):
        if row.get("vol_sma20") is not None:
            try:
                ma = float(row["vol_sma20"])
            except (TypeError, ValueError):
                ma = None
    if ma is None or ma <= 0:
        return None
    return vol / ma


def candle_volume_confirmed(ratio: float | None) -> bool:
    if not CANDLE_CARD_REQUIRE_VOL:
        return True
    if ratio is None:
        return False
    return float(ratio) >= CANDLE_CARD_VOL_MULT


def structure_volume_confirmed(hit: dict) -> bool:
    """结构检测已含破位放量；推送层再校验 vol_ratio / climax。"""
    if not CANDLE_CARD_REQUIRE_VOL:
        return True
    vr = hit.get("vol_ratio")
    if vr is None:
        vr = hit.get("climax_vol_ratio")
    if vr is None:
        return False
    try:
        return float(vr) >= CANDLE_CARD_VOL_MULT
    except (TypeError, ValueError):
        return False
