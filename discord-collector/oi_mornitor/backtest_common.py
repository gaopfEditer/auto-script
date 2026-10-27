"""回测共享：时间解析、币种池、K 线窗口。"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

import aiohttp

from oi_mornitor.backtest_universe import (
    fetch_bybit_linear_symbols,
    load_latest_universe,
    select_backtest_universe,
)

logger = logging.getLogger(__name__)

_MAJORS = frozenset({"BTCUSDT", "ETHUSDT", "SOLUSDT"})
_WARMUP_BARS = 220
_VERIFY_DELAY_MS = 3 * 60 * 60 * 1000
_INTERVAL_MS: dict[str, int] = {
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
}


def parse_ms(raw: Any) -> int | None:
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    if n < 1e12:
        n *= 1000
    return int(n)


def kline_window_ms(interval: str, start_ms: int, end_ms: int) -> tuple[int, int]:
    interval_ms = _INTERVAL_MS.get(interval, 900_000)
    if interval == "5m":
        return start_ms - 60_000, end_ms + _VERIFY_DELAY_MS + 5 * 60_000
    need_from = start_ms - _WARMUP_BARS * interval_ms
    need_to = end_ms + interval_ms
    return need_from, need_to


def resolve_local_backtest_symbols(
    *,
    scope: str,
    max_symbols: int,
    get_pool_rows: Callable[[], list[dict[str, Any]] | None],
) -> tuple[list[str], dict[str, Any] | None]:
    """只读本地名单，不访问 Bybit。供 skipFetch 回测使用。"""
    if scope == "top200":
        cached = load_latest_universe()
        symbols = list((cached or {}).get("symbols") or [])
        if len(symbols) > max_symbols + 3:
            majors = [s for s in symbols if s in _MAJORS]
            rest = [s for s in symbols if s not in _MAJORS][: max(0, max_symbols - len(majors))]
            symbols = majors + rest
        if symbols:
            return symbols, {
                "count": (cached or {}).get("count") or len(symbols),
                "asOfIso": (cached or {}).get("asOfIso"),
                "rankBy": (cached or {}).get("rankBy"),
                "minListingDays": (cached or {}).get("minListingDays"),
                "note": (cached or {}).get("note") or "本地快照",
            }
        return sorted(_MAJORS), {"count": 3, "note": "无本地 Top200 快照，已降级 BTC/ETH/SOL"}
    if scope == "all":
        cached = load_latest_universe()
        symbols = list((cached or {}).get("symbols") or [])
        if symbols:
            return symbols, {"count": len(symbols), "note": "本地快照（all）"}
        return sorted(_MAJORS), {"count": 3, "note": "无本地名单，已降级 BTC/ETH/SOL"}
    symbols = resolve_symbols(scope, get_pool_rows())
    if scope != "top200" and len(symbols) > max_symbols:
        symbols = symbols[:max_symbols]
    return symbols, None


def resolve_symbols(scope: str, pool_rows: list[dict[str, Any]] | None) -> list[str]:
    if scope == "majors":
        return sorted(_MAJORS)
    if scope == "pool" and pool_rows:
        syms = [
            str(r.get("symbol") or "").upper()
            for r in pool_rows
            if str(r.get("status") or "") != "warming" and str(r.get("symbol") or "")
        ]
        return sorted(set(syms))
    return []


async def resolve_backtest_symbols(
    session: aiohttp.ClientSession,
    *,
    scope: str,
    max_symbols: int,
    end_ms: int,
    get_pool_rows: Callable[[], list[dict[str, Any]] | None],
) -> tuple[list[str], dict[str, Any] | None]:
    symbols: list[str] = []
    universe_meta: dict[str, Any] | None = None
    if scope == "top200":
        cached = load_latest_universe()
        uni: dict[str, Any] = {}
        try:
            uni = await asyncio.wait_for(
                select_backtest_universe(session, top_n=max_symbols, as_of_ms=end_ms),
                timeout=20.0,
            )
        except (asyncio.TimeoutError, aiohttp.ClientError, RuntimeError) as exc:
            logger.warning("Top200 实时名单失败，改用本地快照: %s", exc)
        if len(uni.get("symbols") or []) < 10 and cached and len(cached.get("symbols") or []) >= 10:
            uni = cached
            uni = {**uni, "note": f"{uni.get('note') or '本地快照'}（实时名单超时）"}
        if not uni.get("symbols"):
            uni = {
                "symbols": sorted(_MAJORS),
                "count": 3,
                "note": "Bybit 名单不可达，已降级 BTC/ETH/SOL",
            }
        symbols = list(uni.get("symbols") or [])
        universe_meta = {
            "count": uni.get("count") or len(symbols),
            "asOfIso": uni.get("asOfIso"),
            "rankBy": uni.get("rankBy"),
            "minListingDays": uni.get("minListingDays"),
            "note": uni.get("note"),
        }
    elif scope == "all":
        try:
            symbols = await asyncio.wait_for(fetch_bybit_linear_symbols(session), timeout=20.0)
        except (asyncio.TimeoutError, aiohttp.ClientError):
            logger.warning("全市场名单超时，降级 BTC/ETH/SOL")
            symbols = sorted(_MAJORS)
    else:
        symbols = resolve_symbols(scope, get_pool_rows())

    if scope != "top200" and len(symbols) > max_symbols:
        symbols = symbols[:max_symbols]
    elif scope == "top200" and len(symbols) > max_symbols + 3:
        majors = [s for s in symbols if s in _MAJORS]
        rest = [s for s in symbols if s not in _MAJORS][: max(0, max_symbols - len(majors))]
        symbols = majors + rest
    return symbols, universe_meta
