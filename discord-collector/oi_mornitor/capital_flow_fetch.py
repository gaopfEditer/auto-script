"""拉取 OI / 费率 / 多空比 / Taker（仅公开 REST）。"""
from __future__ import annotations

import logging
from typing import Any

import aiohttp

from oi_mornitor.capital_flow_binance import get_json_fapi_chain
from oi_mornitor.capital_flow_config import CF_FETCH_LIMIT
from oi_mornitor.capital_flow_store import cache_get, cache_set
from oi_mornitor.capital_flow_symbols import funding_interval_hours, resolve_fapi_symbol
from oi_mornitor.chart_deriv_hist import _norm_period
from oi_mornitor.symbol_aliases import normalize_usdt_symbol

logger = logging.getLogger(__name__)


def _series_from_rows(rows: list[dict[str, Any]], value_key: str) -> list[tuple[int, float]]:
    out: list[tuple[int, float]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            ts = int(row.get("timestamp") or 0)
            val = float(row.get(value_key) or 0)
        except (TypeError, ValueError):
            continue
        if ts <= 0:
            continue
        out.append((ts // 1000, val))
    out.sort(key=lambda x: x[0])
    return out


async def fetch_oi_hist_series(
    session: aiohttp.ClientSession,
    *,
    symbol: str,
    interval: str,
    limit: int | None = None,
    primary_base: str | None = None,
    end_time_ms: int | None = None,
) -> list[tuple[int, float]]:
    sym = await resolve_fapi_symbol(session, symbol, primary_base=primary_base)
    if not sym:
        return []
    period = _norm_period(interval)
    if not period:
        return []
    cap = min(max(limit or CF_FETCH_LIMIT, 1), 500)
    cache_key = f"oi:{sym}:{period}:{cap}:{end_time_ms or 0}"
    cached = cache_get(cache_key)
    if isinstance(cached, list):
        return cached
    params: dict[str, Any] = {"symbol": sym, "period": period, "limit": cap}
    if end_time_ms and end_time_ms > 0:
        params["endTime"] = int(end_time_ms)
    status, data, _ = await get_json_fapi_chain(
        session,
        "/futures/data/openInterestHist",
        params=params,
        primary_base=primary_base,
        label=f"oi-hist:{sym}",
    )
    if status != 200 or not isinstance(data, list):
        return []
    rows: list[dict[str, Any]] = []
    for row in data:
        if isinstance(row, dict):
            rows.append(row)
    series = _series_from_rows(rows, "sumOpenInterest")
    cache_set(cache_key, series)
    return series


async def fetch_funding_at(
    session: aiohttp.ClientSession,
    *,
    symbol: str,
    signal_at_ms: int,
    primary_base: str | None = None,
) -> tuple[float | None, float]:
    """返回 (已结算费率, fundingIntervalHours)。仅取 fundingTime <= signal_at_ms 的最近一期。"""
    sym = await resolve_fapi_symbol(session, symbol, primary_base=primary_base)
    if not sym or signal_at_ms <= 0:
        return None, 8.0
    interval_h = await funding_interval_hours(session, sym, primary_base=primary_base)
    cache_key = f"fund:{sym}:{signal_at_ms // 60_000}:{interval_h}"
    cached = cache_get(cache_key)
    if isinstance(cached, (list, tuple)) and len(cached) == 2:
        return cached[0], float(cached[1])
    params: dict[str, Any] = {
        "symbol": sym,
        "endTime": int(signal_at_ms),
        "limit": 1000,
    }
    status, data, _ = await get_json_fapi_chain(
        session,
        "/fapi/v1/fundingRate",
        params=params,
        primary_base=primary_base,
        label=f"funding:{sym}",
    )
    rate: float | None = None
    if status == 200 and isinstance(data, list):
        rate = pick_funding_rate_at(data, signal_at_ms)
    cache_set(cache_key, (rate, interval_h))
    return rate, interval_h


async def fetch_ratio_series(
    session: aiohttp.ClientSession,
    *,
    endpoint: str,
    symbol: str,
    interval: str,
    limit: int | None = None,
    primary_base: str | None = None,
    end_time_ms: int | None = None,
) -> list[tuple[int, float]]:
    sym = await resolve_fapi_symbol(session, symbol, primary_base=primary_base)
    if not sym:
        return []
    period = _norm_period(interval)
    if not period:
        return []
    cap = min(max(limit or CF_FETCH_LIMIT, 1), 500)
    cache_key = f"ratio:{endpoint}:{sym}:{period}:{cap}:{end_time_ms or 0}"
    cached = cache_get(cache_key)
    if isinstance(cached, list):
        return cached
    params: dict[str, Any] = {"symbol": sym, "period": period, "limit": cap}
    if end_time_ms and end_time_ms > 0:
        params["endTime"] = int(end_time_ms)
    status, data, _ = await get_json_fapi_chain(
        session,
        f"/futures/data/{endpoint}",
        params=params,
        primary_base=primary_base,
        label=f"{endpoint}:{sym}",
    )
    if status != 200 or not isinstance(data, list):
        return []
    series = _series_from_rows([r for r in data if isinstance(r, dict)], "longShortRatio")
    cache_set(cache_key, series)
    return series


async def fetch_taker_buy_ratio_series(
    session: aiohttp.ClientSession,
    *,
    symbol: str,
    interval: str,
    limit: int | None = None,
    primary_base: str | None = None,
    end_time_ms: int | None = None,
) -> list[tuple[int, float]]:
    sym = await resolve_fapi_symbol(session, symbol, primary_base=primary_base)
    if not sym:
        return []
    period = _norm_period(interval)
    if not period:
        return []
    cap = min(max(limit or CF_FETCH_LIMIT, 1), 500)
    cache_key = f"taker:{sym}:{period}:{cap}:{end_time_ms or 0}"
    cached = cache_get(cache_key)
    if isinstance(cached, list):
        return cached
    params: dict[str, Any] = {"symbol": sym, "period": period, "limit": cap}
    if end_time_ms and end_time_ms > 0:
        params["endTime"] = int(end_time_ms)
    status, data, _ = await get_json_fapi_chain(
        session,
        "/futures/data/takerlongshortRatio",
        params=params,
        primary_base=primary_base,
        label=f"taker:{sym}",
    )
    if status != 200 or not isinstance(data, list):
        return []
    out: list[tuple[int, float]] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        try:
            ts = int(row.get("timestamp") or 0)
            buy = float(row.get("buyVol") or 0)
            sell = float(row.get("sellVol") or 0)
        except (TypeError, ValueError):
            continue
        if ts <= 0 or buy + sell <= 0:
            continue
        out.append((ts // 1000, buy / (buy + sell)))
    out.sort(key=lambda x: x[0])
    cache_set(cache_key, out)
    return out


def pick_funding_rate_at(rows: list[Any], signal_at_ms: int) -> float | None:
    """在返回列表中取 fundingTime <= signal_at_ms 的最近一期（最大 fundingTime）。"""
    best_ft = -1
    rate: float | None = None
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            ft = int(row.get("fundingTime") or 0)
            r = float(row.get("fundingRate") or 0)
        except (TypeError, ValueError):
            continue
        if ft <= signal_at_ms and ft >= best_ft:
            best_ft = ft
            rate = r
    return rate


def oi_coverage_days(series: list[tuple[int, float]]) -> float | None:
    if len(series) < 2:
        return None
    span_sec = series[-1][0] - series[0][0]
    return round(span_sec / 86400.0, 2)
