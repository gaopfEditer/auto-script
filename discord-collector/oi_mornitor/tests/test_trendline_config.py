"""趋势线模块配置：空 .env / 非法值回退默认。"""
from __future__ import annotations

import importlib
import os
from unittest import mock

import pytest

_TRENDLINE_ENV_KEYS = [
    "OI_TRENDLINE_ENABLED",
    "OI_TRENDLINE_TELEGRAM_CHAT_ID",
    "OI_TRENDLINE_BTC_SYMBOL",
    "OI_TRENDLINE_BTC_INTERVALS",
    "OI_TRENDLINE_BTC_EMA_INTERVALS",
    "OI_TRENDLINE_QQQ_TICKER",
    "OI_TRENDLINE_QQQ_SYMBOL",
    "OI_TRENDLINE_QQQ_INTERVALS",
    "OI_TRENDLINE_FAPI_BASE_URL",
    "OI_TRENDLINE_FAPI_FALLBACK_URL",
    "OI_TRENDLINE_PIVOT_LEFT",
    "OI_TRENDLINE_PIVOT_RIGHT",
    "OI_TRENDLINE_MIN_TOUCHES",
    "OI_TRENDLINE_MAX_LINES_PER_SIDE",
    "OI_TRENDLINE_TOUCH_TOL_PCT",
    "OI_TRENDLINE_CLOSE_VIOLATION_TOL_PCT",
    "OI_TRENDLINE_WICK_VIOLATION_MULT",
    "OI_TRENDLINE_NEAR_PCT",
    "OI_TRENDLINE_NEAR_ATR_MULT",
    "OI_TRENDLINE_VOL_MULT",
    "OI_TRENDLINE_EMA_NEAR_TOL_PCT",
    "OI_TRENDLINE_SL_BUFFER_PCT",
    "OI_TRENDLINE_SL_BUFFER_MIN_PCT",
    "OI_TRENDLINE_SL_BUFFER_MAX_PCT",
    "OI_TRENDLINE_KLINE_LIMIT",
    "OI_TRENDLINE_LOOKBACK_BARS",
    "OI_TRENDLINE_BREAKOUT_RETEST_BARS",
    "OI_TRENDLINE_RSI_OVERSOLD",
    "OI_TRENDLINE_CACHE_DIR",
    "OI_TRENDLINE_YAHOO_HOSTS",
    "OI_TRENDLINE_BAR_CLOSE_GRACE_SEC",
]


def _reload_trendline_config():
    import oi_mornitor.trendline_config as tc

    return importlib.reload(tc)


@pytest.fixture
def trendline_config_clean_env():
    """移除全部 OI_TRENDLINE_* 后重载配置。"""
    import oi_mornitor.trendline_config as tc_before

    blank = {k: "" for k in _TRENDLINE_ENV_KEYS}
    with mock.patch.dict(os.environ, blank, clear=False):
        for k in _TRENDLINE_ENV_KEYS:
            os.environ.pop(k, None)
        mod = _reload_trendline_config()
        yield mod
    importlib.reload(tc_before)


def test_defaults_with_empty_env(trendline_config_clean_env) -> None:
    tc = trendline_config_clean_env
    assert tc.is_trendline_enabled() is True
    assert tc.TRENDLINE_BTC_SYMBOL == "BTCUSDT"
    assert tc.TRENDLINE_BTC_INTERVALS == ("15m", "1h")
    assert tc.TRENDLINE_BTC_EMA_INTERVALS == ("1h", "4h")
    assert tc.TRENDLINE_QQQ_TICKER == "QQQ"
    assert tc.TRENDLINE_QQQ_SYMBOL == "QQQUSDT"
    assert tc.TRENDLINE_QQQ_INTERVALS == ("4h", "1d", "1w")
    assert tc.TRENDLINE_FAPI_FALLBACK_URL == "https://www.binance.com"
    assert tc.TRENDLINE_PIVOT_LEFT == 3
    assert tc.TRENDLINE_PIVOT_RIGHT == 3
    assert tc.TRENDLINE_MIN_TOUCHES == 2
    assert tc.TRENDLINE_MAX_LINES_PER_SIDE == 2
    assert tc.TRENDLINE_NEAR_PCT == 0.004
    assert tc.TRENDLINE_VOL_MULT == 1.5
    assert tc.TRENDLINE_KLINE_LIMIT == 500
    assert tc.TRENDLINE_BAR_CLOSE_GRACE_SEC == 25
    assert len(tc.TRENDLINE_YAHOO_HOSTS) >= 2
    assert tc.TRENDLINE_CACHE_DIR.endswith("trendline_cache")


def test_invalid_numeric_env_falls_back_to_defaults() -> None:
    import oi_mornitor.trendline_config as tc_before

    try:
        with mock.patch.dict(
            os.environ,
            {
                "OI_TRENDLINE_PIVOT_LEFT": "not-a-number",
                "OI_TRENDLINE_NEAR_PCT": "",
                "OI_TRENDLINE_KLINE_LIMIT": "0",
            },
            clear=False,
        ):
            tc = _reload_trendline_config()
            assert tc.TRENDLINE_PIVOT_LEFT == 3
            assert tc.TRENDLINE_NEAR_PCT == 0.004
            assert tc.TRENDLINE_KLINE_LIMIT == 200
    finally:
        importlib.reload(tc_before)


def test_enabled_empty_string_defaults_on() -> None:
    import oi_mornitor.trendline_config as tc_before

    try:
        with mock.patch.dict(os.environ, {"OI_TRENDLINE_ENABLED": ""}, clear=False):
            tc = _reload_trendline_config()
            assert tc.is_trendline_enabled() is True
        with mock.patch.dict(os.environ, {"OI_TRENDLINE_ENABLED": "0"}, clear=False):
            tc = _reload_trendline_config()
            assert tc.is_trendline_enabled() is False
    finally:
        importlib.reload(tc_before)
