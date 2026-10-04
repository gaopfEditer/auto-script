"""已收盘 K 线增量缓存：分页补齐预热根数，后续只拉最近几根。"""
from __future__ import annotations

import logging
import sqlite3
import time
from pathlib import Path
from typing import Any

import aiohttp

from oi_mornitor.config import FAPI_BASE_URL, PATTERN_STATE_DB
from oi_mornitor.exchange_sources import (
    KLINE_SOURCE_PAGE_CAPS,
    _INTERVAL_MS,
    fetch_klines_with_fallback,
)
from oi_mornitor.strategy.params import KLINE_CACHE_MIN_BARS, ema_warmup_bars

logger = logging.getLogger(__name__)

_DEFAULT_DB = Path(PATTERN_STATE_DB).resolve().parent / "kline_cache.db"


class KlineCache:
    def __init__(self, db_path: Path | str | None = None) -> None:
        self.db_path = Path(db_path or _DEFAULT_DB)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def _init(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS klines (
                    symbol TEXT NOT NULL,
                    interval TEXT NOT NULL,
                    open_time INTEGER NOT NULL,
                    open REAL, high REAL, low REAL, close REAL,
                    volume REAL, close_time INTEGER, quote_volume REAL,
                    source TEXT,
                    PRIMARY KEY (symbol, interval, open_time)
                )
                """
            )
            conn.commit()

    def load(
        self,
        symbol: str,
        interval: str,
        *,
        limit: int,
        as_of_ms: int | None = None,
    ) -> list[list[Any]]:
        sym = symbol.strip().upper()
        cutoff = int(as_of_ms if as_of_ms is not None else time.time() * 1000)
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT open_time, open, high, low, close, volume, close_time, quote_volume
                FROM klines
                WHERE symbol=? AND interval=? AND close_time<=?
                ORDER BY open_time DESC
                LIMIT ?
                """,
                (sym, interval, cutoff, int(limit)),
            ).fetchall()
        out = [
            [
                int(r["open_time"]),
                str(r["open"]),
                str(r["high"]),
                str(r["low"]),
                str(r["close"]),
                str(r["volume"]),
                int(r["close_time"] or 0),
                str(r["quote_volume"] or 0),
            ]
            for r in reversed(rows)
        ]
        return out

    def upsert(
        self,
        symbol: str,
        interval: str,
        rows: list[list[Any]],
        *,
        source: str = "",
    ) -> None:
        if not rows:
            return
        sym = symbol.strip().upper()
        payload: list[tuple[Any, ...]] = []
        for row in rows:
            if not isinstance(row, (list, tuple)) or len(row) < 6:
                continue
            try:
                open_ms = int(row[0])
                close_ms = int(row[6]) if len(row) > 6 else open_ms + _INTERVAL_MS.get(interval, 900_000) - 1
                quote = float(row[7]) if len(row) > 7 else 0.0
                payload.append(
                    (
                        sym,
                        interval,
                        open_ms,
                        float(row[1]),
                        float(row[2]),
                        float(row[3]),
                        float(row[4]),
                        float(row[5]),
                        close_ms,
                        quote,
                        source,
                    )
                )
            except (TypeError, ValueError, IndexError):
                continue
        if not payload:
            return
        with self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO klines (
                    symbol, interval, open_time, open, high, low, close,
                    volume, close_time, quote_volume, source
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(symbol, interval, open_time) DO UPDATE SET
                    open=excluded.open, high=excluded.high, low=excluded.low,
                    close=excluded.close, volume=excluded.volume,
                    close_time=excluded.close_time, quote_volume=excluded.quote_volume,
                    source=excluded.source
                """,
                payload,
            )
            conn.commit()

    def last_source(self, symbol: str, interval: str) -> str:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT source FROM klines
                WHERE symbol=? AND interval=?
                ORDER BY open_time DESC LIMIT 1
                """,
                (symbol.strip().upper(), interval),
            ).fetchone()
        return str(row["source"] or "") if row else ""


_CACHE: KlineCache | None = None


def get_kline_cache() -> KlineCache:
    global _CACHE
    if _CACHE is None:
        _CACHE = KlineCache()
    return _CACHE


async def fetch_klines_cached(
    session: aiohttp.ClientSession,
    *,
    symbol: str,
    interval: str,
    min_bars: int | None = None,
    base_url: str | None = None,
    end_time: int | None = None,
) -> tuple[list[list[Any]], str]:
    """读缓存，不足则分页补齐；已够则只拉最近 5 根合并。"""
    want = int(min_bars or max(KLINE_CACHE_MIN_BARS, ema_warmup_bars(676)))
    cache = get_kline_cache()
    as_of = int(end_time if end_time is not None else time.time() * 1000)
    cached = cache.load(symbol, interval, limit=want, as_of_ms=as_of)
    src = cache.last_source(symbol, interval)
    refresh = 8 if cached else want
    fresh, src2 = await fetch_klines_with_fallback(
        session,
        symbol=symbol,
        interval=interval,
        limit=refresh,
        end_time=end_time,
        binance_base_url=base_url or FAPI_BASE_URL,
    )
    if fresh:
        cache.upsert(symbol, interval, fresh, source=src2 or src)
        src = src2 or src
    if len(cached) < want:
        oldest = int(cached[0][0]) if cached else as_of
        need = want - len(cached)
        page_cap = max(KLINE_SOURCE_PAGE_CAPS.values())
        cursor = oldest - 1
        pages = 0
        while need > 0 and pages < 8:
            batch, src3 = await fetch_klines_with_fallback(
                session,
                symbol=symbol,
                interval=interval,
                limit=min(need + 20, page_cap),
                end_time=cursor,
                binance_base_url=base_url or FAPI_BASE_URL,
            )
            pages += 1
            if not batch:
                break
            cache.upsert(symbol, interval, batch, source=src3 or src)
            src = src3 or src
            cursor = int(batch[0][0]) - 1
            need -= len(batch)
            if int(batch[0][0]) >= oldest:
                break
    merged = cache.load(symbol, interval, limit=want, as_of_ms=as_of)
    logger.info(
        "K线缓存 %s %s 来源=%s n=%d want=%d",
        symbol,
        interval,
        src or "unknown",
        len(merged),
        want,
    )
    return merged, src or "unknown"
