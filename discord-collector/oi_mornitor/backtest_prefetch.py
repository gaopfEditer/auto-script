"""回测 K 线分段拉取任务（与扫描分离）。"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import aiohttp

from oi_mornitor.backtest_common import kline_window_ms, parse_ms, resolve_backtest_symbols, resolve_symbols
from oi_mornitor.backtest_kline_store import BacktestKlineStore, require_parquet_engine, storage_stats
from oi_mornitor.backtest_universe import load_latest_universe
from oi_mornitor.config import BYBIT_BASE_URL, PATTERN_STATE_DB
from oi_mornitor.http_session import http_session_with_fallback
from oi_mornitor.strategy.structure_signals import STRUCTURE_CARD_INTERVALS

logger = logging.getLogger(__name__)

_ROOT = Path(PATTERN_STATE_DB).resolve().parent / "backtest_klines"
_PREFETCH_DIR = _ROOT / "prefetch_jobs"
_LAST_PREFETCH_FILE = _ROOT / "prefetch_last.json"

_DEFAULT_CHUNK_DAYS = 30
_PREFETCH_INTERVALS = sorted(STRUCTURE_CARD_INTERVALS)
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


def _ensure_prefetch_dir() -> None:
    _PREFETCH_DIR.mkdir(parents=True, exist_ok=True)


def _dict_to_job(data: dict[str, Any]) -> PrefetchJob:
    return PrefetchJob(
        id=str(data["id"]),
        status=str(data.get("status") or "pending"),
        error=data.get("error"),
        params=dict(data.get("params") or {}),
        progress=dict(data.get("progress") or {}),
        segments=list(data.get("segments") or []),
        started_at=float(data.get("startedAt") or 0),
        finished_at=float(data.get("finishedAt") or 0),
    )


def _load_job_from_disk(job_id: str) -> PrefetchJob | None:
    path = _PREFETCH_DIR / f"{job_id}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("id"):
            job = _dict_to_job(data)
            return job
    except Exception:  # noqa: BLE001
        logger.warning("读取 prefetch 快照失败 %s", job_id, exc_info=True)
    return None


def _persist_job(job: PrefetchJob) -> None:
    try:
        _ensure_prefetch_dir()
        payload = prefetch_job_to_dict(job)
        (_PREFETCH_DIR / f"{job.id}.json").write_text(
            json.dumps(payload, ensure_ascii=False),
            encoding="utf-8",
        )
        _LAST_PREFETCH_FILE.write_text(
            json.dumps({"id": job.id}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:  # noqa: BLE001
        logger.warning("写入 prefetch 快照失败 %s", job.id, exc_info=True)


async def _periodic_persist(job: PrefetchJob, stop: asyncio.Event) -> None:
    while not stop.is_set():
        _persist_job(job)
        try:
            await asyncio.wait_for(stop.wait(), timeout=3.0)
        except asyncio.TimeoutError:
            pass


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
    segment: dict[str, Any] | None = None,
) -> None:
    from oi_mornitor.exchange_sources import fetch_bybit_klines_range

    need_ivs = sorted(set(intervals))
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
            "barsStored": int(progress.get("barsStored") or 0),
        }
    )

    def _bump_done() -> None:
        n = int(progress.get("done") or 0) + 1
        progress["done"] = n
        if segment is not None:
            segment["done"] = n

    async def one(sym: str, iv: str) -> None:
        async with fetch_sem:
            progress["current"] = f"缓存 {sym} {iv}"
            lo, hi = kline_window_ms(iv, start_ms, end_ms)
            sym_norm = sym
            try:
                if store.has_sufficient_coverage(sym_norm, iv, lo, hi):
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
                    n = store.upsert_rows(sym_norm, iv, fetched)
                    progress["barsStored"] = int(progress.get("barsStored") or 0) + n
                    if segment is not None:
                        segment["barsStored"] = int(segment.get("barsStored") or 0) + n
            except (ImportError, RuntimeError):
                raise
            except Exception:  # noqa: BLE001
                logger.warning("缓存 K 线失败 %s %s", sym, iv, exc_info=True)
            finally:
                _bump_done()

    for coro in asyncio.as_completed([one(sym, iv) for sym, iv in tasks]):
        await coro


def estimate_kline_coverage(
    store: BacktestKlineStore,
    *,
    symbols: list[str],
    intervals: list[str],
    start_ms: int,
    end_ms: int,
    df_cache: dict[tuple[str, str], Any] | None = None,
) -> dict[str, Any]:
    cache = df_cache if df_cache is not None else {}
    total_pairs = len(symbols) * len(intervals)
    ready_pairs = 0
    bars_expected = 0
    bars_stored = 0
    missing: list[str] = []
    for sym in symbols:
        for iv in intervals:
            lo, hi = kline_window_ms(iv, start_ms, end_ms)
            need = store._expected_bars(lo, hi, iv)
            key = (sym, iv)
            if key not in cache:
                cache[key] = store._read_df(sym, iv)
            df = cache[key]
            if df.empty:
                have = 0
            else:
                mask = (df["open_time"] >= int(lo)) & (df["open_time"] <= int(hi))
                have = int(mask.sum())
            bars_expected += need
            bars_stored += min(have, need)
            ready = need <= 0 or have >= int(need * 0.82)
            if ready:
                ready_pairs += 1
            elif len(missing) < 8:
                missing.append(f"{sym}/{iv}")
    pair_ratio = (ready_pairs / total_pairs) if total_pairs else 1.0
    bar_ratio = (bars_stored / bars_expected) if bars_expected else 1.0
    return {
        "total": total_pairs,
        "ready": ready_pairs,
        "ratio": round(pair_ratio, 4),
        "percent": round(pair_ratio * 100, 1),
        "barsExpected": bars_expected,
        "barsStored": bars_stored,
        "barRatio": round(bar_ratio, 4),
        "barPercent": round(bar_ratio * 100, 1),
        "missingSample": missing,
    }


def _should_resume(job: PrefetchJob) -> bool:
    if job.status in ("running", "pending"):
        return True
    err = str(job.error or "")
    return job.status == "failed" and "服务重启" in err


def _same_prefetch_params(
    job: PrefetchJob,
    *,
    start_ms: int,
    end_ms: int,
    chunk_days: int,
    scope: str,
    max_symbols: int,
) -> bool:
    p = job.params
    return (
        int(p.get("startMs") or 0) == int(start_ms)
        and int(p.get("endMs") or 0) == int(end_ms)
        and int(p.get("chunkDays") or 0) == int(chunk_days)
        and str(p.get("symbolScope") or "top200") == str(scope)
        and int(p.get("maxSymbols") or 200) == int(max_symbols)
    )


async def resume_prefetch_job(
    job: PrefetchJob,
    get_pool_rows: Callable[[], list[dict[str, Any]] | None],
) -> PrefetchJob:
    async with _jobs_lock:
        live = _jobs.get(job.id)
        if live is not None and live.status in ("running", "pending"):
            return live
        job.status = "running"
        job.error = None
        job.finished_at = 0.0
        for seg in job.segments:
            if seg.get("status") in ("running", "failed"):
                seg["status"] = "pending"
                seg["done"] = 0
        job.progress = {
            **job.progress,
            "phase": "queued",
            "current": "服务已恢复，继续拉取…",
        }
        _jobs[job.id] = job
        _persist_job(job)
        asyncio.create_task(_run_prefetch_job(job, get_pool_rows), name=f"kline-prefetch-{job.id}")
        logger.info("恢复 K 线拉取 %s", job.id)
        return job


async def maybe_resume_prefetch_job(
    job: PrefetchJob,
    get_pool_rows: Callable[[], list[dict[str, Any]] | None],
) -> PrefetchJob:
    if not _should_resume(job):
        return job
    live = _jobs.get(job.id)
    if live is not None and live.status in ("running", "pending"):
        return live
    return await resume_prefetch_job(job, get_pool_rows)


async def resume_interrupted_prefetch(
    get_pool_rows: Callable[[], list[dict[str, Any]] | None],
) -> PrefetchJob | None:
    job = get_latest_prefetch_job()
    if job is None or not _should_resume(job):
        return None
    return await maybe_resume_prefetch_job(job, get_pool_rows)


async def _run_prefetch_job(
    job: PrefetchJob,
    get_pool_rows: Callable[[], list[dict[str, Any]] | None],
) -> None:
    job.status = "running"
    job.error = None
    if not job.started_at:
        job.started_at = time.time()
    job.progress = {
        **job.progress,
        "phase": "connect",
        "current": job.progress.get("current") or "连接 Bybit…",
        "done": int(job.progress.get("done") or 0),
        "total": int(job.progress.get("total") or 0),
    }
    _persist_job(job)
    p = job.params
    start_ms = int(p["startMs"])
    end_ms = int(p["endMs"])
    chunk_days = int(p.get("chunkDays") or _DEFAULT_CHUNK_DAYS)
    scope = str(p.get("symbolScope") or "top200")
    max_symbols = int(p.get("maxSymbols") or 200)
    intervals = list(p.get("intervals") or _PREFETCH_INTERVALS)

    require_parquet_engine()
    store = BacktestKlineStore()
    fetch_sem = asyncio.Semaphore(2)
    segments = _split_segments(start_ms, end_ms, chunk_days)
    stop_persist = asyncio.Event()
    persist_task = asyncio.create_task(_periodic_persist(job, stop_persist))

    try:
        async with http_session_with_fallback(BYBIT_BASE_URL) as session:
            job.progress = {
                **job.progress,
                "phase": "universe",
                "current": "解析币种池…",
                "source": "bybit",
            }
            _persist_job(job)
            cached_syms = [str(s) for s in (p.get("symbols") or []) if s]
            if len(cached_syms) >= 10:
                symbols = cached_syms
                universe_meta = p.get("universe") if isinstance(p.get("universe"), dict) else None
            else:
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

            if len(job.segments) != len(segments):
                job.segments = [
                    {
                        "index": i,
                        "startMs": lo,
                        "endMs": hi,
                        "status": "pending",
                        "done": 0,
                        "total": 0,
                        "barsStored": 0,
                    }
                    for i, (lo, hi) in enumerate(segments)
                ]
            tasks_per_seg = len(symbols) * len(intervals)

            for i, (seg_start, seg_end) in enumerate(segments):
                seg = job.segments[i]
                if str(seg.get("status") or "") == "done":
                    continue
                seg["status"] = "running"
                seg["total"] = tasks_per_seg
                seg["done"] = 0
                prev_bars = int(job.progress.get("barsStored") or 0)
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
                    "barsStored": prev_bars,
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
                    segment=seg,
                )
                seg["done"] = tasks_per_seg
                seg["status"] = "done"
                cov_seg = estimate_kline_coverage(
                    store,
                    symbols=symbols,
                    intervals=intervals,
                    start_ms=seg_start,
                    end_ms=seg_end,
                )
                seg["barsStored"] = int(cov_seg.get("barsStored") or 0)
                if int(seg.get("barsStored") or 0) <= 0:
                    raise RuntimeError(
                        f"段 {i + 1} 请求已跑完但入库 0 根（Bybit 有数据也写不进本地库）。"
                        "请确认 OI 的 venv 已安装 pyarrow 后重新拉取。"
                    )
                _persist_job(job)

            cov = estimate_kline_coverage(
                store,
                symbols=symbols,
                intervals=intervals,
                start_ms=start_ms,
                end_ms=end_ms,
            )
            job.params["coverage"] = cov
            bars = int(cov.get("barsStored") or 0)
            if bars <= 0:
                raise RuntimeError(
                    "Bybit K 线一根都没拉到（未改直连）。"
                    "请用 curl -x $HTTPS_PROXY https://api.bybit.com/v5/market/time 确认代理可用后再拉。"
                )
            job.status = "done"
            job.progress = {**job.progress, "phase": "done", "coverage": cov}
    except Exception as exc:  # noqa: BLE001
        logger.exception("K 线拉取失败")
        job.status = "failed"
        job.error = str(exc)
        for seg in job.segments:
            if seg.get("status") == "running":
                seg["status"] = "failed"
    finally:
        stop_persist.set()
        await persist_task
    job.finished_at = time.time()
    _persist_job(job)


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

    scope = str(params.get("symbolScope") or "top200")
    max_symbols = int(params.get("maxSymbols") or 200)
    latest = get_latest_prefetch_job()
    if latest is not None and _same_prefetch_params(
        latest,
        start_ms=start_ms,
        end_ms=end_ms,
        chunk_days=chunk_days,
        scope=scope,
        max_symbols=max_symbols,
    ):
        live = _jobs.get(latest.id)
        if live is not None and live.status in ("running", "pending"):
            return live
        if _should_resume(latest):
            return await resume_prefetch_job(latest, get_pool_rows)

    job = PrefetchJob(
        id=uuid.uuid4().hex[:12],
        params={
            "startMs": start_ms,
            "endMs": end_ms,
            "chunkDays": chunk_days,
            "symbolScope": scope,
            "maxSymbols": max_symbols,
            "intervals": params.get("intervals") or _PREFETCH_INTERVALS,
        },
        progress={"phase": "queued", "current": "任务已启动，正在连接行情源…"},
    )

    async with _jobs_lock:
        if len(_jobs) >= _MAX_JOBS:
            oldest = min(_jobs.values(), key=lambda j: j.started_at or 0)
            _jobs.pop(oldest.id, None)
        _jobs[job.id] = job
    _persist_job(job)

    asyncio.create_task(_run_prefetch_job(job, get_pool_rows), name=f"kline-prefetch-{job.id}")
    return job


def estimate_segment_coverage(
    store: BacktestKlineStore,
    *,
    symbols: list[str],
    intervals: list[str],
    start_ms: int,
    end_ms: int,
    chunk_days: int,
    df_cache: dict[tuple[str, str], Any] | None = None,
) -> list[dict[str, Any]]:
    """按拉取分段统计本地库覆盖率（刷新后可恢复「拉到哪里」）。"""
    segments_raw = _split_segments(start_ms, end_ms, chunk_days)
    cache: dict[tuple[str, str], Any] = df_cache if df_cache is not None else {}
    out: list[dict[str, Any]] = []
    for i, (lo, hi) in enumerate(segments_raw):
        cov = estimate_kline_coverage(
            store,
            symbols=symbols,
            intervals=intervals,
            start_ms=lo,
            end_ms=hi,
            df_cache=cache,
        )
        bar_ratio = float(cov.get("barRatio") or 0)
        if bar_ratio >= 0.98:
            seg_status = "done"
        elif bar_ratio > 0:
            seg_status = "partial"
        else:
            seg_status = "pending"
        out.append(
            {
                "index": i,
                "startMs": lo,
                "endMs": hi,
                "ready": cov["ready"],
                "pairTotal": cov["total"],
                "total": cov["barsExpected"],
                "percent": cov["barPercent"],
                "barsExpected": cov["barsExpected"],
                "barsStored": cov["barsStored"],
                "barPercent": cov["barPercent"],
                "status": seg_status,
                "done": cov["barsStored"],
            }
        )
    return out


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
    chunk_days = int(params.get("chunkDays") or 0)
    store = BacktestKlineStore()
    symbols: list[str] = []
    universe_meta: dict[str, Any] | None = None
    cached = load_latest_universe() if scope == "top200" else None
    cached_syms = list((cached or {}).get("symbols") or [])
    if scope == "top200" and len(cached_syms) >= 10:
        symbols = cached_syms
        universe_meta = {
            "count": cached.get("count") if cached else len(cached_syms),
            "asOfIso": cached.get("asOfIso") if cached else None,
            "rankBy": cached.get("rankBy") if cached else None,
            "minListingDays": cached.get("minListingDays") if cached else None,
            "note": cached.get("note") if cached else None,
        }
    elif scope in ("majors", "pool"):
        symbols = resolve_symbols(scope, get_pool_rows())
    else:
        async with http_session_with_fallback(BYBIT_BASE_URL) as session:
            symbols, universe_meta = await resolve_backtest_symbols(
                session,
                scope=scope,
                max_symbols=max_symbols,
                end_ms=end_ms,
                get_pool_rows=get_pool_rows,
            )
    if not symbols:
        raise ValueError("无可用币种")

    def _cpu() -> tuple[dict[str, Any], list[dict[str, Any]] | None, dict[str, Any]]:
        cache: dict[tuple[str, str], Any] = {}
        coverage = estimate_kline_coverage(
            store,
            symbols=symbols,
            intervals=intervals,
            start_ms=start_ms,
            end_ms=end_ms,
            df_cache=cache,
        )
        segs = None
        if chunk_days >= 7:
            segs = estimate_segment_coverage(
                store,
                symbols=symbols,
                intervals=intervals,
                start_ms=start_ms,
                end_ms=end_ms,
                chunk_days=chunk_days,
                df_cache=cache,
            )
        return coverage, segs, storage_stats()

    cov, segs, stats = await asyncio.to_thread(_cpu)
    result: dict[str, Any] = {
        "symbols": len(symbols),
        "intervals": intervals,
        "coverage": cov,
        "universe": universe_meta,
        "storageStats": stats,
    }
    if segs is not None:
        result["segments"] = segs
    return result


def get_prefetch_job(job_id: str) -> PrefetchJob | None:
    job = _jobs.get(job_id)
    if job is not None:
        return job
    return _load_job_from_disk(job_id)


def get_latest_prefetch_job() -> PrefetchJob | None:
    """内存或磁盘上最近一次拉取任务。"""
    if _jobs:
        return max(_jobs.values(), key=lambda j: j.started_at or j.finished_at or 0)
    if _LAST_PREFETCH_FILE.is_file():
        try:
            last_id = json.loads(_LAST_PREFETCH_FILE.read_text(encoding="utf-8")).get("id")
            if last_id:
                return get_prefetch_job(str(last_id))
        except Exception:  # noqa: BLE001
            logger.warning("读取 prefetch_last 失败", exc_info=True)
    return None


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
