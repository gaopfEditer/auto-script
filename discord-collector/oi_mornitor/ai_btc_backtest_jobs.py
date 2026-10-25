"""Progressive (per-symbol) AI / gate backtest jobs.

POST /api/ai-judge/backtest-btc/run starts a job and returns immediately with job_id.
GET  /api/ai-judge/backtest-btc/job/{id} returns accumulating items + progress.

LLM budget (max_llm_signals / soft_ai_top_n) is global across the whole job:
each symbol gets the remaining quota after prior symbols finish.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from oi_mornitor.btc_1h_backtest import (
    DATA_DIR,
    LATEST_FILE,
    TZ_CN,
    _build_summary,
    _normalize_symbols,
    _normalize_timeframes,
    _persist_result,
    _resolve_window,
    _result_path,
    _cache_key,
    _run_single_symbol_backtest,
    resolve_backtest_symbol,
)

logger = logging.getLogger(__name__)

_JOB_DIR = DATA_DIR / "ai_backtest_jobs"
_LAST_JOB_FILE = _JOB_DIR / "latest.json"
_MAX_JOBS = 6
_jobs: dict[str, "AiBacktestJob"] = {}
_jobs_lock = asyncio.Lock()


def _now_iso() -> str:
    return datetime.now(tz=TZ_CN).isoformat(timespec="seconds")


def _count_hard_judged(items: list[dict[str, Any]]) -> int:
    return sum(
        1
        for x in items
        if x.get("ai_status") == "judged" and not x.get("soft_gate")
    )


def _count_soft_judged(items: list[dict[str, Any]]) -> int:
    return sum(1 for x in items if x.get("ai_status") == "judged" and x.get("soft_gate"))


@dataclass
class AiBacktestJob:
    id: str
    params: dict[str, Any]
    status: str = "running"  # running | done | error
    error: str | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    symbols: list[str] = field(default_factory=list)
    symbol_bases: list[str] = field(default_factory=list)
    timeframes: list[str] = field(default_factory=list)
    items: list[dict[str, Any]] = field(default_factory=list)
    per_symbol: list[dict[str, Any]] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)
    llm_errors: list[str] = field(default_factory=list)
    summary: dict[str, Any] = field(default_factory=dict)
    progress: dict[str, Any] = field(default_factory=dict)
    result_meta: dict[str, Any] = field(default_factory=dict)
    cancelled: bool = False

    @property
    def done(self) -> bool:
        return self.status in ("done", "error")


def _progress_message(job: AiBacktestJob) -> str:
    p = job.progress or {}
    done_n = int(p.get("symbols_done") or 0)
    total = int(p.get("symbols_total") or max(len(job.symbols), 1))
    cur = str(p.get("current_symbol_base") or p.get("current_symbol") or "")
    completed = list(p.get("completed_bases") or [])
    if job.status == "done":
        return f"全部完成（{done_n}/{total}）· {len(job.items)} 条信号"
    if job.status == "error":
        return f"失败：{job.error or 'unknown'}"
    parts = []
    if completed:
        parts.append("、".join(completed) + " 完成")
    if cur:
        parts.append(f"{cur} 进行中")
    else:
        parts.append("排队中")
    parts.append(f"({done_n}/{total})")
    return " · ".join(parts)


def _rebuild_progress(job: AiBacktestJob, *, current: str | None = None, current_base: str | None = None) -> None:
    total = max(len(job.symbols), 1)
    done_n = len(job.per_symbol) + len(job.errors)
    # errors also count as "done" slots; align with symbols processed
    processed_bases = [x.get("symbol_base") or x.get("symbol") for x in job.per_symbol]
    err_bases = []
    for e in job.errors:
        b = resolve_backtest_symbol(e.get("symbol") or "").get("display") or e.get("symbol")
        err_bases.append(b)
    completed = []
    for b in processed_bases + err_bases:
        if b and b not in completed:
            completed.append(b)
    done_n = min(len(completed), total)
    pct = int(round(100.0 * done_n / total)) if total else 0
    if job.status == "done":
        pct = 100
        current = None
        current_base = None
    pending = [b for b in job.symbol_bases if b not in completed]
    if current_base and current_base in pending:
        pending = [x for x in pending if x != current_base]
    job.progress = {
        "symbols_total": total,
        "symbols_done": done_n,
        "current_symbol": current,
        "current_symbol_base": current_base,
        "completed_bases": completed,
        "pending_bases": pending,
        "pct": pct,
        "message": "",  # filled below
        "items_so_far": len(job.items),
    }
    job.progress["message"] = _progress_message(job)


def job_to_dict(job: AiBacktestJob, *, include_items: bool = True) -> dict[str, Any]:
    """Public poll/result payload — compatible with BacktestResponse + progress fields."""
    p = job.params
    meta = job.result_meta or {}
    items = list(job.items) if include_items else []
    summary = dict(job.summary or {})
    if job.per_symbol:
        summary["per_symbol"] = list(job.per_symbol)
    if job.errors:
        summary["symbol_errors"] = list(job.errors)

    ok = True
    top_error = job.error
    if job.status == "error" and not items:
        ok = False
    elif job.status == "done" and not items:
        ok = False
        if job.errors and not top_error:
            top_error = "全部币种回测失败: " + "; ".join(
                f"{e.get('symbol')}: {e.get('error')}" for e in job.errors[:6]
            )
        elif not top_error:
            top_error = "回测无信号：所选区间/周期未产出形态，或行情拉取为空"

    out: dict[str, Any] = {
        "ok": ok,
        "job_id": job.id,
        "status": job.status,
        "done": job.done,
        "async": True,
        "progress": dict(job.progress or {}),
        "generated_at": meta.get("generated_at") or _now_iso(),
        "symbol": meta.get("symbol") or ",".join(job.symbols),
        "symbol_base": meta.get("symbol_base") or "+".join(job.symbol_bases),
        "symbols": list(job.symbols),
        "symbol_bases": list(job.symbol_bases),
        "timeframe": ",".join(job.timeframes),
        "timeframes": list(job.timeframes),
        "days": meta.get("days"),
        "start": meta.get("start"),
        "end": meta.get("end"),
        "skip_llm": bool(p.get("skip_llm")),
        "llm_mode": p.get("llm_mode") if not p.get("skip_llm") else "skipped",
        "max_llm_signals": p.get("max_llm_signals"),
        "soft_ai_top_n": p.get("soft_ai_top_n"),
        "include_tight_sl_signals": bool(p.get("include_tight_sl_signals")),
        "summary": summary,
        "items": items,
        "from_cache": bool(meta.get("from_cache")),
        "errors": list(job.errors),
        "llm_errors": list(job.llm_errors),
        "error": top_error,
        "partial": bool(items) and bool(job.errors),
        "elapsed_sec": round((job.finished_at or time.time()) - job.started_at, 2),
    }
    if not out["progress"].get("message"):
        out["progress"]["message"] = _progress_message(job)
    return out


def _persist_job(job: AiBacktestJob) -> None:
    try:
        _JOB_DIR.mkdir(parents=True, exist_ok=True)
        payload = job_to_dict(job, include_items=True)
        text = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
        (_JOB_DIR / f"{job.id}.json").write_text(text, encoding="utf-8")
        _LAST_JOB_FILE.write_text(
            json.dumps({"id": job.id, "status": job.status, "updated_at": _now_iso()}, ensure_ascii=False),
            encoding="utf-8",
        )
        # Keep global latest in sync so hard-refresh shows partial/complete
        try:
            LATEST_FILE.write_text(text, encoding="utf-8")
        except Exception:  # noqa: BLE001
            logger.debug("write LATEST_FILE failed", exc_info=True)
    except Exception:  # noqa: BLE001
        logger.exception("persist ai backtest job %s failed", job.id)


def _load_job_from_disk(job_id: str) -> AiBacktestJob | None:
    path = _JOB_DIR / f"{job_id}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    job = AiBacktestJob(
        id=job_id,
        params={
            "skip_llm": data.get("skip_llm"),
            "llm_mode": data.get("llm_mode"),
            "max_llm_signals": data.get("max_llm_signals"),
            "soft_ai_top_n": data.get("soft_ai_top_n"),
            "force_refresh": False,
            "start": data.get("start"),
            "end": data.get("end"),
            "days": data.get("days"),
        },
        status=str(data.get("status") or "done"),
        error=data.get("error"),
        symbols=list(data.get("symbols") or []),
        symbol_bases=list(data.get("symbol_bases") or []),
        timeframes=list(data.get("timeframes") or []),
        items=list(data.get("items") or []),
        per_symbol=list((data.get("summary") or {}).get("per_symbol") or []),
        errors=list(data.get("errors") or []),
        llm_errors=list(data.get("llm_errors") or []),
        summary=dict(data.get("summary") or {}),
        progress=dict(data.get("progress") or {}),
        result_meta={
            "generated_at": data.get("generated_at"),
            "symbol": data.get("symbol"),
            "symbol_base": data.get("symbol_base"),
            "days": data.get("days"),
            "start": data.get("start"),
            "end": data.get("end"),
            "from_cache": data.get("from_cache"),
        },
    )
    if job.status == "running":
        # Process died mid-run — mark error so UI stops polling forever
        job.status = "error"
        job.error = job.error or "服务重启，任务中断；请重新运行回测"
        job.finished_at = time.time()
    return job


def get_ai_backtest_job(job_id: str) -> AiBacktestJob | None:
    hit = _jobs.get(job_id)
    if hit is not None:
        return hit
    loaded = _load_job_from_disk(job_id)
    if loaded is None:
        return None
    _jobs[loaded.id] = loaded
    return loaded


async def _try_multi_cache(job: AiBacktestJob) -> dict[str, Any] | None:
    """Reuse multi-symbol disk cache when force_refresh is false."""
    p = job.params
    if p.get("force_refresh"):
        return None
    sym_list = job.symbols
    tfs = job.timeframes
    start_dt, end_dt, _span = _resolve_window(days=p.get("days"), start=p.get("start"), end=p.get("end"))
    include_tight_sl_signals = bool(p.get("include_tight_sl_signals"))
    cache_key = _cache_key("MULTI-" + "-".join(sym_list), tfs, start_dt, end_dt, include_tight_sl_signals=include_tight_sl_signals)
    out_path = _result_path(cache_key)
    if not out_path.exists():
        return None
    try:
        cached = json.loads(out_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    cached_syms = [str(x).upper() for x in (cached.get("symbols") or [])]
    same_window = (
        str(cached.get("start") or "") == start_dt.isoformat(timespec="seconds")
        and str(cached.get("end") or "") == end_dt.isoformat(timespec="seconds")
    )
    if not (
        cached_syms == [s.upper() for s in sym_list]
        and sorted(cached.get("timeframes") or []) == sorted(tfs)
        and same_window
        and cached.get("items")
    ):
        return None
    skip_llm = bool(p.get("skip_llm"))
    items_c = list(cached.get("items") or [])
    need_llm = (not skip_llm) and any(
        x.get("gate_result") == "pass" and not x.get("llm") for x in items_c
    )
    if need_llm:
        # Fall through to live run so LLM attaches progressively
        return None
    cached = dict(cached)
    cached["from_cache"] = True
    return cached


async def _run_job(job: AiBacktestJob) -> None:
    p = job.params
    t0 = job.started_at
    try:
        # Ensure ezcoin on path for provider info
        import sys
        ez = "/Users/maotouying/frontend/code/1.operations/ezcoin-adapter"
        if ez not in sys.path:
            sys.path.insert(0, ez)
        from judge import get_provider_info  # type: ignore

        start_dt, end_dt, span_days = _resolve_window(
            days=p.get("days"), start=p.get("start"), end=p.get("end")
        )
        job.result_meta.update(
            {
                "days": round(span_days, 2),
                "start": start_dt.isoformat(timespec="seconds"),
                "end": end_dt.isoformat(timespec="seconds"),
                "symbol": ",".join(job.symbols),
                "symbol_base": "+".join(job.symbol_bases),
            }
        )

        cached = await _try_multi_cache(job)
        if cached is not None:
            job.items = list(cached.get("items") or [])
            for i, it in enumerate(job.items, start=1):
                it["seq"] = i
            job.summary = dict(cached.get("summary") or {})
            job.per_symbol = list((job.summary.get("per_symbol") or []))
            job.errors = list(cached.get("errors") or [])
            job.result_meta["from_cache"] = True
            job.result_meta["generated_at"] = cached.get("generated_at") or _now_iso()
            job.status = "done"
            job.finished_at = time.time()
            _rebuild_progress(job)
            # Also refresh multi cache latest
            cache_key = _cache_key("MULTI-" + "-".join(job.symbols), job.timeframes, start_dt, end_dt, include_tight_sl_signals=bool(p.get("include_tight_sl_signals")))
            _persist_result(job_to_dict(job), _result_path(cache_key))
            _persist_job(job)
            logger.info("ai-backtest job %s cache hit items=%s", job.id, len(job.items))
            return

        remaining_llm = 0 if p.get("skip_llm") else int(p.get("max_llm_signals") or 0)
        remaining_soft = 0 if p.get("skip_llm") else int(p.get("soft_ai_top_n") or 0)
        force_refresh = bool(p.get("force_refresh"))
        skip_llm = bool(p.get("skip_llm"))
        llm_mode = str(p.get("llm_mode") or "trader_only")

        for api_sym in job.symbols:
            if job.cancelled:
                job.status = "error"
                job.error = "cancelled"
                break
            info = resolve_backtest_symbol(api_sym)
            base = info["display"]
            _rebuild_progress(job, current=info["api_symbol"], current_base=base)
            _persist_job(job)
            logger.info(
                "ai-backtest job %s symbol start %s llm_left=%s soft_left=%s",
                job.id,
                base,
                remaining_llm,
                remaining_soft,
            )
            try:
                one = await _run_single_symbol_backtest(
                    symbol=api_sym,
                    timeframes=job.timeframes,
                    days=p.get("days"),
                    start=p.get("start"),
                    end=p.get("end"),
                    skip_llm=skip_llm,
                    force_refresh=force_refresh,
                    persist=False,
                    llm_mode=llm_mode,
                    max_llm_signals=remaining_llm,
                    soft_ai_top_n=remaining_soft,
                    include_tight_sl_signals=bool(p.get("include_tight_sl_signals")),
                )
            except Exception as e:  # noqa: BLE001
                logger.exception("ai-backtest job %s symbol %s failed", job.id, api_sym)
                job.errors.append({"symbol": api_sym, "error": str(e)})
                _rebuild_progress(job)
                _persist_job(job)
                continue

            if not one.get("ok"):
                job.errors.append({"symbol": api_sym, "error": str(one.get("error") or "failed")})
                _rebuild_progress(job)
                _persist_job(job)
                continue

            items = list(one.get("items") or [])
            job.items.extend(items)
            # re-seq so UI list stays stable-ish as we grow
            job.items.sort(
                key=lambda x: (
                    int(x.get("bar_close_sec") or 0),
                    str(x.get("symbol") or ""),
                    str(x.get("timeframe") or ""),
                )
            )
            for i, it in enumerate(job.items, start=1):
                it["seq"] = i

            sm = one.get("summary") or {}
            job.per_symbol.append(
                {
                    "symbol": one.get("symbol"),
                    "symbol_base": one.get("symbol_base"),
                    "total_signals": sm.get("total_signals", len(items)),
                    "gate_pass_count": sm.get("gate_pass_count", 0),
                    "gate_reject_count": sm.get("gate_reject_count", 0),
                    "gate_pass_rate_pct": sm.get("gate_pass_rate_pct", 0),
                }
            )
            remaining_llm = max(0, remaining_llm - _count_hard_judged(items))
            remaining_soft = max(0, remaining_soft - _count_soft_judged(items))

            job.summary = _build_summary(
                job.items,
                days=span_days,
                elapsed_sec=round(time.time() - t0, 2),
                provider=get_provider_info(),
                window_start=start_dt.strftime("%Y-%m-%d %H:%M"),
                window_end=end_dt.strftime("%Y-%m-%d %H:%M"),
                timeframes=job.timeframes,
                symbol=",".join(job.symbols),
                symbols=job.symbols,
            )
            job.summary["per_symbol"] = list(job.per_symbol)
            if job.errors:
                job.summary["symbol_errors"] = list(job.errors)
            job.result_meta["generated_at"] = _now_iso()
            _rebuild_progress(job)
            _persist_job(job)
            # Progressive multi cache (partial ok)
            try:
                cache_key = _cache_key("MULTI-" + "-".join(job.symbols), job.timeframes, start_dt, end_dt, include_tight_sl_signals=bool(p.get("include_tight_sl_signals")))
                _persist_result(job_to_dict(job), _result_path(cache_key))
            except Exception:  # noqa: BLE001
                logger.debug("partial multi persist failed", exc_info=True)

        if job.status == "running":
            job.status = "done"
        job.finished_at = time.time()
        job.result_meta["generated_at"] = _now_iso()
        # Final summary
        try:
            job.summary = _build_summary(
                job.items,
                days=span_days,
                elapsed_sec=round(time.time() - t0, 2),
                provider=get_provider_info(),
                window_start=start_dt.strftime("%Y-%m-%d %H:%M"),
                window_end=end_dt.strftime("%Y-%m-%d %H:%M"),
                timeframes=job.timeframes,
                symbol=",".join(job.symbols),
                symbols=job.symbols,
            )
            job.summary["per_symbol"] = list(job.per_symbol)
            if job.errors:
                job.summary["symbol_errors"] = list(job.errors)
        except Exception:  # noqa: BLE001
            logger.exception("final summary failed")
        _rebuild_progress(job)
        try:
            cache_key = _cache_key("MULTI-" + "-".join(job.symbols), job.timeframes, start_dt, end_dt, include_tight_sl_signals=bool(p.get("include_tight_sl_signals")))
            _persist_result(job_to_dict(job), _result_path(cache_key))
        except Exception:  # noqa: BLE001
            logger.debug("final multi persist failed", exc_info=True)
        _persist_job(job)
        logger.info(
            "ai-backtest job %s done items=%s errors=%s elapsed=%.1fs",
            job.id,
            len(job.items),
            job.errors,
            time.time() - t0,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("ai-backtest job %s crashed", job.id)
        job.status = "error"
        job.error = str(e)
        job.finished_at = time.time()
        _rebuild_progress(job)
        _persist_job(job)


async def start_ai_backtest_job(
    *,
    symbol: str = "BTCUSDT",
    symbols: Any = None,
    timeframes: Any = None,
    days: int | None = 7,
    start: str | None = None,
    end: str | None = None,
    skip_llm: bool = False,
    force_refresh: bool = False,
    llm_mode: str = "trader_only",
    max_llm_signals: int = 12,
    soft_ai_top_n: int = 0,
    include_tight_sl_signals: bool = False,
) -> AiBacktestJob:
    sym_list = _normalize_symbols(symbols, symbol)
    tfs = _normalize_timeframes(timeframes)
    start_dt, end_dt, span_days = _resolve_window(days=days, start=start, end=end)
    bases: list[str] = []
    for s in sym_list:
        d = resolve_backtest_symbol(s)["display"]
        if d not in bases:
            bases.append(d)

    job = AiBacktestJob(
        id=uuid.uuid4().hex[:12],
        params={
            "symbol": symbol,
            "symbols": sym_list,
            "timeframes": tfs,
            "days": days,
            "start": start,
            "end": end,
            "skip_llm": skip_llm,
            "force_refresh": force_refresh,
            "llm_mode": llm_mode,
            "max_llm_signals": max_llm_signals,
            "soft_ai_top_n": soft_ai_top_n,
            "include_tight_sl_signals": bool(include_tight_sl_signals),
        },
        symbols=sym_list,
        symbol_bases=bases,
        timeframes=tfs,
        result_meta={
            "days": round(span_days, 2),
            "start": start_dt.isoformat(timespec="seconds"),
            "end": end_dt.isoformat(timespec="seconds"),
            "symbol": ",".join(sym_list),
            "symbol_base": "+".join(bases),
            "generated_at": _now_iso(),
        },
    )
    first_base = bases[0] if bases else None
    first_api = resolve_backtest_symbol(sym_list[0])["api_symbol"] if sym_list else None
    _rebuild_progress(job, current=first_api, current_base=first_base)

    async with _jobs_lock:
        if len(_jobs) >= _MAX_JOBS:
            finished = [j for j in _jobs.values() if j.status in ("done", "error")]
            if finished:
                oldest = min(finished, key=lambda j: j.finished_at or j.started_at or 0)
                _jobs.pop(oldest.id, None)
            elif len(_jobs) >= _MAX_JOBS:
                # Cancel oldest running to free slot
                oldest = min(_jobs.values(), key=lambda j: j.started_at or 0)
                oldest.cancelled = True
                _jobs.pop(oldest.id, None)
        _jobs[job.id] = job

    _persist_job(job)
    asyncio.create_task(_run_job(job), name=f"ai-btc-backtest-{job.id}")
    return job
