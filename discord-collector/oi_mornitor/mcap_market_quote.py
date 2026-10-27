"""CoinGecko 市值缓存（形态图 meta 展示，失败则仅显示梯队档）。"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import aiohttp

from oi_mornitor.symbol_aliases import normalize_usdt_symbol

logger = logging.getLogger(__name__)

_MAP: dict[str, float] = {}
_MAP_TS = 0.0
_TTL_SEC = 600.0
_LOCK = asyncio.Lock()


def _base_asset(symbol: str) -> str:
    n = normalize_usdt_symbol(symbol)
    if not n:
        return ""
    if n.endswith("USDT"):
        return n[: -len("USDT")]
    if n.endswith("USD"):
        return n[: -len("USD")]
    return n


async def _refresh_map(session: aiohttp.ClientSession) -> None:
    global _MAP, _MAP_TS
    url = "https://api.coingecko.com/api/v3/coins/markets"
    params = {
        "vs_currency": "usd",
        "order": "market_cap_desc",
        "per_page": 250,
        "page": 1,
        "sparkline": "false",
    }
    timeout = aiohttp.ClientTimeout(total=18)
    async with session.get(url, params=params, timeout=timeout) as resp:
        resp.raise_for_status()
        data = await resp.json()
    m: dict[str, float] = {}
    if isinstance(data, list):
        for row in data:
            if not isinstance(row, dict):
                continue
            sym = str(row.get("symbol") or "").strip().upper()
            cap = row.get("market_cap")
            if sym and cap is not None:
                try:
                    m[sym] = float(cap)
                except (TypeError, ValueError):
                    continue
    _MAP = m
    _MAP_TS = time.time()


async def market_cap_usd_for_symbol(
    session: aiohttp.ClientSession,
    symbol: str,
) -> float | None:
    """按 base 资产查 USD 市值；仅覆盖 CoinGecko Top250，其余返回 None。"""
    base = _base_asset(symbol).upper()
    if not base:
        return None
    async with _LOCK:
        stale = time.time() - _MAP_TS > _TTL_SEC
        if stale or not _MAP:
            try:
                await _refresh_map(session)
            except Exception as exc:  # noqa: BLE001
                logger.debug("CoinGecko 市值刷新失败: %s", exc)
                if not _MAP:
                    return None
        return _MAP.get(base)


async def attach_live_market_cap(
    session: aiohttp.ClientSession,
    payload: dict[str, Any],
    symbol: str,
) -> None:
    cap = await market_cap_usd_for_symbol(session, symbol)
    if cap is not None and cap > 0:
        payload["marketCapUsd"] = cap
