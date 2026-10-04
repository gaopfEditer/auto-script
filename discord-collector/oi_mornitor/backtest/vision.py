"""从 data.binance.vision 或公开 K 线接口拉历史（无需密钥）。"""
from __future__ import annotations

import csv
import io
import logging
import zipfile
from datetime import date
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

VISION = "https://data.binance.vision/data"
UA = "oi-mornitor-backtest/1.0"


def _get(url: str, timeout: int = 60) -> bytes:
    req = Request(url, headers={"User-Agent": UA})
    with urlopen(req, timeout=timeout) as resp:
        return resp.read()


def month_range(start: date, end: date) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        out.append((y, m))
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def _parse_klines_csv(raw: bytes) -> list[list[Any]]:
    text = raw.decode("utf-8", errors="replace")
    reader = csv.reader(io.StringIO(text))
    rows: list[list[Any]] = []
    for rec in reader:
        if not rec or rec[0] in ("open_time", "Open time"):
            continue
        try:
            open_ms = int(float(rec[0]))
            rows.append(
                [
                    open_ms,
                    rec[1],
                    rec[2],
                    rec[3],
                    rec[4],
                    rec[5],
                    int(float(rec[6])) if len(rec) > 6 else open_ms,
                    rec[7] if len(rec) > 7 else "0",
                ]
            )
        except (ValueError, IndexError):
            continue
    return rows


def fetch_vision_month(symbol: str, interval: str, year: int, month: int, *, futures: bool = True) -> list[list[Any]]:
    market = "futures/um/monthly/klines" if futures else "spot/monthly/klines"
    name = f"{symbol}-{interval}-{year}-{month:02d}"
    url = f"{VISION}/{market}/{symbol}/{interval}/{name}.zip"
    try:
        blob = _get(url)
    except (HTTPError, URLError) as exc:
        logger.info("vision 未命中 %s: %s", url, exc)
        return []
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        names = zf.namelist()
        if not names:
            return []
        return _parse_klines_csv(zf.read(names[0]))


def fetch_public_klines(
    symbol: str,
    interval: str,
    *,
    start_ms: int,
    end_ms: int,
    futures: bool = True,
) -> list[list[Any]]:
    base = "https://fapi.binance.com/fapi/v1/klines" if futures else "https://data-api.binance.vision/api/v3/klines"
    out: list[list[Any]] = []
    cursor = start_ms
    while cursor < end_ms:
        url = f"{base}?symbol={symbol}&interval={interval}&limit=1500&startTime={cursor}&endTime={end_ms}"
        try:
            raw = _get(url, timeout=30)
        except (HTTPError, URLError) as exc:
            logger.warning("公开 K 线失败 %s: %s", symbol, exc)
            break
        import json

        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, list) or not data:
            break
        for rec in data:
            if not isinstance(rec, list) or len(rec) < 6:
                continue
            out.append(rec[:8] if len(rec) >= 8 else rec)
        last_open = int(data[-1][0])
        nxt = last_open + 1
        if nxt <= cursor:
            break
        cursor = nxt
        if len(data) < 1500:
            break
    return out


def load_history(
    symbol: str,
    interval: str,
    start: date,
    end: date,
    *,
    prefer_futures: bool = True,
) -> tuple[list[list[Any]], str]:
    """返回 (klines, source)。优先 vision 合约月度 zip，失败再试现货 / REST。"""
    rows: dict[int, list[Any]] = {}
    source = ""
    for futures in ((True, False) if prefer_futures else (False, True)):
        got_any = False
        for y, m in month_range(start, end):
            batch = fetch_vision_month(symbol, interval, y, m, futures=futures)
            if batch:
                got_any = True
                source = "vision_um" if futures else "vision_spot"
                for rec in batch:
                    rows[int(rec[0])] = rec
        if got_any:
            break
    if not rows:
        from datetime import datetime, timezone

        start_ms = int(datetime(start.year, start.month, start.day, tzinfo=timezone.utc).timestamp() * 1000)
        end_ms = int(datetime(end.year, end.month, end.day, 23, 59, tzinfo=timezone.utc).timestamp() * 1000)
        for futures in (True, False):
            batch = fetch_public_klines(symbol, interval, start_ms=start_ms, end_ms=end_ms, futures=futures)
            if batch:
                source = "fapi" if futures else "spot_api"
                for rec in batch:
                    rows[int(rec[0])] = rec
                break
    ordered = [rows[k] for k in sorted(rows)]
    return ordered, source or "empty"
