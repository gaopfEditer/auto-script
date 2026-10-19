"""维加斯通道顺势延续信号 — 仅告警。"""
from __future__ import annotations

from typing import Tuple

from oi_mornitor.env_parse import env_bool, env_csv_lower, env_float, env_int, env_str

_ENABLED: bool = True
VEGAS_TREND_SLOPE_BARS: int = 12
VEGAS_TREND_STRUCTURE_LOOKBACK: int = 48
VEGAS_TREND_SIDE_FRACTION: float = 0.65
VEGAS_TREND_MIN_SLOPE_PCT: float = 0.0008
VEGAS_TREND_TOUCH_TOL_PCT: float = 0.004
VEGAS_TREND_USE_OUTER_TUNNEL: bool = True
VEGAS_TREND_VOL_MULT: float = 1.5
VEGAS_TREND_SL_BUFFER_PCT: float = 0.0015
VEGAS_TREND_SL_ATR_MULT: float = 0.15
VEGAS_TREND_TP2_R: float = 2.5
VEGAS_TREND_SWING_LOOKBACK: int = 80
VEGAS_TREND_KLINE_LIMIT: int = 720
VEGAS_TREND_MAJOR_SYMBOLS: Tuple[str, ...] = ("BTCUSDT", "ETHUSDT", "SOLUSDT")
VEGAS_TREND_INTERVALS: Tuple[str, ...] = ("15m", "1h", "4h")
VEGAS_TREND_QQQ_INTERVALS: Tuple[str, ...] = ("4h", "1d")
VEGAS_TREND_BT_MONTHS: int = 6
VEGAS_TREND_BT_ALT_MAX: int = 12
VEGAS_TREND_SCAN_ALT_MAX: int = 24
VEGAS_TREND_TELEGRAM_CHAT_ID: str = ""


def _apply() -> None:
    global _ENABLED
    global VEGAS_TREND_SLOPE_BARS
    global VEGAS_TREND_STRUCTURE_LOOKBACK
    global VEGAS_TREND_SIDE_FRACTION
    global VEGAS_TREND_MIN_SLOPE_PCT
    global VEGAS_TREND_TOUCH_TOL_PCT
    global VEGAS_TREND_USE_OUTER_TUNNEL
    global VEGAS_TREND_VOL_MULT
    global VEGAS_TREND_SL_BUFFER_PCT
    global VEGAS_TREND_SL_ATR_MULT
    global VEGAS_TREND_TP2_R
    global VEGAS_TREND_SWING_LOOKBACK
    global VEGAS_TREND_KLINE_LIMIT
    global VEGAS_TREND_MAJOR_SYMBOLS
    global VEGAS_TREND_INTERVALS
    global VEGAS_TREND_QQQ_INTERVALS
    global VEGAS_TREND_BT_MONTHS
    global VEGAS_TREND_BT_ALT_MAX
    global VEGAS_TREND_SCAN_ALT_MAX
    global VEGAS_TREND_TELEGRAM_CHAT_ID

    _ENABLED = env_bool("OI_VEGAS_TREND_ENABLED", True)
    VEGAS_TREND_SLOPE_BARS = env_int("OI_VEGAS_TREND_SLOPE_BARS", 12, min_val=4)
    VEGAS_TREND_STRUCTURE_LOOKBACK = env_int("OI_VEGAS_TREND_STRUCTURE_LOOKBACK", 48, min_val=20)
    VEGAS_TREND_SIDE_FRACTION = env_float("OI_VEGAS_TREND_SIDE_FRACTION", 0.65, min_val=0.5, max_val=0.95)
    VEGAS_TREND_MIN_SLOPE_PCT = env_float("OI_VEGAS_TREND_MIN_SLOPE_PCT", 0.0008, min_val=0.0)
    VEGAS_TREND_TOUCH_TOL_PCT = env_float("OI_VEGAS_TREND_TOUCH_TOL_PCT", 0.004, min_val=0.0005)
    VEGAS_TREND_USE_OUTER_TUNNEL = env_bool("OI_VEGAS_TREND_USE_OUTER_TUNNEL", True)
    VEGAS_TREND_VOL_MULT = env_float("OI_VEGAS_TREND_VOL_MULT", 1.5, min_val=1.0)
    VEGAS_TREND_SL_BUFFER_PCT = env_float("OI_VEGAS_TREND_SL_BUFFER_PCT", 0.0015, min_val=0.0)
    VEGAS_TREND_SL_ATR_MULT = env_float("OI_VEGAS_TREND_SL_ATR_MULT", 0.15, min_val=0.0)
    VEGAS_TREND_TP2_R = env_float("OI_VEGAS_TREND_TP2_R", 2.5, min_val=1.0)
    VEGAS_TREND_SWING_LOOKBACK = env_int("OI_VEGAS_TREND_SWING_LOOKBACK", 80, min_val=20)
    VEGAS_TREND_KLINE_LIMIT = env_int("OI_VEGAS_TREND_KLINE_LIMIT", 720, min_val=300)
    VEGAS_TREND_MAJOR_SYMBOLS = tuple(
        s.upper() for s in env_csv_lower("OI_VEGAS_TREND_MAJOR_SYMBOLS", "btcusdt,ethusdt,solusdt")
    )
    VEGAS_TREND_INTERVALS = env_csv_lower("OI_VEGAS_TREND_INTERVALS", "15m,1h,4h")
    VEGAS_TREND_QQQ_INTERVALS = env_csv_lower("OI_VEGAS_TREND_QQQ_INTERVALS", "4h,1d")
    VEGAS_TREND_BT_MONTHS = env_int("OI_VEGAS_TREND_BT_MONTHS", 6, min_val=1)
    VEGAS_TREND_BT_ALT_MAX = env_int("OI_VEGAS_TREND_BT_ALT_MAX", 12, min_val=0)
    VEGAS_TREND_SCAN_ALT_MAX = env_int("OI_VEGAS_TREND_SCAN_ALT_MAX", 24, min_val=0)

    from oi_mornitor.range_reversal_config import RANGE_REVERSAL_TELEGRAM_CHAT_ID

    chat = env_str("OI_VEGAS_TREND_TELEGRAM_CHAT_ID", "")
    VEGAS_TREND_TELEGRAM_CHAT_ID = chat.strip() or RANGE_REVERSAL_TELEGRAM_CHAT_ID


def is_vegas_trend_enabled() -> bool:
    return _ENABLED


_apply()
