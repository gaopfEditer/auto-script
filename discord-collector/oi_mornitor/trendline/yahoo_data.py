"""Yahoo Finance chart API · 本地缓存 · 可插拔 fallback。"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Callable

import aiohttp
import pandas as pd

from oi_mornitor.breakout_detector import KLINE_COLS, klines_to_df
from oi_mornitor.trendline_config import TRENDLINE_CACHE_DIR, TRENDLINE_YAHOO_HOSTS

logger = logging.getLogger(__name__)

_YAHOO_INTERVAL = {
    "1h": ("1h", "2y"),
    "4h": ("1h", "2y"),  # 聚合
    "1d": ("1d", "5y"),
    "1w": ("1wk", "10y"),
    "1wk": ("1wk", "10y"),
}

_CACHE_TTL_SEC = {
    "1h": 1800,
    "4h": 3600,
    "1d": 7200,
    "1w": 14400,
    "1wk": 14400,
}


def _cache_path(ticker: str, interval: str) -> Path:
    root = Path(TRENDLINE_CACHE_DIR)
    root.mkdir(parents=True, exist_ok=True)
    safe = ticker.replace("/", "_")
    return root / f"yahoo_{safe}_{interval}.json"


def _read_cache(path: Path, ttl: int) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if time.time() - float(raw.get("fetched_at", 0)) > ttl:
            return None
        return raw
    except Exception:  # noqa: BLE001
        return None


def _write_cache(path: Path, payload: dict[str, Any]) -> None:
    try:
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Yahoo 缓存写入失败: %s", exc)


def _aggregate_4h(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    work = df.copy()
    work["dt"] = pd.to_datetime(work["open_time"], unit="ms", utc=True)
    work = work.set_index("dt")
    agg = work.resample("4h", label="left", closed="left").agg(
        {
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
            "volume": "sum",
            "quote_volume": "sum",
        }
    )
    agg = agg.dropna(subset=["open"])
    agg["open_time"] = (agg.index.astype("int64") // 10**6).astype(int)
    span = 4 * 3600 * 1000
    agg["close_time"] = agg["open_time"] + span - 1
    return agg.reset_index(drop=True)


def _chart_to_rows(data: dict[str, Any], interval: str) -> list[list[Any]]:
    result = (data.get("chart") or {}).get("result") or []
    if not result:
        return []
    block = result[0]
    ts_list = block.get("timestamp") or []
    quote = ((block.get("indicators") or {}).get("quote") or [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    vols = quote.get("volume") or []
    rows: list[list[Any]] = []
    interval_ms = {
        "1h": 3600_000,
        "1d": 86400_000,
        "1wk": 7 * 86400_000,
    }.get(interval, 3600_000)
    for i, ts in enumerate(ts_list):
        if ts is None:
            continue
        o, h, l, c = opens[i], highs[i], lows[i], closes[i]
        if o is None or h is None or l is None or c is None:
            continue
        open_ms = int(ts) * 1000
        vol = float(vols[i] or 0)
        close_ms = open_ms + interval_ms - 1
        rows.append([open_ms, o, h, l, c, vol, close_ms, vol * float(c)])
    return rows


async def fetch_yahoo_klines(
    session: aiohttp.ClientSession,
    ticker: str,
    interval: str,
    *,
    fallback: Callable[[], list[list[Any]]] | None = None,
) -> tuple[list[list[Any]], dict[str, Any]]:
    """返回 (binance 形态 klines, meta)。"""
    iv = interval.lower()
    if iv == "1w":
        iv = "1wk"
    y_iv, range_str = _YAHOO_INTERVAL.get(iv, ("1d", "2y"))
    ttl = _CACHE_TTL_SEC.get(iv, 3600)
    cache_file = _cache_path(ticker, iv)
    cached = _read_cache(cache_file, ttl)
    if cached and isinstance(cached.get("rows"), list):
        meta = dict(cached.get("meta") or {})
        meta["staleness_sec"] = int(time.time() - float(cached.get("fetched_at", time.time())))
        return cached["rows"], meta

    rows: list[list[Any]] = []
    source_host = ""
    for host in TRENDLINE_YAHOO_HOSTS:
        url = (
            f"https://{host}/v8/finance/chart/{ticker}"
            f"?interval={y_iv}&range={range_str}"
        )
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=25)) as resp:
                if resp.status != 200:
                    continue
                data = await resp.json()
        except Exception as exc:  # noqa: BLE001
            logger.debug("Yahoo %s 失败: %s", host, exc)
            continue
        rows = _chart_to_rows(data, y_iv)
        if rows:
            source_host = host
            break

    if not rows and fallback:
        rows = fallback()
        source_host = "fallback"

    if not rows:
        return [], {"data_source": "yahoo", "error": "empty", "ticker": ticker, "interval": iv}

    df = klines_to_df(rows)
    if iv == "4h":
        df = _aggregate_4h(df)
        rows = [
            [
                int(r["open_time"]),
                float(r["open"]),
                float(r["high"]),
                float(r["low"]),
                float(r["close"]),
                float(r["volume"]),
                int(r["close_time"]),
                float(r["quote_volume"]),
            ]
            for _, r in df.iterrows()
        ]

    meta = {
        "data_source": "yahoo",
        "yahoo_host": source_host,
        "ticker": ticker,
        "interval": iv,
        "fetched_at": int(time.time()),
        "staleness_sec": 0,
        "bar_count": len(rows),
    }
    _write_cache(
        cache_file,
        {"rows": rows, "meta": meta, "fetched_at": time.time()},
    )
    return rows, meta


def klines_meta_stale(meta: dict[str, Any]) -> bool:
    return int(meta.get("staleness_sec") or 0) > 86400
