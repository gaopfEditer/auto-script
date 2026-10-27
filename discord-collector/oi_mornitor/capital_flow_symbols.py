"""币安合约 symbol 解析（exchangeInfo + 千倍映射）。"""
from __future__ import annotations

import logging
import time
from typing import Any

import aiohttp

from oi_mornitor.capital_flow_binance import get_json_fapi_chain
from oi_mornitor.capital_flow_store import cache_get, cache_set
from oi_mornitor.symbol_aliases import normalize_usdt_symbol, symbol_lookup_candidates

logger = logging.getLogger(__name__)

_INFO_TTL_SEC = 3600.0
_info_loaded_at: float = 0.0
_trading_symbols: set[str] = set()
_funding_interval_h: dict[str, float] = {}


async def _refresh_exchange_meta(
    session: aiohttp.ClientSession,
    primary_base: str | None,
) -> None:
    global _info_loaded_at, _trading_symbols, _funding_interval_h
    if _trading_symbols and time.time() - _info_loaded_at < _INFO_TTL_SEC:
        return
    cached = cache_get("cf:exchangeInfo")
    if isinstance(cached, dict) and time.time() - float(cached.get("_ts") or 0) < _INFO_TTL_SEC:
        _trading_symbols = set(cached.get("symbols") or [])
        _funding_interval_h = dict(cached.get("fundingH") or {})
        _info_loaded_at = float(cached.get("_ts") or 0)
        return
    status, data, _ = await get_json_fapi_chain(
        session,
        "/fapi/v1/exchangeInfo",
        primary_base=primary_base,
        label="cf-exchangeInfo",
    )
    syms: set[str] = set()
    if status == 200 and isinstance(data, dict):
        for row in data.get("symbols") or []:
            if not isinstance(row, dict):
                continue
            if str(row.get("status") or "").upper() != "TRADING":
                continue
            s = str(row.get("symbol") or "").upper()
            if s:
                syms.add(s)
    fund_h: dict[str, float] = {}
    st2, data2, _ = await get_json_fapi_chain(
        session,
        "/fapi/v1/fundingInfo",
        primary_base=primary_base,
        label="cf-fundingInfo",
    )
    if st2 == 200 and isinstance(data2, list):
        for row in data2:
            if not isinstance(row, dict):
                continue
            sym = str(row.get("symbol") or "").upper()
            try:
                h = float(row.get("fundingIntervalHours") or 8)
            except (TypeError, ValueError):
                h = 8.0
            if sym:
                fund_h[sym] = max(1.0, h)
    _trading_symbols = syms
    _funding_interval_h = fund_h
    _info_loaded_at = time.time()
    cache_set(
        "cf:exchangeInfo",
        {"_ts": _info_loaded_at, "symbols": list(syms), "fundingH": fund_h},
    )


async def resolve_fapi_symbol(
    session: aiohttp.ClientSession,
    symbol: str,
    *,
    primary_base: str | None = None,
) -> str:
    raw = normalize_usdt_symbol(symbol)
    if not raw:
        return ""
    await _refresh_exchange_meta(session, primary_base)
    if not _trading_symbols:
        return raw
    for cand in symbol_lookup_candidates(raw, "binance"):
        if cand in _trading_symbols:
            if cand != raw:
                logger.debug("capital flow symbol %s → %s", raw, cand)
            return cand
    return raw


async def funding_interval_hours(
    session: aiohttp.ClientSession,
    symbol: str,
    *,
    primary_base: str | None = None,
) -> float:
    sym = await resolve_fapi_symbol(session, symbol, primary_base=primary_base)
    await _refresh_exchange_meta(session, primary_base)
    return float(_funding_interval_h.get(sym, 8.0))
