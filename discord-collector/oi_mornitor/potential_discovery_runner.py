"""潜力发现：快扫 15m（M2/M3/M5）+ 慢扫 1h/4h（M1/M4）。"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

import aiohttp

from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.config import FAPI_BASE_URL
from oi_mornitor.derivatives_metrics import fetch_premium_index
from oi_mornitor.dormant_ignition import _attach_oi
from oi_mornitor.focus_symbols import normalize_focus_symbol
from oi_mornitor.mcap_market_quote import attach_live_market_cap
from oi_mornitor.mcap_tier import resolve_mcap_tier
from oi_mornitor.pattern_monitor import fetch_open_interest_hist, fetch_pattern_klines_batch
from oi_mornitor.potential_discovery import evaluate_symbol_potential
from oi_mornitor.potential_discovery_config import (
    POTENTIAL_DISCOVERY_ENABLED,
    POTENTIAL_DISCOVERY_KLINE_LIMIT,
    POTENTIAL_DISCOVERY_MAX_SCAN,
    POTENTIAL_FAST_SCAN_SEC,
    POTENTIAL_SOFT_EXPORT_MIN,
    POTENTIAL_SLOW_SCAN_SEC,
)
from oi_mornitor.potential_discovery_store import get_discovery_payload, merge_scan_results
from oi_mornitor.potential_features import SymbolFeed
from oi_mornitor.potential_models_config import load_potential_config
from oi_mornitor.potential_universe import pass_universe
from oi_mornitor.symbol_aliases import is_stablecoin_symbol

logger = logging.getLogger("OI_Radar")

_last_fast = 0.0
_last_slow = 0.0
_last_scan_diag: dict[str, Any] = {}


async def _resolve_http_session(get_session: Callable[[], Any]) -> aiohttp.ClientSession | None:
    """兼容 get_session 返回 ClientSession 或 async _ensure_session() 协程。"""
    session = get_session()
    if asyncio.iscoroutine(session):
        session = await session
    if session is None or isinstance(session, Exception):
        return None
    return session


async def fetch_funding_rates(
    session: aiohttp.ClientSession,
    *,
    base_url: str,
    symbol: str,
    limit: int = 30,
) -> list[float]:
    sym = symbol.strip().upper()
    url = f"{base_url.rstrip('/')}/fapi/v1/fundingRate"
    try:
        async with session.get(
            url,
            params={"symbol": sym, "limit": limit},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status != 200:
                return []
            data = await resp.json()
    except Exception:  # noqa: BLE001
        return []
    if not isinstance(data, list):
        return []
    out: list[float] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        try:
            out.append(float(row.get("fundingRate") or 0))
        except (TypeError, ValueError):
            continue
    return out


def _pool_universe(rows: list[dict[str, Any]], max_n: int) -> list[dict[str, Any]]:
    """全池去重；按 24h 成交额从高到低排序，在扫描循环里再预筛（避免只盯最低成交额 100 个）。"""
    scored: list[tuple[float, dict[str, Any]]] = []
    seen: set[str] = set()
    for r in rows:
        sym = normalize_focus_symbol(str(r.get("symbol") or ""))
        if not sym or sym in seen or is_stablecoin_symbol(sym):
            continue
        seen.add(sym)
        scored.append((float(r.get("quote_volume") or 0), {**r, "symbol": sym}))
    scored.sort(key=lambda x: -x[0])
    cap = max(max_n * 4, 120)
    return [row for _, row in scored[:cap]]


async def _fetch_oi_map(
    session: aiohttp.ClientSession,
    *,
    base_url: str,
    symbols: list[str],
    limit: int,
    intervals: tuple[str, ...] = ("1h", "4h"),
) -> dict[str, dict[int, float]]:
    sem = asyncio.Semaphore(8)
    oi_map: dict[str, dict[int, float]] = {}

    async def _oi_one(sym: str) -> None:
        async with sem:
            for iv in intervals:
                mp = await fetch_open_interest_hist(
                    session,
                    base_url=base_url,
                    symbol=sym,
                    interval=iv,
                    limit=min(limit, 500),
                )
                if mp:
                    oi_map[sym] = mp
                    return

    await asyncio.gather(*[_oi_one(s) for s in symbols[:90]], return_exceptions=True)
    return oi_map


async def _run_scan_profile(
    session: aiohttp.ClientSession,
    *,
    pool_rows: list[dict[str, Any]],
    base_url: str,
    profile: str,
    candle_tfs: tuple[str, ...],
    btc_tfs: tuple[str, ...],
    model_ids: list[str],
    attach_oi_tfs: frozenset[str],
) -> int:
    limit = POTENTIAL_DISCOVERY_KLINE_LIMIT
    eval_cap = max(40, POTENTIAL_DISCOVERY_MAX_SCAN)
    universe = _pool_universe(pool_rows, eval_cap)
    if not universe or not model_ids:
        return 0

    symbols = [str(r["symbol"]).upper() for r in universe]
    kmaps: dict[str, dict[str, list]] = {}
    for tf in candle_tfs:
        kmaps[tf] = await fetch_pattern_klines_batch(
            session,
            base_url=base_url,
            symbols=symbols,
            interval=tf,
            limit=limit,
        )

    btc_maps: dict[str, list] = {}
    for tf in btc_tfs:
        raw = await fetch_pattern_klines_batch(
            session,
            base_url=base_url,
            symbols=["BTCUSDT"],
            interval=tf,
            limit=limit,
        )
        btc_maps[tf] = (raw or {}).get("BTCUSDT") or []

    need_oi = bool(attach_oi_tfs)
    oi_map = (
        await _fetch_oi_map(session, base_url=base_url, symbols=symbols, limit=limit)
        if need_oi
        else {}
    )

    merge_rows: list[tuple[str, dict[str, Any], list]] = []
    n_ok = 0
    n_model_hits = 0
    n_soft_merged = 0
    skip: dict[str, int] = {}

    for row in universe:
        if n_ok >= eval_cap:
            break
        sym = str(row["symbol"]).upper()
        qv = float(row.get("quote_volume") or 0)
        tier_meta: dict[str, Any] = {"id": resolve_mcap_tier(sym)}
        await attach_live_market_cap(session, tier_meta, sym)
        mcap = tier_meta.get("marketCapUsd")
        try:
            mcap_f = float(mcap) if mcap is not None else None
        except (TypeError, ValueError):
            mcap_f = None

        ok, reason = pass_universe(sym, quote_volume_24h=qv, mcap_usd=mcap_f)
        if not ok:
            skip[reason or "skip"] = skip.get(reason or "skip", 0) + 1
            continue

        candles: dict[str, Any] = {}
        min_bars = 60 if profile == "fast" else 80
        for tf in candle_tfs:
            raw = (kmaps.get(tf) or {}).get(sym) or []
            if len(raw) < min_bars:
                continue
            df = klines_to_df(raw)
            if tf in attach_oi_tfs:
                df = _attach_oi(df, oi_map.get(sym))
            candles[tf] = df

        if profile == "fast" and "15m" not in candles and "1h" not in candles:
            skip["kline_fast"] = skip.get("kline_fast", 0) + 1
            continue
        if profile == "slow" and "4h" not in candles and "1h" not in candles:
            skip["kline_slow"] = skip.get("kline_slow", 0) + 1
            continue

        btc_candles = {
            tf: klines_to_df(btc_maps[tf]) for tf in btc_tfs if btc_maps.get(tf)
        }
        rates: list[float] = []
        if "short_squeeze" in model_ids:
            rates = await fetch_funding_rates(session, base_url=base_url, symbol=sym)
            prem = await fetch_premium_index(session, base_url=base_url, symbol=sym)
            if not rates and prem.get("funding_rate") is not None:
                rates = [float(prem["funding_rate"])]

        note_parts: list[str] = []
        if reason == "mcap_unknown":
            note_parts.append("mcap_unknown")
        elif reason == "mcap_tier_out_of_band":
            note_parts.append("mcap_tier_out_of_band")
        feed = SymbolFeed(
            symbol=sym,
            quote_volume_24h=qv,
            mcap_usd=mcap_f,
            funding_rates=rates,
            candles=candles,
            btc_candles=btc_candles,
            notes=" · ".join(note_parts),
            scan_profile=profile,
        )
        results, _cand = evaluate_symbol_potential(
            feed,
            mcap_tier=str(tier_meta.get("id") or "t3"),
            model_ids=model_ids,
        )
        n_model_hits += sum(1 for r in results if r.hit and not r.hard_fail)
        if POTENTIAL_SOFT_EXPORT_MIN > 0:
            n_soft_merged += sum(
                1
                for r in results
                if not r.hard_fail
                and not r.hit
                and float(r.score) >= float(POTENTIAL_SOFT_EXPORT_MIN)
            )
        meta = {
            "mcap_usd": mcap_f,
            "mcap_tier": str(tier_meta.get("id") or "t3"),
            "notes": feed.notes,
        }
        merge_rows.append((sym, meta, results))
        n_ok += 1

    merge_scan_results(
        model_ids=model_ids,
        rows=merge_rows,
        fast_scan=profile == "fast",
        slow_scan=profile == "slow",
    )
    if skip:
        logger.info("潜力%s扫跳过原因: %s", profile, skip)
    logger.info(
        "潜力%s扫统计: 评估 %d 币 · 严格命中 %d · 观察合并 %d · 合并 %d 行",
        profile,
        n_ok,
        n_model_hits,
        n_soft_merged,
        len(merge_rows),
    )
    global _last_scan_diag
    exported = len(get_discovery_payload().get("candidates") or [])
    _last_scan_diag[profile] = {
        "evaluated": n_ok,
        "model_hits": n_model_hits,
        "soft_merged": n_soft_merged,
        "merge_rows": len(merge_rows),
        "skip": dict(skip),
        "exported": exported,
        "at": time.time(),
    }
    return n_ok


def get_potential_scan_diagnostics() -> dict[str, Any]:
    return dict(_last_scan_diag)


async def run_potential_fast_scan(
    session: aiohttp.ClientSession,
    *,
    pool_rows: list[dict[str, Any]],
    base_url: str = FAPI_BASE_URL,
) -> None:
    cfg = load_potential_config()
    models = list(cfg.get("scan", {}).get("fast_models") or [])
    enabled = set(cfg.get("models_enabled") or [])
    model_ids = [m for m in models if m in enabled]
    n = await _run_scan_profile(
        session,
        pool_rows=pool_rows,
        base_url=base_url,
        profile="fast",
        candle_tfs=("15m", "1h"),
        btc_tfs=("15m", "1h"),
        model_ids=model_ids,
        attach_oi_tfs=frozenset({"1h"}),
    )
    exported = len(get_discovery_payload().get("candidates") or [])
    logger.info("潜力快扫(15m档) M2/M3/M5：处理 %d 币 · 看板 %d 条", n, exported)


async def run_potential_slow_scan(
    session: aiohttp.ClientSession,
    *,
    pool_rows: list[dict[str, Any]],
    base_url: str = FAPI_BASE_URL,
) -> None:
    cfg = load_potential_config()
    models = list(cfg.get("scan", {}).get("slow_models") or [])
    enabled = set(cfg.get("models_enabled") or [])
    model_ids = [m for m in models if m in enabled]
    n = await _run_scan_profile(
        session,
        pool_rows=pool_rows,
        base_url=base_url,
        profile="slow",
        candle_tfs=("1h", "4h"),
        btc_tfs=("1h", "4h"),
        model_ids=model_ids,
        attach_oi_tfs=frozenset({"1h", "4h"}),
    )
    exported = len(get_discovery_payload().get("candidates") or [])
    logger.info("潜力慢扫(1h/4h) M1/M4：处理 %d 币 · 看板 %d 条", n, exported)


async def run_potential_discovery_scan(
    session: aiohttp.ClientSession,
    *,
    pool_rows: list[dict[str, Any]],
    base_url: str = FAPI_BASE_URL,
) -> list[dict[str, Any]]:
    """兼容：顺序跑慢扫 + 快扫。"""
    await run_potential_slow_scan(session, pool_rows=pool_rows, base_url=base_url)
    await run_potential_fast_scan(session, pool_rows=pool_rows, base_url=base_url)
    return list(get_discovery_payload().get("candidates") or [])


async def run_potential_discovery_loop(
    is_running: Callable[[], bool],
    *,
    get_pool_rows: Callable[[], list[dict[str, Any]]],
    get_session: Callable[[], Any],
    base_url: str = FAPI_BASE_URL,
) -> None:
    global _last_fast, _last_slow
    if not POTENTIAL_DISCOVERY_ENABLED:
        while is_running():
            await asyncio.sleep(5)
        return

    fast_sec = max(300, POTENTIAL_FAST_SCAN_SEC)
    slow_sec = max(fast_sec, POTENTIAL_SLOW_SCAN_SEC)
    tick = min(60, fast_sec // 3)
    _last_fast = 0.0
    _last_slow = 0.0

    while is_running():
        try:
            session = await _resolve_http_session(get_session)
            if session is None:
                await asyncio.sleep(5)
                continue
            rows = get_pool_rows() or []
            if not rows:
                await asyncio.sleep(tick)
                continue
            now = time.time()
            due_slow = _last_slow <= 0 or (now - _last_slow) >= slow_sec
            due_fast = _last_fast <= 0 or (now - _last_fast) >= fast_sec
            if due_slow:
                await run_potential_slow_scan(session, pool_rows=rows, base_url=base_url)
                _last_slow = time.time()
            elif due_fast:
                await run_potential_fast_scan(session, pool_rows=rows, base_url=base_url)
                _last_fast = time.time()
            try:
                from oi_mornitor.potential_outcome_runner import run_potential_outcome_pass

                await run_potential_outcome_pass(session, base_url=base_url)
            except Exception as exc:  # noqa: BLE001
                logger.debug("潜力信号评判 pass 失败: %s", exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("潜力发现扫描失败: %s", exc)
        await asyncio.sleep(tick)
