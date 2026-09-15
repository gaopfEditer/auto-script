"""回测 K 线分段拉取任务（与扫描分离）。"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

import aiohttp

from oi_mornitor.backtest_common import kline_window_ms, parse_ms, resolve_backtest_symbols
from oi_mornitor.backtest_kline_store import BacktestKlineStore, storage_stats
from oi_mornitor.strategy.structure_signals import STRUCTURE_CARD_INTERVALS

logger = logging.getLogger(__name__)

_DEFAULT_CHUNK_DAYS = 30
_PREFETCH_INTERVALS = sorted(set(STRUCTURE_CARD_INTERVALS) | {"5m"})
_BYBIT_PAGE_SLEEP = 0.3

_jobs: dict[str, "PrefetchJob"] = {}
_jobs_lock = asyncio.Lock()
_MAX_JOBS = 4


@dataclass
class PrefetchJob:
    id: str
    status: str = "pending"
    error: str | None = None
    params: dict[str, Any] = field(default_factory=dict)
    progress: dict[str, Any] = field(default_factory=dict)
    segments: list[dict[str, Any]] = field(default_factory=list)
    started_at: float = 0.0
    finished_at: float = 0.0


def _split_segments(start_ms: int, end_ms: int, chunk_days: int) -> list[tuple[int, int]]:
    chunk_ms = max(1, int(chunk_days)) * 86400 * 1000
    out: list[tuple[int, int]] = []
    cur = int(start_ms)
    end = int(end_ms)
    while cur < end:
        seg_end = min(end, cur + chunk_ms - 1)
        out.append((cur, seg_end))
        cur = seg_end + 1
    return out or [(start_ms, end_ms)]


async def _prefetch_klines(
    session: aiohttp.ClientSession,
    store: BacktestKlineStore,
    *,
    symbols: list[str],
    intervals: list[str],
    start_ms: int,
    end_ms: int,
    progress: dict[str, Any],
    fetch_sem: asyncio.Semaphore,
) -> None:
    from oi_mornitor.exchange_sources import fetch_bybit_klines_range

    need_ivs = sorted(set(intervals) | {"5m"})
    tasks = [(sym, iv) for sym in symbols for iv in need_ivs]
    total = len(tasks)
    progress.update(
        {
            "phase": "fetch",
            "done": 0,
            "total": total,
            "symbols": len(symbols),
            "current": "",
            "source": "bybit",
        }
    )

    async def one(sym: str, iv: str) -> None:
        async with fetch_sem:
            progress["current"] = f"缓存 {sym} {iv}"
            lo, hi = kline_window_ms(iv, start_ms, end_ms)
            sym_norm = sym
            if store.has_sufficient_coverage(sym_norm, iv, lo, hi):
                progress["done"] = int(progress.get("done") or 0) + 1
                return
            fetched = await fetch_bybit_klines_range(
                session,
                symbol=sym_norm,
                interval=iv,
                start_ms=int(lo),
                end_ms=int(hi),
                page_sleep=_BYBIT_PAGE_SLEEP,
                as_of_ms=end_ms,
            )
            if fetched:
                store.upsert_rows(sym_norm, iv, fetched)
            progress["done"] = int(progress.get("done") or 0) + 1

    for coro in asyncio.as_completed([one(sym, iv) for sym, iv in tasks]):
        await coro


def estimate_kline_coverage(
    store: BacktestKlineStore,
    *,
    symbols: list[str],
    intervals: list[str],
    start_ms: int,
    end_ms: int,
) -> dict[str, Any]:
    total = len(symbols) * len(intervals)
    ready = 0
    missing: list[str] = []
    for sym in symbols:
        for iv in intervals:
            lo, hi = kline_window_ms(iv, start_ms, end_ms)
            if store.has_sufficient_coverage(sym, iv, lo, hi):
                ready += 1
            elif len(missing) < 8:
                missing.append(f"{sym}/{iv}")
    ratio = (ready / total) if total else 1.0
    return {
        "total": total,
        "ready": ready,
        "ratio": round(ratio, 4),
        "percent": round(ratio * 100, 1),
        "missingSample": missing,
    }


async def _run_prefetch_job(
    job: PrefetchJob,
    get_pool_rows: Callable[[], list[dict[str, Any]] | None],
) -> None:
    job.status = "running"
    job.started_at = time.time()
    p = job.params
    start_ms = int(p["startMs"])
    end_ms = int(p["endMs"])
    chunk_days = int(p.get("chunkDays") or _DEFAULT_CHUNK_DAYS)
    scope = str(p.get("symbolScope") or "top200")
    max_symbols = int(p.get("maxSymbols") or 200)
    intervals = list(p.get("intervals") or _PREFETCH_INTERVALS)

    store = BacktestKlineStore()
    fetch_sem = asyncio.Semaphore(2)
    segments = _split_segments(start_ms, end_ms, chunk_days)

    try:
        async with aiohttp.ClientSession() as session:
            symbols, universe_meta = await resolve_backtest_symbols(
                session,
                scope=scope,
                max_symbols=max_symbols,
                end_ms=end_ms,
                get_pool_rows=get_pool_rows,
            )
            if not symbols:
                job.status = "failed"
                job.error = "无可用币种"
                job.finished_at = time.time()
                return

            job.params["symbols"] = symbols
            if universe_meta:
                job.params["universe"] = universe_meta

            job.segments = [
                {
                    "index": i,
                    "startMs": lo,
                    "endMs": hi,
                    "status": "pending",
                    "done": 0,
                    "total": 0,
                }
                for i, (lo, hi) in enumerate(segments)
            ]
            tasks_per_seg = len(symbols) * len(intervals)

            for i, (seg_start, seg_end) in enumerate(segments):
                seg = job.segments[i]
                seg["status"] = "running"
                seg["total"] = tasks_per_seg
                seg["done"] = 0
                job.progress = {
                    "phase": "fetch",
                    "segmentIndex": i,
                    "segmentTotal": len(segments),
                    "segmentStartMs": seg_start,
                    "segmentEndMs": seg_end,
                    "done": 0,
                    "total": tasks_per_seg,
                    "symbols": len(symbols),
                    "current": "",
                    "source": "bybit",
                }
                await _prefetch_klines(
                    session,
                    store,
                    symbols=symbols,
                    intervals=intervals,
                    start_ms=seg_start,
                    end_ms=seg_end,
                    progress=job.progress,
                    fetch_sem=fetch_sem,
                )
                seg["done"] = tasks_per_seg
                seg["status"] = "done"

            cov = estimate_kline_coverage(
                store,
                symbols=symbols,
                intervals=intervals,
                start_ms=start_ms,
                end_ms=end_ms,
            )
            job.params["coverage"] = cov
            job.status = "done"
            job.progress = {**job.progress, "phase": "done", "coverage": cov}
    except Exception as exc:  # noqa: BLE001
        logger.exception("K 线拉取失败")
        job.status = "failed"
        job.error = str(exc)
        for seg in job.segments:
            if seg.get("status") == "running":
                seg["status"] = "failed"
    job.finished_at = time.time()


async def start_kline_prefetch(
    params: dict[str, Any],
    *,
    get_pool_rows: Callable[[], list[dict[str, Any]] | None],
) -> PrefetchJob:
    start_ms = parse_ms(params.get("startMs") or params.get("start"))
    end_ms = parse_ms(params.get("endMs") or params.get("end"))
    if start_ms is None or end_ms is None or end_ms <= start_ms:
        raise ValueError("无效拉取时间范围")

    max_days = float(params.get("maxDays") or 1095)
    if (end_ms - start_ms) > max_days * 86400 * 1000:
        raise ValueError(f"拉取跨度不能超过 {int(max_days)} 天")

    chunk_days = int(params.get("chunkDays") or _DEFAULT_CHUNK_DAYS)
    if chunk_days < 7:
        raise ValueError("分段至少 7 天")

    job = PrefetchJob(
        id=uuid.uuid4().hex[:12],
        params={
            "startMs": start_ms,
            "endMs": end_ms,
            "chunkDays": chunk_days,
            "symbolScope": params.get("symbolScope") or "top200",
            "maxSymbols": params.get("maxSymbols") or 200,
            "intervals": params.get("intervals") or _PREFETCH_INTERVALS,
        },
    )

    async with _jobs_lock:
        if len(_jobs) >= _MAX_JOBS:
            oldest = min(_jobs.values(), key=lambda j: j.started_at or 0)
            _jobs.pop(oldest.id, None)
        _jobs[job.id] = job

    asyncio.create_task(_run_prefetch_job(job, get_pool_rows), name=f"kline-prefetch-{job.id}")
    return job


async def check_kline_coverage(
    params: dict[str, Any],
    *,
    get_pool_rows: Callable[[], list[dict[str, Any]] | None],
) -> dict[str, Any]:
    start_ms = parse_ms(params.get("startMs") or params.get("start"))
    end_ms = parse_ms(params.get("endMs") or params.get("end"))
    if start_ms is None or end_ms is None or end_ms <= start_ms:
        raise ValueError("无效时间范围")

    scope = str(params.get("symbolScope") or "top200")
    max_symbols = int(params.get("maxSymbols") or 200)
    intervals = list(params.get("intervals") or _PREFETCH_INTERVALS)
    store = BacktestKlineStore()

    async with aiohttp.ClientSession() as session:
        symbols, universe_meta = await resolve_backtest_symbols(
            session,
            scope=scope,
            max_symbols=max_symbols,
            end_ms=end_ms,
            get_pool_rows=get_pool_rows,
        )
    if not symbols:
        raise ValueError("无可用币种")

    cov = estimate_kline_coverage(
        store,
        symbols=symbols,
        intervals=intervals,
        start_ms=start_ms,
        end_ms=end_ms,
    )
    return {
        "symbols": len(symbols),
        "intervals": intervals,
        "coverage": cov,
        "universe": universe_meta,
        "storageStats": storage_stats(),
    }


def get_prefetch_job(job_id: str) -> PrefetchJob | None:
    return _jobs.get(job_id)


def prefetch_job_to_dict(job: PrefetchJob) -> dict[str, Any]:
    return {
        "id": job.id,
        "status": job.status,
        "error": job.error,
        "params": job.params,
        "progress": job.progress,
        "segments": job.segments,
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
        "storageStats": storage_stats(),
    }
