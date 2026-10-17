"""趋势线 + EMA144 信号模块环境配置（仅告警/日志，不下单）。

所有 OI_TRENDLINE_* 变量在缺失、空字符串或非法值时回退到代码内默认值；
模块默认开启（OI_TRENDLINE_ENABLED 未设或为空 → 开）。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Tuple

# 模块级常量由 _apply_config() 填充；测试可 importlib.reload 本模块以重载。
TRENDLINE_TELEGRAM_CHAT_ID: str = ""
TRENDLINE_BTC_SYMBOL: str = "BTCUSDT"
TRENDLINE_BTC_INTERVALS: Tuple[str, ...] = ("15m", "1h")
TRENDLINE_BTC_EMA_INTERVALS: Tuple[str, ...] = ("1h", "4h")
TRENDLINE_QQQ_TICKER: str = "QQQ"
TRENDLINE_QQQ_SYMBOL: str = "QQQUSDT"
TRENDLINE_QQQ_INTERVALS: Tuple[str, ...] = ("4h", "1d", "1w")
TRENDLINE_FAPI_BASE_URL: str = "https://fapi.binance.com"
TRENDLINE_FAPI_FALLBACK_URL: str = "https://www.binance.com/fapi"
TRENDLINE_PIVOT_LEFT: int = 3
TRENDLINE_PIVOT_RIGHT: int = 3
TRENDLINE_MIN_TOUCHES: int = 2
TRENDLINE_MAX_LINES_PER_SIDE: int = 2
TRENDLINE_TOUCH_TOL_PCT: float = 0.0025
TRENDLINE_CLOSE_VIOLATION_TOL_PCT: float = 0.003
TRENDLINE_WICK_VIOLATION_MULT: float = 2.0
TRENDLINE_NEAR_PCT: float = 0.004
TRENDLINE_NEAR_ATR_MULT: float = 0.35
TRENDLINE_VOL_MULT: float = 1.5
TRENDLINE_EMA_NEAR_TOL_PCT: float = 0.012
TRENDLINE_SL_BUFFER_PCT: float = 0.004
TRENDLINE_SL_BUFFER_MIN_PCT: float = 0.003
TRENDLINE_SL_BUFFER_MAX_PCT: float = 0.006
TRENDLINE_KLINE_LIMIT: int = 500
TRENDLINE_LOOKBACK_BARS: int = 320
TRENDLINE_BREAKOUT_RETEST_BARS: int = 12
TRENDLINE_RSI_OVERSOLD: float = 30.0
TRENDLINE_CACHE_DIR: str = ""
TRENDLINE_YAHOO_HOSTS: Tuple[str, ...] = (
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com",
)
TRENDLINE_BAR_CLOSE_GRACE_SEC: int = 25

_ENABLED: bool = True

_DEFAULT_FAPI = "https://fapi.binance.com"
_DEFAULT_FAPI_FALLBACK = "https://www.binance.com/fapi"
_DEFAULT_YAHOO_HOSTS = "query1.finance.yahoo.com,query2.finance.yahoo.com"


def _env_str(key: str, default: str) -> str:
    raw = os.environ.get(key)
    if raw is None:
        return default
    s = str(raw).strip()
    return s if s else default


def _env_bool(key: str, default: bool = True) -> bool:
    raw = os.environ.get(key)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _env_int(key: str, default: int, *, minimum: int | None = None) -> int:
    raw = os.environ.get(key)
    if raw is None or not str(raw).strip():
        n = default
    else:
        try:
            n = int(str(raw).strip())
        except ValueError:
            n = default
    if minimum is not None:
        n = max(minimum, n)
    return n


def _env_float(key: str, default: float) -> float:
    raw = os.environ.get(key)
    if raw is None or not str(raw).strip():
        return default
    try:
        return float(str(raw).strip())
    except ValueError:
        return default


def _env_csv_lower(key: str, default: str) -> Tuple[str, ...]:
    raw = os.environ.get(key)
    text = default if raw is None or not str(raw).strip() else str(raw)
    parts = tuple(x.strip().lower() for x in text.split(",") if x.strip())
    if parts:
        return parts
    return tuple(x.strip().lower() for x in default.split(",") if x.strip())


def _env_csv_hosts(key: str, default: str) -> Tuple[str, ...]:
    raw = os.environ.get(key)
    text = default if raw is None or not str(raw).strip() else str(raw)
    parts = tuple(h.strip() for h in text.split(",") if h.strip())
    if parts:
        return parts
    return tuple(h.strip() for h in default.split(",") if h.strip())


def _default_cache_dir() -> str:
    from oi_mornitor.config import PATTERN_STATE_DB

    return str(Path(PATTERN_STATE_DB).resolve().parent / "trendline_cache")


def _apply_config() -> None:
    global _ENABLED
    global TRENDLINE_TELEGRAM_CHAT_ID
    global TRENDLINE_BTC_SYMBOL, TRENDLINE_BTC_INTERVALS, TRENDLINE_BTC_EMA_INTERVALS
    global TRENDLINE_QQQ_TICKER, TRENDLINE_QQQ_SYMBOL, TRENDLINE_QQQ_INTERVALS
    global TRENDLINE_FAPI_BASE_URL, TRENDLINE_FAPI_FALLBACK_URL
    global TRENDLINE_PIVOT_LEFT, TRENDLINE_PIVOT_RIGHT, TRENDLINE_MIN_TOUCHES
    global TRENDLINE_MAX_LINES_PER_SIDE
    global TRENDLINE_TOUCH_TOL_PCT, TRENDLINE_CLOSE_VIOLATION_TOL_PCT
    global TRENDLINE_WICK_VIOLATION_MULT
    global TRENDLINE_NEAR_PCT, TRENDLINE_NEAR_ATR_MULT, TRENDLINE_VOL_MULT
    global TRENDLINE_EMA_NEAR_TOL_PCT
    global TRENDLINE_SL_BUFFER_PCT, TRENDLINE_SL_BUFFER_MIN_PCT, TRENDLINE_SL_BUFFER_MAX_PCT
    global TRENDLINE_KLINE_LIMIT, TRENDLINE_LOOKBACK_BARS, TRENDLINE_BREAKOUT_RETEST_BARS
    global TRENDLINE_RSI_OVERSOLD, TRENDLINE_CACHE_DIR, TRENDLINE_YAHOO_HOSTS
    global TRENDLINE_BAR_CLOSE_GRACE_SEC

    from oi_mornitor.config import (
        CANDLE_CARD_TELEGRAM_CHAT_ID,
        FAPI_BASE_URL,
        MAIN_CARD_TELEGRAM_CHAT_ID,
    )

    _ENABLED = _env_bool("OI_TRENDLINE_ENABLED", default=True)

    chat_override = _env_str("OI_TRENDLINE_TELEGRAM_CHAT_ID", "")
    if chat_override:
        TRENDLINE_TELEGRAM_CHAT_ID = chat_override
    else:
        TRENDLINE_TELEGRAM_CHAT_ID = (
            (MAIN_CARD_TELEGRAM_CHAT_ID or "").strip()
            or (CANDLE_CARD_TELEGRAM_CHAT_ID or "").strip()
            or ""
        )

    TRENDLINE_BTC_SYMBOL = _env_str("OI_TRENDLINE_BTC_SYMBOL", "BTCUSDT").upper()
    TRENDLINE_BTC_INTERVALS = _env_csv_lower("OI_TRENDLINE_BTC_INTERVALS", "15m,1h")
    TRENDLINE_BTC_EMA_INTERVALS = _env_csv_lower("OI_TRENDLINE_BTC_EMA_INTERVALS", "1h,4h")

    TRENDLINE_QQQ_TICKER = _env_str("OI_TRENDLINE_QQQ_TICKER", "QQQ").upper()
    TRENDLINE_QQQ_SYMBOL = _env_str("OI_TRENDLINE_QQQ_SYMBOL", "QQQUSDT").upper()
    TRENDLINE_QQQ_INTERVALS = _env_csv_lower("OI_TRENDLINE_QQQ_INTERVALS", "4h,1d,1w")

    fapi_default = (FAPI_BASE_URL or _DEFAULT_FAPI).rstrip("/")
    TRENDLINE_FAPI_BASE_URL = _env_str("OI_TRENDLINE_FAPI_BASE_URL", fapi_default).rstrip("/")
    if not TRENDLINE_FAPI_BASE_URL:
        TRENDLINE_FAPI_BASE_URL = fapi_default

    TRENDLINE_FAPI_FALLBACK_URL = _env_str(
        "OI_TRENDLINE_FAPI_FALLBACK_URL", _DEFAULT_FAPI_FALLBACK
    ).rstrip("/")
    if not TRENDLINE_FAPI_FALLBACK_URL:
        TRENDLINE_FAPI_FALLBACK_URL = _DEFAULT_FAPI_FALLBACK

    TRENDLINE_PIVOT_LEFT = _env_int("OI_TRENDLINE_PIVOT_LEFT", 3, minimum=1)
    TRENDLINE_PIVOT_RIGHT = _env_int("OI_TRENDLINE_PIVOT_RIGHT", 3, minimum=1)
    TRENDLINE_MIN_TOUCHES = _env_int("OI_TRENDLINE_MIN_TOUCHES", 2, minimum=2)
    TRENDLINE_MAX_LINES_PER_SIDE = _env_int("OI_TRENDLINE_MAX_LINES_PER_SIDE", 2, minimum=1)
    TRENDLINE_TOUCH_TOL_PCT = _env_float("OI_TRENDLINE_TOUCH_TOL_PCT", 0.0025)
    TRENDLINE_CLOSE_VIOLATION_TOL_PCT = _env_float(
        "OI_TRENDLINE_CLOSE_VIOLATION_TOL_PCT", 0.003
    )
    TRENDLINE_WICK_VIOLATION_MULT = _env_float("OI_TRENDLINE_WICK_VIOLATION_MULT", 2.0)

    TRENDLINE_NEAR_PCT = _env_float("OI_TRENDLINE_NEAR_PCT", 0.004)
    TRENDLINE_NEAR_ATR_MULT = _env_float("OI_TRENDLINE_NEAR_ATR_MULT", 0.35)
    TRENDLINE_VOL_MULT = _env_float("OI_TRENDLINE_VOL_MULT", 1.5)
    TRENDLINE_EMA_NEAR_TOL_PCT = _env_float("OI_TRENDLINE_EMA_NEAR_TOL_PCT", 0.012)
    TRENDLINE_SL_BUFFER_PCT = _env_float("OI_TRENDLINE_SL_BUFFER_PCT", 0.004)
    TRENDLINE_SL_BUFFER_MIN_PCT = _env_float("OI_TRENDLINE_SL_BUFFER_MIN_PCT", 0.003)
    TRENDLINE_SL_BUFFER_MAX_PCT = _env_float("OI_TRENDLINE_SL_BUFFER_MAX_PCT", 0.006)

    TRENDLINE_KLINE_LIMIT = _env_int("OI_TRENDLINE_KLINE_LIMIT", 500, minimum=200)
    TRENDLINE_LOOKBACK_BARS = _env_int("OI_TRENDLINE_LOOKBACK_BARS", 320, minimum=80)
    TRENDLINE_BREAKOUT_RETEST_BARS = _env_int(
        "OI_TRENDLINE_BREAKOUT_RETEST_BARS", 12, minimum=3
    )
    TRENDLINE_RSI_OVERSOLD = _env_float("OI_TRENDLINE_RSI_OVERSOLD", 30.0)

    cache = _env_str("OI_TRENDLINE_CACHE_DIR", "")
    TRENDLINE_CACHE_DIR = cache if cache else _default_cache_dir()

    TRENDLINE_YAHOO_HOSTS = _env_csv_hosts("OI_TRENDLINE_YAHOO_HOSTS", _DEFAULT_YAHOO_HOSTS)

    TRENDLINE_BAR_CLOSE_GRACE_SEC = _env_int(
        "OI_TRENDLINE_BAR_CLOSE_GRACE_SEC", 25, minimum=5
    )


def is_trendline_enabled() -> bool:
    return _ENABLED


_apply_config()
