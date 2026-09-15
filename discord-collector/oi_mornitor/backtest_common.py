"""回测共享：时间解析、币种池、K 线窗口。"""
from __future__ import annotations

from typing import Any, Callable

import aiohttp

from oi_mornitor.backtest_universe import fetch_bybit_linear_symbols, select_backtest_universe

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
        uni = await select_backtest_universe(session, top_n=max_symbols, as_of_ms=end_ms)
        symbols = list(uni.get("symbols") or [])
        universe_meta = {
            "count": uni.get("count"),
            "asOfIso": uni.get("asOfIso"),
            "rankBy": uni.get("rankBy"),
            "minListingDays": uni.get("minListingDays"),
            "note": uni.get("note"),
        }
    elif scope == "all":
        symbols = await fetch_bybit_linear_symbols(session)
    else:
        symbols = resolve_symbols(scope, get_pool_rows())

    if scope != "top200" and len(symbols) > max_symbols:
        symbols = symbols[:max_symbols]
    elif scope == "top200" and len(symbols) > max_symbols + 3:
        majors = [s for s in symbols if s in _MAJORS]
        rest = [s for s in symbols if s not in _MAJORS][: max(0, max_symbols - len(majors))]
        symbols = majors + rest
    return symbols, universe_meta
