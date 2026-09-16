"""形态全市场历史回测：结构 + 蜡烛卡片检测，pattern_settle 结算。"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

import aiohttp

from oi_mornitor.backtest_common import kline_window_ms, parse_ms, resolve_backtest_symbols, resolve_local_backtest_symbols
from oi_mornitor.config import BYBIT_BASE_URL
from oi_mornitor.http_session import http_session_with_fallback
from oi_mornitor.backtest_kline_store import BacktestKlineStore, storage_stats
from oi_mornitor.backtest_prefetch import _prefetch_klines
from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.pattern_detector import enrich_indicators
from oi_mornitor.pattern_settle import settle_signal_by_5m_bars
from oi_mornitor.pattern_alert_stats import summarize
from oi_mornitor.strategy.candle_signals import iter_candle_card_hits_in_range
from oi_mornitor.strategy.structure_signals import (
    ENABLE_CURVATURE_DECAY,
    STRUCTURE_CARD_INTERVALS,
    TOP_BEAR_KINDS,
    TOP_KIND_PRIORITY,
    detect_structure_events,
)

CANDLE_KINDS = frozenset({"shooting_star", "consecutive_flat_shooting_star"})

logger = logging.getLogger(__name__)

_WARMUP_BARS = 220
_VERIFY_DELAY_MS = 3 * 60 * 60 * 1000

KIND_OPTIONS: list[dict[str, str]] = [
    {"id": "bottom_secondary_test", "label": "底部二次探底确认", "side": "bull"},
    {"id": "shooting_star", "label": "射击之星", "side": "bear"},
    {"id": "consecutive_flat_shooting_star", "label": "连续走平射击之星", "side": "bear"},
    {"id": "hs_vegas_break", "label": "顶部 · 头肩顶", "side": "bear"},
    {"id": "m_top_vegas_break", "label": "顶部 · M顶", "side": "bear"},
    {"id": "liquidity_sweep", "label": "顶部 · 流动性掠夺", "side": "bear"},
]
if ENABLE_CURVATURE_DECAY:
    KIND_OPTIONS.append({"id": "curvature_decay", "label": "顶部 · 圆弧顶", "side": "bear"})

DEFAULT_KINDS = [k["id"] for k in KIND_OPTIONS]


@dataclass
class BacktestJob:
    id: str
    status: str = "pending"
    error: str | None = None
    params: dict[str, Any] = field(default_factory=dict)
    progress: dict[str, Any] = field(default_factory=dict)
    summary: dict[str, Any] | None = None
    by_kind: list[dict[str, Any]] = field(default_factory=list)
    by_interval: list[dict[str, Any]] = field(default_factory=list)
    items: list[dict[str, Any]] = field(default_factory=list)
    started_at: float = 0.0
    finished_at: float = 0.0


_jobs: dict[str, BacktestJob] = {}
_jobs_lock = asyncio.Lock()
_MAX_JOBS = 8


def list_kind_options() -> list[dict[str, str]]:
    return list(KIND_OPTIONS)


def _pick_signals_on_bar(events: list[dict[str, Any]], bar_index: int) -> list[dict[str, Any]]:
    at = [ev for ev in events if int(ev.get("bar_index", -1)) == bar_index]
    bulls = [ev for ev in at if str(ev.get("side") or "") == "bull"]
    bears = [ev for ev in at if str(ev.get("kind") or "") in TOP_BEAR_KINDS]
    if bulls and bears:
        return []
    picked: list[dict[str, Any]] = list(bulls)
    if bears:
        for kind in TOP_KIND_PRIORITY:
            hit = next((b for b in bears if str(b.get("kind") or "") == kind), None)
            if hit is not None:
                picked.append(hit)
                break
    return picked


def _scan_symbol_interval(
    store: BacktestKlineStore,
    *,
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
    kinds: set[str],
) -> list[dict[str, Any]]:
    lo, hi = kline_window_ms(interval, start_ms, end_ms)
    klines = store.load_rows(symbol, interval, lo, hi)
    if len(klines) < _WARMUP_BARS:
        return []

    df = enrich_indicators(klines_to_df(klines))
    if df.empty or "bb_basis" not in df.columns:
        return []

    structure_kinds = kinds - CANDLE_KINDS
    candle_kinds = kinds & CANDLE_KINDS
    hits: list[dict[str, Any]] = []

    def _append_settled(
        *,
        kind: str,
        type_label: str,
        pattern_label: str,
        side: str,
        signal_at_ms: int,
        entry: float,
        defense: Any,
        extra: dict[str, Any] | None = None,
    ) -> None:
        settle_end = signal_at_ms + _VERIFY_DELAY_MS + 15 * 60_000
        bars_settle = store.load_interval_bars(symbol, "15m", signal_at_ms, settle_end)
        settled = settle_signal_by_5m_bars(
            side=side,
            entry=entry,
            symbol=symbol,
            signal_at_ms=signal_at_ms,
            bars_5m=bars_settle,
            now_ms=settle_end,
        )
        row: dict[str, Any] = {
            "symbol": symbol,
            "interval": interval,
            "kind": kind,
            "typeLabel": type_label,
            "patternLabel": pattern_label,
            "side": side,
            "signalAt": signal_at_ms,
            "entry": entry,
            "defense": defense,
            "outcome": settled.get("outcome"),
            "movePct": settled.get("movePct"),
            "pnlPct": settled.get("pnlPct"),
            "exitPrice": settled.get("exitPrice"),
            "error": settled.get("error"),
        }
        if extra:
            row.update(extra)
        hits.append(row)

    if structure_kinds:
        events = detect_structure_events(df)
        n = len(df)
        for bar_index in range(_WARMUP_BARS, n):
            open_ms = int(df.iloc[bar_index]["open_time"])
            if open_ms < start_ms or open_ms > end_ms:
                continue
            for ev in _pick_signals_on_bar(events, bar_index):
                kind = str(ev.get("kind") or "")
                if kind not in structure_kinds:
                    continue
                row = df.iloc[bar_index]
                _append_settled(
                    kind=kind,
                    type_label=str(ev.get("type_label") or kind),
                    pattern_label=str(ev.get("pattern_label") or ""),
                    side=str(ev.get("side") or ""),
                    signal_at_ms=open_ms,
                    entry=float(row["close"]),
                    defense=ev.get("defense"),
                )

    if candle_kinds:
        allow_shoot = "shooting_star" in candle_kinds
        allow_consec = "consecutive_flat_shooting_star" in candle_kinds
        for ch in iter_candle_card_hits_in_range(
            df,
            start_ms=start_ms,
            end_ms=end_ms,
            kinds=candle_kinds,
            allow_shooting_star=allow_shoot,
            allow_consecutive_shoot=allow_consec,
        ):
            kind = str(ch.get("kind") or "")
            open_ms = int(df.iloc[int(ch["bar_index"])]["open_time"])
            _append_settled(
                kind=kind,
                type_label=str(ch.get("type_label") or kind),
                pattern_label=str(ch.get("text") or ""),
                side=str(ch.get("side") or "bear"),
                signal_at_ms=open_ms,
                entry=float(ch.get("close") or ch.get("price") or 0),
                defense=ch.get("prior_high"),
                extra={
                    "nearVegas": ch.get("near_vegas"),
                    "trendPct": ch.get("trend_pct"),
                    "priorHigh": ch.get("prior_high"),
                },
            )

    return hits


def _pseudo_alerts(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "outcome": it.get("outcome"),
            "movePct": it.get("movePct"),
            "stepPct": 5.0,
            "tradeSymbol": it.get("symbol"),
            "symbol": it.get("symbol"),
        }
        for it in items
    ]


def _summarize_by_interval(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """15m / 1h / 4h 分开统计，不合成总胜率。"""
    order = ["15m", "1h", "4h"]
    groups: dict[str, list[dict[str, Any]]] = {}
    for it in items:
        iv = str(it.get("interval") or "unknown")
        groups.setdefault(iv, []).append(it)
    out: list[dict[str, Any]] = []
    for iv in order:
        bucket = groups.pop(iv, [])
        if not bucket:
            continue
        s = summarize(_pseudo_alerts(bucket))
        out.append({"interval": iv, "count": len(bucket), **s})
    for iv, bucket in sorted(groups.items()):
        s = summarize(_pseudo_alerts(bucket))
        out.append({"interval": iv, "count": len(bucket), **s})
    return out


def _summarize_by_kind(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for it in items:
        key = str(it.get("kind") or "unknown")
        groups.setdefault(key, []).append(it)
    out: list[dict[str, Any]] = []
    for kind, bucket in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        s = summarize(_pseudo_alerts(bucket))
        label = next((k["label"] for k in KIND_OPTIONS if k["id"] == kind), kind)
        out.append({"kind": kind, "label": label, "count": len(bucket), **s})
    return out


async def _run_job(job: BacktestJob, get_pool_rows: Callable[[], list[dict[str, Any]] | None]) -> None:
    job.status = "running"
    job.started_at = time.time()
    p = job.params
    start_ms = int(p["startMs"])
    end_ms = int(p["endMs"])
    intervals = [iv for iv in p.get("intervals") or [] if iv in STRUCTURE_CARD_INTERVALS]
    kinds = set(p.get("kinds") or DEFAULT_KINDS)
    scope = str(p.get("symbolScope") or "top200")
    max_symbols = int(p.get("maxSymbols") or 200)

    skip_fetch = bool(p.get("skipFetch", True))
    store = BacktestKlineStore()

    if skip_fetch:
        symbols, universe_meta = resolve_local_backtest_symbols(
            scope=scope,
            max_symbols=max_symbols,
            get_pool_rows=get_pool_rows,
        )
    else:
        async with http_session_with_fallback(BYBIT_BASE_URL) as session:
            symbols, universe_meta = await resolve_backtest_symbols(
                session,
                scope=scope,
                max_symbols=max_symbols,
                end_ms=end_ms,
                get_pool_rows=get_pool_rows,
            )
            if symbols:
                fetch_sem = asyncio.Semaphore(2)
                job.progress = {"phase": "fetch", "done": 0, "total": 0}
                await _prefetch_klines(
                    session,
                    store,
                    symbols=symbols,
                    intervals=intervals,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    progress=job.progress,
                    fetch_sem=fetch_sem,
                )

    if not symbols:
        job.status = "failed"
        job.error = "无可用币种（pool 为空时可改用 top200 / majors / all）"
        job.finished_at = time.time()
        return
    if universe_meta:
        job.params["universe"] = universe_meta
    job.params["symbols"] = symbols

    tasks = [(sym, iv) for sym in symbols for iv in intervals]
    total = len(tasks)
    job.progress = {
        "phase": "scan",
        "done": 0,
        "total": total,
        "symbols": len(symbols),
        "current": "",
        "source": "bybit",
    }
    all_items: list[dict[str, Any]] = []

    for i, (sym, iv) in enumerate(tasks):
        job.progress["current"] = f"扫描 {sym} {iv}"
        try:
            chunk = await asyncio.to_thread(
                _scan_symbol_interval,
                store,
                symbol=sym,
                interval=iv,
                start_ms=start_ms,
                end_ms=end_ms,
                kinds=kinds,
            )
            if chunk:
                all_items.extend(chunk)
        except Exception as exc:  # noqa: BLE001
            logger.debug("回测扫描失败 %s %s: %s", sym, iv, exc)
        job.progress["done"] = i + 1
        if i % 4 == 3:
            await asyncio.sleep(0)

    all_items.sort(key=lambda x: int(x.get("signalAt") or 0), reverse=True)
    job.items = all_items
    job.by_kind = _summarize_by_kind(all_items)
    job.by_interval = _summarize_by_interval(all_items)
    job.summary = summarize(_pseudo_alerts(all_items))
    job.status = "done"
    job.finished_at = time.time()
    job.progress["current"] = ""


async def start_structure_backtest(
    params: dict[str, Any],
    *,
    get_pool_rows: Callable[[], list[dict[str, Any]] | None],
) -> BacktestJob:
    start_ms = parse_ms(params.get("startMs") or params.get("start"))
    end_ms = parse_ms(params.get("endMs") or params.get("end"))
    if start_ms is None or end_ms is None or end_ms <= start_ms:
        raise ValueError("无效时间范围")
    max_days = float(params.get("maxDays") or 730)
    if (end_ms - start_ms) > max_days * 86400 * 1000:
        raise ValueError(f"时间跨度不能超过 {int(max_days)} 天")

    intervals = params.get("intervals") or list(STRUCTURE_CARD_INTERVALS)
    kinds = params.get("kinds") or DEFAULT_KINDS

    job = BacktestJob(
        id=uuid.uuid4().hex[:12],
        params={
            "startMs": start_ms,
            "endMs": end_ms,
            "intervals": intervals,
            "kinds": kinds,
            "symbolScope": params.get("symbolScope") or "top200",
            "maxSymbols": params.get("maxSymbols") or 200,
            "skipFetch": bool(params.get("skipFetch", True)),
        },
    )

    async with _jobs_lock:
        if len(_jobs) >= _MAX_JOBS:
            oldest = min(_jobs.values(), key=lambda j: j.started_at or 0)
            _jobs.pop(oldest.id, None)
        _jobs[job.id] = job

    asyncio.create_task(_run_job(job, get_pool_rows), name=f"structure-backtest-{job.id}")
    return job


def get_backtest_job(job_id: str) -> BacktestJob | None:
    return _jobs.get(job_id)


def _filter_items(
    items: list[dict[str, Any]],
    *,
    kind_filter: str | None = None,
    interval_filter: str | None = None,
    type_label_filter: str | None = None,
) -> list[dict[str, Any]]:
    out = items
    if kind_filter and kind_filter != "all":
        out = [it for it in out if str(it.get("kind") or "") == kind_filter]
    if type_label_filter and type_label_filter != "all":
        out = [it for it in out if str(it.get("typeLabel") or "") == type_label_filter]
    if interval_filter and interval_filter != "all":
        out = [it for it in out if str(it.get("interval") or "") == interval_filter]
    return out


def job_to_dict(
    job: BacktestJob,
    *,
    page: int = 1,
    page_size: int = 100,
    kind_filter: str | None = None,
    interval_filter: str | None = None,
    type_label_filter: str | None = None,
) -> dict[str, Any]:
    page = max(1, int(page or 1))
    page_size = min(200, max(1, int(page_size or 100)))
    filtered = _filter_items(
        job.items,
        kind_filter=kind_filter,
        interval_filter=interval_filter,
        type_label_filter=type_label_filter,
    )
    total = len(filtered)
    pages = max(1, (total + page_size - 1) // page_size) if total else 1
    if page > pages:
        page = pages
    start = (page - 1) * page_size
    chunk = filtered[start : start + page_size]
    filtered_summary = summarize(_pseudo_alerts(filtered)) if filtered else None
    return {
        "id": job.id,
        "status": job.status,
        "error": job.error,
        "params": job.params,
        "progress": job.progress,
        "summary": job.summary,
        "filteredSummary": filtered_summary,
        "byKind": job.by_kind,
        "byInterval": job.by_interval,
        "items": chunk,
        "total": total,
        "totalAll": len(job.items),
        "page": page,
        "pageSize": page_size,
        "pages": pages,
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
        "settleRules": "BTC/ETH/SOL 100x · 山寨 20x · 默认 ±5% · 信号后 3h · 15m K 线核实",
        "klineSource": "bybit_v5_parquet",
        "storageStats": storage_stats(),
        "kindOptions": KIND_OPTIONS,
    }
