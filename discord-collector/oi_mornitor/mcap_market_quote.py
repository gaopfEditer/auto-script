"""CoinGecko 市值缓存（梯队划分 + 形态图 meta）。失败时沿用上次缓存。"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.request
from pathlib import Path
from typing import Any

from oi_mornitor.symbol_aliases import normalize_usdt_symbol

logger = logging.getLogger(__name__)

_MAP: dict[str, float] = {}
_MAP_TS = 0.0
_TTL_SEC = 600.0
_LOCK = asyncio.Lock()
_FROZEN = False
_CACHE_FILE = Path(__file__).resolve().parent / "data" / "coingecko_mcap_cache.json"
_CG_URL = (
    "https://api.coingecko.com/api/v3/coins/markets"
    "?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false"
)


def _base_asset(symbol: str) -> str:
    n = normalize_usdt_symbol(symbol)
    if not n:
        return ""
    if n.endswith("USDT"):
        return n[: -len("USDT")]
    if n.endswith("USD"):
        return n[: -len("USD")]
    return n


def _parse_markets(data: Any) -> dict[str, float]:
    m: dict[str, float] = {}
    if not isinstance(data, list):
        return m
    for row in data:
        if not isinstance(row, dict):
            continue
        sym = str(row.get("symbol") or "").strip().upper()
        cap = row.get("market_cap")
        if not sym or cap is None:
            continue
        try:
            val = float(cap)
        except (TypeError, ValueError):
            continue
        if val > 0:
            m[sym] = val
    return m


def _load_disk_cache() -> None:
    global _MAP, _MAP_TS
    if _MAP:
        return
    try:
        if not _CACHE_FILE.is_file():
            return
        raw = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return
        caps = raw.get("caps")
        ts = float(raw.get("ts") or 0)
        parsed = {}
        if isinstance(caps, dict):
            for k, v in caps.items():
                try:
                    parsed[str(k).upper()] = float(v)
                except (TypeError, ValueError):
                    continue
        if parsed:
            _MAP = parsed
            _MAP_TS = ts
    except Exception as exc:  # noqa: BLE001
        logger.debug("读取市值磁盘缓存失败: %s", exc)


def _save_disk_cache() -> None:
    try:
        _CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        payload = {"ts": _MAP_TS, "caps": _MAP}
        _CACHE_FILE.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.debug("写入市值磁盘缓存失败: %s", exc)


def _refresh_map_sync() -> None:
    global _MAP, _MAP_TS
    req = urllib.request.Request(
        _CG_URL,
        headers={"User-Agent": "oi-mornitor-mcap/1.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=18) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    parsed = _parse_markets(data)
    if not parsed:
        raise RuntimeError("CoinGecko 市值响应为空")
    _MAP = parsed
    _MAP_TS = time.time()
    _save_disk_cache()


def ensure_market_cap_map(*, force: bool = False) -> dict[str, float]:
    """同步刷新（TTL 内直接返回）。供梯队划分批量调用。"""
    global _MAP, _MAP_TS
    if _FROZEN and not force:
        return _MAP
    _load_disk_cache()
    stale = force or (time.time() - _MAP_TS > _TTL_SEC) or not _MAP
    if not stale:
        return _MAP
    try:
        _refresh_map_sync()
    except Exception as exc:  # noqa: BLE001
        logger.warning("CoinGecko 市值刷新失败，沿用缓存: %s", exc)
    return _MAP


def market_cap_usd_sync(symbol: str, *, refresh: bool = True) -> float | None:
    """按 base 资产查 USD 市值；仅覆盖 CoinGecko Top250，其余返回 None。"""
    base = _base_asset(symbol).upper()
    if not base:
        return None
    if refresh:
        ensure_market_cap_map()
    else:
        _load_disk_cache()
    return _MAP.get(base)


def reset_market_cap_cache_for_tests(
    caps: dict[str, float] | None = None,
    *,
    ts: float | None = None,
    freeze: bool = True,
) -> None:
    """测试用：注入或清空内存缓存（不写磁盘）。"""
    global _MAP, _MAP_TS, _FROZEN
    _MAP = {str(k).upper(): float(v) for k, v in (caps or {}).items()}
    _MAP_TS = time.time() if ts is None else float(ts)
    _FROZEN = bool(freeze)


async def _refresh_map(session: Any) -> None:
    """保留异步刷新，写入同一份内存缓存。"""
    global _MAP, _MAP_TS
    import aiohttp

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
    parsed = _parse_markets(data)
    if not parsed:
        raise RuntimeError("CoinGecko 市值响应为空")
    _MAP = parsed
    _MAP_TS = time.time()
    _save_disk_cache()


async def market_cap_usd_for_symbol(
    session: Any,
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
                    _load_disk_cache()
                if not _MAP:
                    return None
        return _MAP.get(base)


async def attach_live_market_cap(
    session: Any,
    payload: dict[str, Any],
    symbol: str,
) -> None:
    cap = await market_cap_usd_for_symbol(session, symbol)
    if cap is not None and cap > 0:
        payload["marketCapUsd"] = cap
