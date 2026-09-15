"""回测币种池：Bybit linear 流动性排序 + 最短上市天数 + 主流必含。"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

import aiohttp

from oi_mornitor.config import BYBIT_BASE_URL, PATTERN_STATE_DB
from oi_mornitor.symbol_aliases import is_stablecoin_symbol, normalize_usdt_symbol

logger = logging.getLogger(__name__)

_MAJORS = frozenset({"BTCUSDT", "ETHUSDT", "SOLUSDT"})
_DEFAULT_TOP_N = 200
_DEFAULT_MIN_LISTING_DAYS = 14
_UNIVERSE_DIR = Path(PATTERN_STATE_DB).resolve().parent / "backtest_klines" / "universe"


async def _fetch_instruments(session: aiohttp.ClientSession) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    cursor = ""
    for _ in range(20):
        url = f"{BYBIT_BASE_URL}/v5/market/instruments-info?category=linear&limit=1000"
        if cursor:
            url += f"&cursor={cursor}"
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=25)) as resp:
                if resp.status != 200:
                    break
                payload = await resp.json()
        except Exception as exc:  # noqa: BLE001
            logger.warning("instruments-info 失败: %s", exc)
            break
        if int(payload.get("retCode") or -1) != 0:
            break
        result = payload.get("result") or {}
        for item in result.get("list") or []:
            if str(item.get("quoteCoin") or "") != "USDT":
                continue
            if str(item.get("status") or "") != "Trading":
                continue
            sym = normalize_usdt_symbol(str(item.get("symbol") or ""))
            if not sym or is_stablecoin_symbol(sym):
                continue
            try:
                launch_ms = int(item.get("launchTime") or 0)
            except (TypeError, ValueError):
                launch_ms = 0
            out.append({"symbol": sym, "launchTime": launch_ms})
        cursor = str(result.get("nextPageCursor") or "")
        if not cursor:
            break
    return out


async def _fetch_ticker_map(session: aiohttp.ClientSession) -> dict[str, dict[str, float]]:
    url = f"{BYBIT_BASE_URL}/v5/market/tickers?category=linear"
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=25)) as resp:
            if resp.status != 200:
                return {}
            payload = await resp.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("tickers 失败: %s", exc)
        return {}
    if int(payload.get("retCode") or -1) != 0:
        return {}
    out: dict[str, dict[str, float]] = {}
    for item in (payload.get("result") or {}).get("list") or []:
        sym = normalize_usdt_symbol(str(item.get("symbol") or ""))
        if not sym:
            continue
        try:
            last = float(item.get("lastPrice") or 0)
            turnover = float(item.get("turnover24h") or 0)
            oi = float(item.get("openInterest") or 0)
        except (TypeError, ValueError):
            continue
        if last <= 0:
            continue
        oi_usd = oi * last
        out[sym] = {
            "turnover24h": turnover,
            "openInterest": oi,
            "oiUsd": oi_usd,
            "lastPrice": last,
        }
    return out


def _rank_score(ticker: dict[str, float], *, rank_by: str) -> float:
    turnover = float(ticker.get("turnover24h") or 0)
    oi_usd = float(ticker.get("oiUsd") or 0)
    if rank_by == "oi":
        return oi_usd
    if rank_by == "blend":
        return turnover * 0.65 + oi_usd * 0.35
    return turnover


async def select_backtest_universe(
    session: aiohttp.ClientSession,
    *,
    top_n: int = _DEFAULT_TOP_N,
    min_listing_days: int = _DEFAULT_MIN_LISTING_DAYS,
    rank_by: str = "turnover",
    as_of_ms: int | None = None,
    save_snapshot: bool = True,
) -> dict[str, Any]:
    """按流动性选约 top_n 个 USDT 永续；BTC/ETH/SOL 必含。

    说明：这是「当前截面」名单，用于近 1～2 年回测的简化方案；
    严格时点名单需另存历史 universe 快照（后续扩展）。
    """
    as_of = int(as_of_ms or time.time() * 1000)
    min_age_ms = int(min_listing_days) * 86400 * 1000
    instruments = await _fetch_instruments(session)
    tickers = await _fetch_ticker_map(session)

    eligible: list[dict[str, Any]] = []
    for inst in instruments:
        sym = str(inst["symbol"])
        launch = int(inst.get("launchTime") or 0)
        if launch > 0 and as_of - launch < min_age_ms:
            continue
        tk = tickers.get(sym)
        if not tk:
            continue
        score = _rank_score(tk, rank_by=rank_by)
        if score <= 0 and sym not in _MAJORS:
            continue
        eligible.append(
            {
                "symbol": sym,
                "score": score,
                "launchTime": launch,
                **tk,
            }
        )

    eligible.sort(key=lambda x: float(x.get("score") or 0), reverse=True)
    picked: list[str] = []
    meta: dict[str, Any] = {}
    for row in eligible:
        sym = str(row["symbol"])
        if sym in picked:
            continue
        picked.append(sym)
        meta[sym] = row
        if len(picked) >= top_n:
            break

    for major in sorted(_MAJORS):
        if major not in picked:
            picked.insert(0, major)
            meta[major] = tickers.get(major, {"forced": True})

    payload = {
        "asOfMs": as_of,
        "asOfIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(as_of / 1000)),
        "topN": top_n,
        "minListingDays": min_listing_days,
        "rankBy": rank_by,
        "count": len(picked),
        "symbols": picked,
        "meta": meta,
        "note": "当前截面 top200；非严格历史时点名单，近1～2年回测可接受，长周期注意存活者偏差",
    }
    if save_snapshot:
        _save_universe_snapshot(payload)
    return payload


def _save_universe_snapshot(payload: dict[str, Any]) -> Path:
    _UNIVERSE_DIR.mkdir(parents=True, exist_ok=True)
    ts = int(payload.get("asOfMs") or time.time() * 1000)
    path = _UNIVERSE_DIR / f"universe_{ts}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    latest = _UNIVERSE_DIR / "universe_latest.json"
    latest.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


async def fetch_bybit_linear_symbols(session: aiohttp.ClientSession) -> list[str]:
    instruments = await _fetch_instruments(session)
    return sorted({str(i["symbol"]) for i in instruments})


def load_latest_universe() -> dict[str, Any] | None:
    path = _UNIVERSE_DIR / "universe_latest.json"
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else None
    except Exception:  # noqa: BLE001
        return None
