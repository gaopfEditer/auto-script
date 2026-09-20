"""币安 U 本位永续官方 24h 榜单（顶栏 mercu-header-focus 用）。"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from typing import Any

import aiohttp

from oi_mornitor import http_backoff
from oi_mornitor.config import FAPI_BASE_URL, HTTP_TIMEOUT_SEC, OI_OI_BATCH_CONCURRENCY, proxy_url
from oi_mornitor.http_session import make_http_session
from oi_mornitor.market_snapshot import filter_usdt_perpetuals, oi_usd
from oi_mornitor.symbol_aliases import is_stablecoin_symbol

logger = logging.getLogger(__name__)

TOP_N = int(os.environ.get("BINANCE_LEADERBOARD_TOP", "12"))
REFRESH_SEC = int(os.environ.get("BINANCE_LEADERBOARD_REFRESH_SEC", "900"))
OI_CANDIDATES = int(os.environ.get("BINANCE_LEADERBOARD_OI_CANDIDATES", "24"))


def _fmt_pct(v: float) -> str:
    sign = "+" if v >= 0 else ""
    return f"{sign}{v:.2f}%"


def _fmt_mk(v: float) -> str:
    av = abs(v)
    sign = "-" if v < 0 else ""
    if av >= 1_000_000_000:
        return f"{sign}{av / 1_000_000_000:.2f}B"
    if av >= 1_000_000:
        return f"{sign}{av / 1_000_000:.2f}M"
    if av >= 1_000:
        return f"{sign}{av / 1_000:.2f}K"
    return f"{sign}{av:.0f}"


def _item(symbol: str, rank: int, badge: str, tone: str) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "rank": rank,
        "badge": badge,
        "tone": tone,
    }


def _empty_payload(*, error: str = "") -> dict[str, Any]:
    empty = {k: [] for k in ("gainers", "losers", "hot", "volume", "contract")}
    return {
        "ok": not error,
        "source": "binance",
        "source_label": "Binance U本位永续",
        "updated_at": 0,
        "refresh_sec": REFRESH_SEC,
        "boards": empty,
        "error": error or None,
    }


def _has_board_data(payload: dict[str, Any]) -> bool:
    boards = payload.get("boards")
    if not isinstance(boards, dict):
        return False
    return any(isinstance(v, list) and len(v) > 0 for v in boards.values())


def _parse_rows(tickers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for raw in tickers:
        sym = str(raw.get("symbol") or "")
        if not sym or is_stablecoin_symbol(sym):
            continue
        try:
            pct = float(raw.get("priceChangePercent") or raw.get("price_change_pct_24h") or 0)
            qv = float(raw.get("quoteVolume") or raw.get("quote_volume") or 0)
            price = float(
                raw.get("lastPrice")
                or raw.get("last_price")
                or raw.get("weightedAvgPrice")
                or 0
            )
            count = float(raw.get("count") or 0)
            oi_usd_val = float(raw.get("current_oi_usd") or 0)
        except (TypeError, ValueError):
            continue
        if qv <= 0 or price <= 0:
            continue
        rows.append(
            {
                "symbol": sym,
                "pct": pct,
                "quote_volume": qv,
                "price": price,
                "count": count,
                "oi_usd": oi_usd_val,
            }
        )
    return rows


def _hot_score(row: dict[str, Any]) -> float:
    pct = min(abs(float(row.get("pct") or 0)), 80.0)
    count = max(float(row.get("count") or 0), 0.0)
    qv = max(float(row.get("quote_volume") or 0), 0.0)
    if count <= 0:
        # 雷达快照无 count：用成交额 + 波动近似
        return qv * (1.0 + pct / 20.0)
    vol_boost = math.log10(qv + 1.0)
    return count * (1.0 + pct / 25.0) * (0.6 + 0.4 * min(vol_boost / 9.0, 1.0))


def _build_boards(rows: list[dict[str, Any]], oi_base: dict[str, float]) -> dict[str, list[dict[str, Any]]]:
    gainers = sorted(rows, key=lambda r: r["pct"], reverse=True)[:TOP_N]
    losers = sorted(rows, key=lambda r: r["pct"])[:TOP_N]
    volume = sorted(rows, key=lambda r: r["quote_volume"], reverse=True)[:TOP_N]
    hot = sorted(rows, key=_hot_score, reverse=True)[:TOP_N]

    contract_rows: list[dict[str, Any]] = []
    for row in rows:
        sym = row["symbol"]
        oi_val = float(row.get("oi_usd") or 0)
        if oi_val <= 0 and sym in oi_base:
            oi_val = oi_usd(oi_base[sym], row["price"])
        if oi_val > 0:
            contract_rows.append({**row, "oi_usd": oi_val})
    if not contract_rows:
        candidates = sorted(rows, key=lambda r: r["quote_volume"], reverse=True)[:OI_CANDIDATES]
        for row in candidates:
            sym = row["symbol"]
            oi = oi_base.get(sym)
            if oi is None or oi <= 0:
                continue
            contract_rows.append({**row, "oi_usd": oi_usd(oi, row["price"])})
    contract_rows.sort(key=lambda r: r["oi_usd"], reverse=True)

    hot_badge = lambda r: (
        f"{int(r['count']):,}笔" if float(r.get("count") or 0) > 0 else _fmt_mk(r["quote_volume"])
    )

    return {
        "gainers": [
            _item(r["symbol"], i + 1, _fmt_pct(r["pct"]), "up" if r["pct"] >= 0 else "down")
            for i, r in enumerate(gainers)
        ],
        "losers": [
            _item(r["symbol"], i + 1, _fmt_pct(r["pct"]), "down")
            for i, r in enumerate(losers)
        ],
        "hot": [
            _item(
                r["symbol"],
                i + 1,
                hot_badge(r),
                "up" if r["pct"] >= 0 else "down" if r["pct"] < 0 else "neutral",
            )
            for i, r in enumerate(hot)
        ],
        "volume": [
            _item(r["symbol"], i + 1, _fmt_mk(r["quote_volume"]), "neutral")
            for i, r in enumerate(volume)
        ],
        "contract": [
            _item(r["symbol"], i + 1, _fmt_mk(r["oi_usd"]), "neutral")
            for i, r in enumerate(contract_rows[:TOP_N])
        ],
    }


def boards_from_radar_snapshot(
    all_tickers: list[dict[str, Any]] | None,
    hot_tickers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """雷达已在跑的 ticker/24hr 快照兜底（币安直连失败时）。"""
    rows = _parse_rows(list(all_tickers or []))
    if not rows:
        return _empty_payload(error="radar snapshot empty")
    hot_syms = {str(r.get("symbol") or "") for r in (hot_tickers or []) if r.get("symbol")}
    if hot_syms:
        hot_rows = [r for r in rows if r["symbol"] in hot_syms]
        other = [r for r in rows if r["symbol"] not in hot_syms]
        rows_for_hot = hot_rows + other
    else:
        rows_for_hot = rows
    boards = _build_boards(rows_for_hot, {})
    return {
        "ok": True,
        "source": "binance",
        "source_label": "Binance · 雷达快照兜底",
        "updated_at": int(time.time()),
        "refresh_sec": REFRESH_SEC,
        "symbol_count": len(rows),
        "boards": boards,
        "error": None,
        "fallback": "radar_snapshot",
    }


async def _fetch_open_interest_base(
    session: aiohttp.ClientSession,
    symbols: list[str],
) -> dict[str, float]:
    if not symbols:
        return {}
    base = FAPI_BASE_URL.rstrip("/")
    sem = asyncio.Semaphore(max(4, min(OI_OI_BATCH_CONCURRENCY, 8)))
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT_SEC)
    out: dict[str, float] = {}

    async def _one(sym: str) -> None:
        url = f"{base}/fapi/v1/openInterest?symbol={sym}"
        async with sem:
            status, data = await http_backoff.get_json(
                session,
                url,
                timeout=timeout,
                max_attempts=2,
                label=f"oi-rank:{sym}",
            )
        if status != 200 or not isinstance(data, dict):
            return
        try:
            oi_base = float(data.get("openInterest") or 0)
        except (TypeError, ValueError):
            return
        if oi_base > 0:
            out[sym] = oi_base

    await asyncio.gather(*[_one(s) for s in symbols])
    return out


async def _fetch_boards() -> dict[str, Any]:
    base = FAPI_BASE_URL.rstrip("/")
    url = f"{base}/fapi/v1/ticker/24hr"
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT_SEC)
    px = proxy_url()
    session = make_http_session(trust_env=False, default_proxy=px or None)
    try:
        status, data = await http_backoff.get_json(
            session,
            url,
            timeout=timeout,
            max_attempts=2,
            label="binance-leaderboards-24hr",
            respect_cooldown=False,
        )
        if status != 200 or not isinstance(data, list):
            raise RuntimeError(f"ticker/24hr HTTP {status}")
        tickers = filter_usdt_perpetuals(data)
        rows = _parse_rows(tickers)
        if not rows:
            raise RuntimeError("ticker/24hr empty after filter")

        oi_base: dict[str, float] = {}
        need_oi = [r for r in rows if float(r.get("oi_usd") or 0) <= 0]
        if need_oi:
            vol_top = sorted(need_oi, key=lambda r: r["quote_volume"], reverse=True)[:OI_CANDIDATES]
            oi_base = await _fetch_open_interest_base(session, [r["symbol"] for r in vol_top])
        boards = _build_boards(rows, oi_base)
    finally:
        if not session.closed:
            await session.close()

    return {
        "ok": True,
        "source": "binance",
        "source_label": "Binance U本位永续 · fapi/v1/ticker/24hr",
        "updated_at": int(time.time()),
        "refresh_sec": REFRESH_SEC,
        "symbol_count": len(rows),
        "boards": boards,
        "error": None,
    }


class BinanceLeaderboardsCache:
    def __init__(self) -> None:
        self._payload: dict[str, Any] = _empty_payload()
        self._ts: float = 0.0
        self._lock = asyncio.Lock()

    def _try_radar_fallback(
        self,
        radar_fallback: dict[str, Any] | None,
        *,
        reason: str,
    ) -> dict[str, Any] | None:
        if not radar_fallback:
            return None
        all_t = radar_fallback.get("all_tickers")
        hot_t = radar_fallback.get("hot_tickers")
        fb = boards_from_radar_snapshot(
            all_t if isinstance(all_t, list) else None,
            hot_t if isinstance(hot_t, list) else None,
        )
        if not _has_board_data(fb):
            return None
        if reason:
            fb["error"] = reason
        return fb

    async def get(
        self,
        *,
        force: bool = False,
        radar_fallback: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = time.time()
        if (
            not force
            and _has_board_data(self._payload)
            and now - self._ts < REFRESH_SEC
        ):
            return dict(self._payload)
        async with self._lock:
            now = time.time()
            if (
                not force
                and _has_board_data(self._payload)
                and now - self._ts < REFRESH_SEC
            ):
                return dict(self._payload)

            # 币安全局冷却中：勿阻塞 wait_global_cooldown，直接用雷达快照
            if http_backoff.is_cooling("binance"):
                remain = http_backoff.cooldown_remaining("binance")
                reason = f"Binance 冷却中（≈{remain / 60:.0f}min），雷达快照兜底"
                fb = self._try_radar_fallback(radar_fallback, reason=reason)
                if fb:
                    self._payload = fb
                    self._ts = time.time()
                    return dict(fb)
                if _has_board_data(self._payload):
                    stale = dict(self._payload)
                    stale["error"] = reason
                    return stale

            try:
                self._payload = await _fetch_boards()
                self._ts = time.time()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Binance 榜单拉取失败: %s", exc)
                if _has_board_data(self._payload):
                    stale = dict(self._payload)
                    stale["ok"] = False
                    stale["error"] = str(exc)
                    return stale
                fb = self._try_radar_fallback(radar_fallback, reason=str(exc))
                if fb:
                    self._payload = fb
                    self._ts = time.time()
                    return dict(fb)
                return _empty_payload(error=str(exc))
            return dict(self._payload)


_cache = BinanceLeaderboardsCache()


async def get_binance_leaderboards(
    *,
    force: bool = False,
    radar_fallback: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return await _cache.get(force=force, radar_fallback=radar_fallback)
