"""回测 K 线本地库：Bybit V5 分页 → Parquet 分区存储，扫描只读本地。"""
from __future__ import annotations

import asyncio
import logging
import sqlite3
from pathlib import Path
from typing import Any

import aiohttp
import pandas as pd

from oi_mornitor.config import PATTERN_STATE_DB
from oi_mornitor.exchange_sources import _INTERVAL_MS, fetch_bybit_klines_range
from oi_mornitor.symbol_aliases import normalize_usdt_symbol

logger = logging.getLogger(__name__)

_ROOT = Path(PATTERN_STATE_DB).resolve().parent / "backtest_klines"
_PARQUET_ROOT = _ROOT / "parquet"
_META_DB = _ROOT / "meta.db"
_BYBIT_PAGE_SLEEP = 0.3

_COLS = [
    "open_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "close_time",
    "quote_volume",
]


def _interval_ms(interval: str) -> int:
    return _INTERVAL_MS.get(interval, 900_000)


def storage_stats() -> dict[str, Any]:
    """估算本地库体量（Parquet 文件数 + 体积）。"""
    if not _PARQUET_ROOT.exists():
        return {"files": 0, "bytes": 0, "path": str(_PARQUET_ROOT)}
    files = list(_PARQUET_ROOT.rglob("*.parquet"))
    total = sum(f.stat().st_size for f in files if f.is_file())
    return {
        "files": len(files),
        "bytes": total,
        "mb": round(total / (1024 * 1024), 1),
        "path": str(_PARQUET_ROOT),
    }


class BacktestKlineStore:
    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root or _ROOT)
        self.parquet_root = self.root / "parquet"
        self.meta_db = self.root / "meta.db"
        self.parquet_root.mkdir(parents=True, exist_ok=True)
        self._init_meta()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.meta_db), timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_meta(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS coverage (
                    symbol TEXT NOT NULL,
                    interval TEXT NOT NULL,
                    min_open_time INTEGER NOT NULL,
                    max_open_time INTEGER NOT NULL,
                    bar_count INTEGER NOT NULL,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (symbol, interval)
                );
                """
            )

    def _parquet_path(self, symbol: str, interval: str) -> Path:
        sym = normalize_usdt_symbol(symbol)
        d = self.parquet_root / sym
        d.mkdir(parents=True, exist_ok=True)
        return d / f"{interval}.parquet"

    def _update_coverage(self, symbol: str, interval: str, df: pd.DataFrame) -> None:
        if df.empty:
            return
        sym = normalize_usdt_symbol(symbol)
        import time as _time

        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO coverage(symbol, interval, min_open_time, max_open_time, bar_count, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(symbol, interval) DO UPDATE SET
                    min_open_time=MIN(coverage.min_open_time, excluded.min_open_time),
                    max_open_time=MAX(coverage.max_open_time, excluded.max_open_time),
                    bar_count=excluded.bar_count,
                    updated_at=excluded.updated_at
                """,
                (
                    sym,
                    interval,
                    int(df["open_time"].min()),
                    int(df["open_time"].max()),
                    int(len(df)),
                    _time.time(),
                ),
            )

    def _read_df(self, symbol: str, interval: str) -> pd.DataFrame:
        path = self._parquet_path(symbol, interval)
        if not path.is_file():
            return pd.DataFrame(columns=_COLS)
        try:
            df = pd.read_parquet(path)
        except Exception as exc:  # noqa: BLE001
            logger.warning("读取 parquet 失败 %s: %s", path, exc)
            return pd.DataFrame(columns=_COLS)
        for col in _COLS:
            if col not in df.columns:
                df[col] = 0
        return df[_COLS].sort_values("open_time").drop_duplicates("open_time", keep="last")

    def count_in_range(
        self,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
    ) -> int:
        df = self._read_df(symbol, interval)
        if df.empty:
            return 0
        mask = (df["open_time"] >= int(start_ms)) & (df["open_time"] <= int(end_ms))
        return int(mask.sum())

    def load_rows(
        self,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
    ) -> list[list[Any]]:
        df = self._read_df(symbol, interval)
        if df.empty:
            return []
        mask = (df["open_time"] >= int(start_ms)) & (df["open_time"] <= int(end_ms))
        chunk = df.loc[mask].sort_values("open_time")
        out: list[list[Any]] = []
        for _, r in chunk.iterrows():
            out.append(
                [
                    int(r["open_time"]),
                    str(r["open"]),
                    str(r["high"]),
                    str(r["low"]),
                    str(r["close"]),
                    str(r["volume"]),
                    int(r["close_time"]),
                    str(r["quote_volume"]),
                ]
            )
        return out

    def upsert_rows(self, symbol: str, interval: str, rows: list[list[Any]]) -> int:
        if not rows:
            return 0
        sym = normalize_usdt_symbol(symbol)
        new_rows = []
        for row in rows:
            try:
                new_rows.append(
                    {
                        "open_time": int(row[0]),
                        "open": float(row[1]),
                        "high": float(row[2]),
                        "low": float(row[3]),
                        "close": float(row[4]),
                        "volume": float(row[5]),
                        "close_time": int(row[6]),
                        "quote_volume": float(row[7]),
                    }
                )
            except (IndexError, TypeError, ValueError):
                continue
        if not new_rows:
            return 0
        new_df = pd.DataFrame(new_rows)
        old_df = self._read_df(sym, interval)
        merged = (
            pd.concat([old_df, new_df], ignore_index=True)
            if not old_df.empty
            else new_df
        )
        merged = merged.sort_values("open_time").drop_duplicates("open_time", keep="last")
        path = self._parquet_path(sym, interval)
        merged.to_parquet(path, index=False, compression="zstd")
        self._update_coverage(sym, interval, merged)
        return len(new_rows)

    def _expected_bars(self, start_ms: int, end_ms: int, interval: str) -> int:
        span = _interval_ms(interval)
        if end_ms <= start_ms or span <= 0:
            return 0
        return max(1, (end_ms - start_ms) // span + 1)

    def has_sufficient_coverage(
        self,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        *,
        ratio: float = 0.82,
    ) -> bool:
        need = self._expected_bars(start_ms, end_ms, interval)
        if need <= 0:
            return True
        have = self.count_in_range(symbol, interval, start_ms, end_ms)
        return have >= int(need * ratio)

    async def ensure_range(
        self,
        session: aiohttp.ClientSession,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        *,
        as_of_ms: int | None = None,
    ) -> int:
        """本地 Parquet 已有足够数据则跳过；否则 Bybit 分页补全。"""
        sym = normalize_usdt_symbol(symbol)
        if self.has_sufficient_coverage(sym, interval, start_ms, end_ms):
            return self.count_in_range(sym, interval, start_ms, end_ms)

        fetched = await fetch_bybit_klines_range(
            session,
            symbol=sym,
            interval=interval,
            start_ms=int(start_ms),
            end_ms=int(end_ms),
            page_sleep=_BYBIT_PAGE_SLEEP,
            as_of_ms=as_of_ms,
        )
        if fetched:
            self.upsert_rows(sym, interval, fetched)
            logger.info(
                "回测 K 线入库 Bybit %s %s +%d → parquet",
                sym,
                interval,
                len(fetched),
            )
        return self.count_in_range(sym, interval, start_ms, end_ms)

    def load_5m_bars(
        self,
        symbol: str,
        signal_at_ms: int,
        end_ms: int,
    ) -> list[dict[str, float]]:
        start_ms = signal_at_ms - 60_000
        rows = self.load_rows(symbol, "5m", start_ms, end_ms)
        return [
            {
                "ts": int(row[0]),
                "high": float(row[2]),
                "low": float(row[3]),
                "close": float(row[4]),
            }
            for row in rows
        ]
