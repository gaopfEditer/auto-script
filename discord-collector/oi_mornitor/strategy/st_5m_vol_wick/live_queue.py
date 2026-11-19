"""把 BTC/ETH 已收盘 5m 放量影线（多空）写入报告队列，供 task-os 气泡读取。"""
from __future__ import annotations

import asyncio
import inspect
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

import pandas as pd

from oi_mornitor.pattern_monitor import fetch_pattern_klines_with_source
from oi_mornitor.report_queue import ST_VOL_WICK_SYMBOLS, ingest_st_vol_wick_signals
from oi_mornitor.strategy.st_5m_vol_wick.signals import evaluate_last_closed_bar, klines_to_df

logger = logging.getLogger(__name__)

_INTERVAL_MS = {"5m": 5 * 60 * 1000}
_DEFAULT_SYMBOLS = tuple(sorted(ST_VOL_WICK_SYMBOLS))


async def _resolve_session(get_session: Callable[[], Any]) -> Any:
    session = get_session()
    if inspect.isawaitable(session):
        session = await session
    return session


def _drop_unclosed(df: pd.DataFrame, interval: str, *, now_ms: int) -> pd.DataFrame:
    if df is None or len(df) <= 1:
        return df
    step = _INTERVAL_MS.get(interval)
    if not step:
        return df
    last_open = int(df.iloc[-1]["open_time"])
    if last_open + step > now_ms:
        return df.iloc[:-1].reset_index(drop=True)
    return df


async def _fetch_closed_df(session: Any, *, base_url: str, symbol: str, interval: str, limit: int) -> pd.DataFrame:
    rows, _src = await fetch_pattern_klines_with_source(
        session,
        base_url=base_url,
        symbol=symbol,
        interval=interval,
        limit=limit,
    )
    df = klines_to_df(rows)
    return _drop_unclosed(df, interval, now_ms=int(time.time() * 1000))


async def evaluate_symbol_once(
    session: Any,
    *,
    base_url: str,
    symbol: str,
    last_bars: dict[str, int],
) -> dict[str, Any] | None:
    """评估该币上一根已收盘 5m；同一根只评一次。未触发也记下 bar，避免重复计算。"""
    df5 = await _fetch_closed_df(session, base_url=base_url, symbol=symbol, interval="5m", limit=240)
    if len(df5) < 20:
        return None
    bar_ts = int(df5.iloc[-1]["open_time"])
    if last_bars.get(symbol) == bar_ts:
        return None
    ev = evaluate_last_closed_bar(df5, symbol=symbol)
    last_bars[symbol] = bar_ts
    return ev


async def poll_once(
    session: Any,
    *,
    base_url: str,
    symbols: tuple[str, ...] | list[str] = _DEFAULT_SYMBOLS,
    last_bars: dict[str, int] | None = None,
) -> int:
    state = last_bars if last_bars is not None else {}
    ingested = 0
    for symbol in symbols:
        try:
            ev = await evaluate_symbol_once(
                session,
                base_url=base_url,
                symbol=symbol,
                last_bars=state,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("5m 放量影线拉取失败 %s: %s", symbol, exc)
            continue
        if ev and ev.get("triggered"):
            n = ingest_st_vol_wick_signals([ev])
            ingested += n
            if n:
                logger.info(
                    "5m 放量影线入队 %s side=%s pattern=%s vol=%.2f",
                    symbol,
                    ev.get("side"),
                    ev.get("pattern"),
                    ev.get("volumeRatio") or 0,
                )
    return ingested


async def run_st_vol_wick_queue_loop(
    is_running: Callable[[], bool],
    *,
    get_session: Callable[[], Any] | Callable[[], Awaitable[Any]],
    base_url: str,
    interval_sec: float = 20.0,
    symbols: tuple[str, ...] | list[str] = _DEFAULT_SYMBOLS,
) -> None:
    delay = max(10.0, float(interval_sec))
    last_bars: dict[str, int] = {}
    while is_running():
        try:
            session = await _resolve_session(get_session)
            if session is not None:
                await poll_once(
                    session,
                    base_url=base_url,
                    symbols=symbols,
                    last_bars=last_bars,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("5m 放量影线入队循环失败: %s", exc)
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            raise
