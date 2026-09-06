"""图表副图：现货净买入、合约净买入（服务端代拉，避开浏览器 CORS / 限频）。"""
from __future__ import annotations

import logging
from typing import Any

import aiohttp

from oi_mornitor import http_backoff
from oi_mornitor.config import HTTP_TIMEOUT_SEC, SPOT_BASE_URL

logger = logging.getLogger("OI_CHART_DERIV")

# openInterestHist / takerlongshortRatio 支持的 period
_DERIV_PERIODS = frozenset(
    {"5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"}
)


def _norm_period(interval: str) -> str:
    s = (interval or "15m").strip().lower()
    if s in _DERIV_PERIODS:
        return s
    if s in ("60m", "60"):
        return "1h"
    if s in ("240m", "240"):
        return "4h"
    return "15m"


async def fetch_spot_net_taker_hist(
    session: aiohttp.ClientSession,
    *,
    symbol: str,
    interval: str,
    limit: int = 500,
    spot_base_url: str | None = None,
) -> list[dict[str, float | int]]:
    """
    现货 K 线 → 净主动买入（base）：2 * takerBuyBase - volume。
    返回 [{time: 秒, value: net}, ...]
    """
    sym = symbol.strip().upper()
    period = _norm_period(interval)
    cap = min(max(int(limit), 1), 1000)
    base = (spot_base_url or SPOT_BASE_URL).rstrip("/")
    url = f"{base}/api/v3/klines?symbol={sym}&interval={period}&limit={cap}"
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT_SEC)
    status, data = await http_backoff.get_json(
        session,
        url,
        timeout=timeout,
        max_attempts=3,
        label=f"spot-net:{sym}",
    )
    if status != 200 or not isinstance(data, list):
        logger.debug("现货净买入拉取失败 %s status=%s", sym, status)
        return []
    out: list[dict[str, float | int]] = []
    for row in data:
        if not isinstance(row, (list, tuple)) or len(row) < 10:
            continue
        try:
            ts_ms = int(row[0])
            vol = float(row[5])
            taker_buy = float(row[9])
        except (TypeError, ValueError):
            continue
        if ts_ms <= 0:
            continue
        # Net = takerBuy - takerSell = 2*takerBuy - volume
        net = 2.0 * taker_buy - vol
        out.append({"time": ts_ms // 1000, "value": net})
    return out


async def fetch_futures_net_taker_hist(
    session: aiohttp.ClientSession,
    *,
    base_url: str,
    symbol: str,
    interval: str,
    limit: int = 500,
) -> list[dict[str, float | int]]:
    """
    takerlongshortRatio → buyVol - sellVol。
    返回 [{time: 秒, value: net}, ...]
    """
    sym = symbol.strip().upper()
    period = _norm_period(interval)
    cap = min(max(int(limit), 1), 500)
    url = (
        f"{base_url.rstrip('/')}/futures/data/takerlongshortRatio"
        f"?symbol={sym}&period={period}&limit={cap}"
    )
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT_SEC)
    status, data = await http_backoff.get_json(
        session,
        url,
        timeout=timeout,
        max_attempts=3,
        label=f"fut-net:{sym}",
    )
    if status != 200 or not isinstance(data, list):
        logger.debug("合约净买入拉取失败 %s status=%s", sym, status)
        return []
    out: list[dict[str, float | int]] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        try:
            ts = int(row.get("timestamp") or 0)
            buy = float(row.get("buyVol") or 0)
            sell = float(row.get("sellVol") or 0)
        except (TypeError, ValueError):
            continue
        if ts <= 0:
            continue
        out.append({"time": ts // 1000, "value": buy - sell})
    return out


def points_to_json(points: list[dict[str, Any]]) -> list[dict[str, float | int]]:
    return [{"time": int(p["time"]), "value": float(p["value"])} for p in points]
