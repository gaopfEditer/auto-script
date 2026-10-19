"""USDT 永续 K 线（Binance fapi + www 兜底 + Bybit）。"""
from __future__ import annotations

import logging
from typing import Any

import aiohttp

from oi_mornitor.exchange_sources import _fetch_binance_klines, fetch_binance_klines_range, fetch_bybit_klines_range
from oi_mornitor.symbol_aliases import normalize_usdt_symbol
from oi_mornitor.trendline_config import (
    TRENDLINE_FAPI_BASE_URL,
    TRENDLINE_FAPI_FALLBACK_URL,
)
from oi_mornitor.range_reversal_config import RANGE_REVERSAL_KLINE_LIMIT

logger = logging.getLogger(__name__)


async def fetch_perp_klines(
    session: aiohttp.ClientSession,
    symbol: str,
    interval: str,
    *,
    limit: int | None = None,
    end_time: int | None = None,
) -> tuple[list[list[Any]], dict[str, Any]]:
    sym = normalize_usdt_symbol(symbol)
    lim = limit or RANGE_REVERSAL_KLINE_LIMIT
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
            return rows, {"data_source": label, "symbol": sym, "interval": interval, "bar_count": len(rows)}
    rows = await fetch_bybit_klines_range(
        session,
        symbol=sym,
        interval=interval,
        start_ms=0,
        end_ms=end_time or int(__import__("time").time() * 1000),
    )
    if rows:
        rows = rows[-lim:]
        return rows, {"data_source": "bybit", "symbol": sym, "interval": interval, "bar_count": len(rows)}
    return [], {"data_source": "none", "symbol": sym, "interval": interval}


async def fetch_perp_klines_range(
    session: aiohttp.ClientSession,
    symbol: str,
    interval: str,
    *,
    start_ms: int,
    end_ms: int,
) -> tuple[list[list[Any]], dict[str, Any]]:
    sym = normalize_usdt_symbol(symbol)
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
            return rows, {"data_source": label, "symbol": sym, "interval": interval, "bar_count": len(rows)}
    rows = await fetch_bybit_klines_range(
        session, symbol=sym, interval=interval, start_ms=start_ms, end_ms=end_ms
    )
    if rows:
        return rows, {"data_source": "bybit", "symbol": sym, "interval": interval, "bar_count": len(rows)}
    return [], {"data_source": "none", "symbol": sym, "interval": interval}
