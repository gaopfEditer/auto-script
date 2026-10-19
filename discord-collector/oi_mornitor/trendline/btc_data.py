"""BTC USDT-M K 线（fapi + www.binance.com/fapi 兜底）。"""
from __future__ import annotations

import logging
from typing import Any

import aiohttp

from oi_mornitor.exchange_sources import _fetch_binance_klines, fetch_binance_klines_range, fetch_bybit_klines_range
from oi_mornitor.trendline_config import (
    TRENDLINE_BTC_SYMBOL,
    TRENDLINE_FAPI_BASE_URL,
    TRENDLINE_FAPI_FALLBACK_URL,
    TRENDLINE_KLINE_LIMIT,
)

logger = logging.getLogger(__name__)


async def fetch_btc_perp_klines(
    session: aiohttp.ClientSession,
    interval: str,
    *,
    limit: int | None = None,
    end_time: int | None = None,
) -> tuple[list[list[Any]], dict[str, Any]]:
    lim = limit or TRENDLINE_KLINE_LIMIT
    sym = TRENDLINE_BTC_SYMBOL
    for base, label in (
        (TRENDLINE_FAPI_BASE_URL, "fapi"),
        (TRENDLINE_FAPI_FALLBACK_URL, "binance_www_fapi"),
    ):
        rows = await _fetch_binance_klines(
            session,
            base_url=base,
            symbol=sym,
            interval=interval,
            limit=lim,
            end_time=end_time,
        )
        if rows:
            return rows, {
                "data_source": label,
                "base_url": base,
                "symbol": sym,
                "interval": interval,
                "bar_count": len(rows),
            }
        logger.info("BTC K线 %s 空响应，尝试下一数据源", base)
    return [], {"data_source": "none", "symbol": sym, "interval": interval}


async def fetch_btc_perp_klines_range(
    session: aiohttp.ClientSession,
    interval: str,
    *,
    start_ms: int,
    end_ms: int,
) -> tuple[list[list[Any]], dict[str, Any]]:
    """USDT 永续历史 K 线：与 Live 相同 fapi → www.binance.com → Bybit 链。"""
    sym = TRENDLINE_BTC_SYMBOL
    for base, label in (
        (TRENDLINE_FAPI_BASE_URL, "fapi"),
        (TRENDLINE_FAPI_FALLBACK_URL, "binance_www_fapi"),
    ):
        rows = await fetch_binance_klines_range(
            session,
            base_url=base,
            symbol=sym,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
        )
        if rows:
            return rows, {
                "data_source": label,
                "base_url": base,
                "symbol": sym,
                "interval": interval,
                "bar_count": len(rows),
            }
        logger.info("BTC 区间 K线 %s 空响应，尝试下一数据源", base)
    rows = await fetch_bybit_klines_range(
        session, symbol=sym, interval=interval, start_ms=start_ms, end_ms=end_ms
    )
    if rows:
        return rows, {
            "data_source": "bybit",
            "symbol": sym,
            "interval": interval,
            "bar_count": len(rows),
        }
    return [], {"data_source": "none", "symbol": sym, "interval": interval}
