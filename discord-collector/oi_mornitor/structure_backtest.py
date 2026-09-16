"""形态全市场历史回测：结构 + 蜡烛卡片检测，pattern_settle 结算。"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from oi_mornitor.backtest_card_funnel import (
    CardFunnelState,
    alt_eligible_at,
    build_daily_alt_pools,
    build_live_scan_jobs,
    interval_allowed_for_job,
    live_funnel_meta,
    structure_interval_ok,
    union_alt_symbols,
)
from oi_mornitor.backtest_common import kline_window_ms, parse_ms, resolve_backtest_symbols, resolve_local_backtest_symbols
from oi_mornitor.config import (
    BYBIT_BASE_URL,
    CARD_PUSH_COOLDOWN_BARS,
    CANDLE_CARD_MAJOR_SYMBOLS,
    FAPI_BASE_URL,
    PATTERN_STATE_DB,
)
from oi_mornitor.http_session import http_session_with_fallback, make_http_session, proxy_url
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
    STRUCTURE_PUSH_COOLDOWN_BARS,
    TOP_BEAR_KINDS,
    TOP_KIND_PRIORITY,
    detect_structure_events,
    filter_structure_card_hits,
)

CANDLE_KINDS = frozenset({"shooting_star", "consecutive_flat_shooting_star"})

logger = logging.getLogger(__name__)

_WARMUP_BARS = 220
_VERIFY_DELAY_MS = 3 * 60 * 60 * 1000
_5M_MS = 300_000
_DAY_MS = 86_400_000
_INTERVAL_SECONDS = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400}
_MAJORS = {s.upper() for s in CANDLE_CARD_MAJOR_SYMBOLS}

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
_JOB_DIR = Path(PATTERN_STATE_DB).resolve().parent / "backtest_klines" / "structure_jobs"
_LAST_JOB_FILE = _JOB_DIR / "latest.json"
_INDEX_FILE = _JOB_DIR / "index.json"
_MAX_LIST = 40


def list_kind_options() -> list[dict[str, str]]:
    return list(KIND_OPTIONS)


def _ensure_job_dir() -> None:
    _JOB_DIR.mkdir(parents=True, exist_ok=True)


def _make_list_row(
    *,
    job_id: str,
    status: str,
    error: str | None,
    params: dict[str, Any] | None,
    summary: dict[str, Any] | None,
    started_at: float,
    finished_at: float,
    item_count: int = 0,
) -> dict[str, Any]:
    params = params or {}
    summary = summary if isinstance(summary, dict) else {}
    total = summary.get("total")
    if total is None:
        total = item_count
    return {
        "id": job_id,
        "status": status,
        "error": error,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "startMs": params.get("startMs"),
        "endMs": params.get("endMs"),
        "intervals": list(params.get("intervals") or []),
        "partial": bool(params.get("partial")),
        "total": int(total or 0),
        "winRate": summary.get("winRate"),
        "totalPnlPct": summary.get("totalPnlPct"),
        "wins": summary.get("wins"),
        "losses": summary.get("losses"),
    }


def _list_row_from_payload(data: dict[str, Any]) -> dict[str, Any]:
    items = data.get("items")
    return _make_list_row(
        job_id=str(data.get("id") or ""),
        status=str(data.get("status") or "pending"),
        error=data.get("error"),
        params=data.get("params") if isinstance(data.get("params"), dict) else {},
        summary=data.get("summary") if isinstance(data.get("summary"), dict) else None,
        started_at=float(data.get("startedAt") or 0),
        finished_at=float(data.get("finishedAt") or 0),
        item_count=len(items) if isinstance(items, list) else 0,
    )


def _list_row_from_job(job: BacktestJob) -> dict[str, Any]:
    return _make_list_row(
        job_id=job.id,
        status=job.status,
        error=job.error,
        params=job.params,
        summary=job.summary,
        started_at=job.started_at,
        finished_at=job.finished_at,
        item_count=len(job.items),
    )


def _upsert_index_row(row: dict[str, Any]) -> None:
    job_id = str(row.get("id") or "")
    if not job_id:
        return
    _ensure_job_dir()
    rows: list[dict[str, Any]] = []
    if _INDEX_FILE.is_file():
        try:
            raw = json.loads(_INDEX_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                rows = [r for r in raw if isinstance(r, dict) and str(r.get("id") or "") != job_id]
        except Exception:  # noqa: BLE001
            rows = []
    rows.append(row)
    rows.sort(key=lambda r: float(r.get("startedAt") or 0), reverse=True)
    _INDEX_FILE.write_text(
        json.dumps(rows[:_MAX_LIST], ensure_ascii=False),
        encoding="utf-8",
    )


def _job_snapshot(job: BacktestJob) -> dict[str, Any]:
    return {
        "id": job.id,
        "status": job.status,
        "error": job.error,
        "params": dict(job.params),
        "progress": dict(job.progress),
        "summary": dict(job.summary) if isinstance(job.summary, dict) else job.summary,
        "byKind": list(job.by_kind),
        "byInterval": list(job.by_interval),
        "items": list(job.items),
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
    }


def _dict_to_job(data: dict[str, Any]) -> BacktestJob:
    return BacktestJob(
        id=str(data["id"]),
        status=str(data.get("status") or "pending"),
        error=data.get("error"),
        params=dict(data.get("params") or {}),
        progress=dict(data.get("progress") or {}),
        summary=data.get("summary") if isinstance(data.get("summary"), dict) else None,
        by_kind=list(data.get("byKind") or []),
        by_interval=list(data.get("byInterval") or []),
        items=list(data.get("items") or []),
        started_at=float(data.get("startedAt") or 0),
        finished_at=float(data.get("finishedAt") or 0),
    )


def _write_job_snapshot(payload: dict[str, Any]) -> None:
    job_id = str(payload.get("id") or "")
    if not job_id:
        return
    _ensure_job_dir()
    row = _list_row_from_payload(payload)
    (_JOB_DIR / f"{job_id}.meta.json").write_text(
        json.dumps(row, ensure_ascii=False),
        encoding="utf-8",
    )
    _upsert_index_row(row)
    _LAST_JOB_FILE.write_text(
        json.dumps({"id": job_id}, ensure_ascii=False),
        encoding="utf-8",
    )
    (_JOB_DIR / f"{job_id}.json").write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )


def _persist_job(job: BacktestJob) -> None:
    try:
        _write_job_snapshot(_job_snapshot(job))
    except Exception:  # noqa: BLE001
        logger.warning("写入回测快照失败 %s", job.id, exc_info=True)


async def _persist_job_async(job: BacktestJob) -> None:
    snapshot = _job_snapshot(job)
    try:
        await asyncio.to_thread(_write_job_snapshot, snapshot)
    except Exception:  # noqa: BLE001
        logger.warning("写入回测快照失败 %s", job.id, exc_info=True)


def _load_job_from_disk(job_id: str) -> BacktestJob | None:
    path = _JOB_DIR / f"{job_id}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not data.get("id"):
            return None
        job = _dict_to_job(data)
        if job.status in ("running", "pending") and job.id not in _jobs:
            prog = job.progress if isinstance(job.progress, dict) else {}
            done = int(prog.get("done") or 0)
            total = int(prog.get("total") or 0)
            phase = str(prog.get("phase") or "")
            if job.items:
                job.status = "done"
                job.params = {**job.params, "partial": True}
                job.progress = {**prog, "current": "扫描中断，以下为已扫部分"}
            elif done > 0 or phase in ("fetch5m", "fetch", "scan", "prepare"):
                job.status = "failed"
                job.error = (
                    f"回测进程已重启（阶段 {phase or '?'} · "
                    f"进度 {done}/{total or '?'}）。请重新点击「开始回测」"
                )
            else:
                job.status = "failed"
                job.error = "回测中断，请重新点击「开始回测」"
            _persist_job(job)
        return job
    except Exception:  # noqa: BLE001
        logger.warning("读取回测快照失败 %s", job_id, exc_info=True)
        return None


def _refresh_live_stats(job: BacktestJob) -> None:
    items = job.items
    if items:
        items.sort(key=lambda x: int(x.get("signalAt") or 0), reverse=True)
        job.summary = summarize(_pseudo_alerts(items))
        job.by_kind = _summarize_by_kind(items)
        job.by_interval = _summarize_by_interval(items)
    else:
        job.summary = None
        job.by_kind = []
        job.by_interval = []


def _bar_close_ms(row: Any) -> int:
    try:
        ct = int(row["close_time"])
        if ct > 0:
            return ct
    except (TypeError, ValueError, KeyError):
        pass
    return int(row["open_time"])


def _align_signal_at_ms(close_time_ms: int) -> int:
    """收盘后对齐到下一根 5m open，与 live scan_ts + 5m 核实网格一致。"""
    if close_time_ms <= 0:
        return close_time_ms
    return ((close_time_ms // _5M_MS) + 1) * _5M_MS


def _cooldown_blocked(
    last_emit: dict[str, int],
    key: str,
    *,
    bar_close_sec: int,
    interval: str,
    cooldown_bars: int,
) -> bool:
    if cooldown_bars <= 0:
        return False
    last = last_emit.get(key)
    if last is None:
        return False
    bar_sec = _INTERVAL_SECONDS.get(interval)
    if not bar_sec:
        return False
    return (int(bar_close_sec) - int(last)) <= cooldown_bars * bar_sec


async def _ensure_symbol_settle_5m(
    session: Any,
    store: BacktestKlineStore,
    *,
    symbol: str,
    start_ms: int,
    end_ms: int,
    live_funnel: bool,
) -> None:
    """按币种补 5m（本地够则跳过）；Live 漏斗走 Binance。"""
    settle_lo = start_ms - 60_000
    settle_hi = end_ms + _VERIFY_DELAY_MS + 5 * 60_000
    if store.has_sufficient_coverage(symbol, "5m", settle_lo, settle_hi):
        return
    source = "binance" if live_funnel else "bybit"
    await store.ensure_range(
        session,
        symbol,
        "5m",
        settle_lo,
        settle_hi,
        as_of_ms=end_ms,
        source=source,
        binance_base_url=FAPI_BASE_URL if live_funnel else None,
    )


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
    is_major: bool = True,
    live_funnel: bool = False,
    daily_alt_pools: dict[int, frozenset[str]] | None = None,
    funnel: CardFunnelState | None = None,
) -> list[dict[str, Any]]:
    if live_funnel and not interval_allowed_for_job(interval):
        return []
    lo, hi = kline_window_ms(interval, start_ms, end_ms)
    klines = store.load_rows(symbol, interval, lo, hi)
    if len(klines) < _WARMUP_BARS:
        return []

    df = enrich_indicators(klines_to_df(klines))
    if df.empty or "bb_basis" not in df.columns:
        return []

    structure_kinds = kinds - CANDLE_KINDS
    candle_kinds = kinds & CANDLE_KINDS
    if live_funnel:
        if structure_kinds and not structure_interval_ok(interval):
            structure_kinds = set()
    hits: list[dict[str, Any]] = []
    is_major_sym = is_major or symbol.upper() in _MAJORS
    candle_last: dict[str, int] = {}
    struct_last: dict[str, int] = {}

    def _alt_pool_for(close_ms: int) -> frozenset[str]:
        if not daily_alt_pools:
            return frozenset()
        return daily_alt_pools.get(int(close_ms) // _DAY_MS, frozenset())

    def _append_settled(
        *,
        kind: str,
        type_label: str,
        pattern_label: str,
        side: str,
        close_time_ms: int,
        bar_close_sec: int,
        entry: float,
        defense: Any,
        emit: str,
        extra: dict[str, Any] | None = None,
    ) -> None:
        if live_funnel and funnel is not None:
            if emit == "candle":
                if not funnel.try_candle_emit(
                    sym=symbol, iv=interval, kind=kind, side=side, bar_close_sec=bar_close_sec
                ):
                    return
            elif not funnel.try_struct_emit(
                sym=symbol, iv=interval, kind=kind, side=side, bar_close_sec=bar_close_sec
            ):
                return
        elif emit == "candle":
            ck = f"{symbol}:{interval}:{side}"
            if _cooldown_blocked(
                candle_last, ck, bar_close_sec=bar_close_sec, interval=interval,
                cooldown_bars=CARD_PUSH_COOLDOWN_BARS,
            ):
                return
            candle_last[ck] = bar_close_sec
        else:
            ck = f"struct:{symbol}:{interval}:{side}"
            if _cooldown_blocked(
                struct_last, ck, bar_close_sec=bar_close_sec, interval=interval,
                cooldown_bars=STRUCTURE_PUSH_COOLDOWN_BARS,
            ):
                return
            struct_last[ck] = bar_close_sec

        signal_at_ms = _align_signal_at_ms(close_time_ms)
        settle_end = signal_at_ms + _VERIFY_DELAY_MS + 5 * 60_000
        bars_settle = store.load_5m_bars(symbol, signal_at_ms, settle_end)
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
            row = df.iloc[bar_index]
            open_ms = int(row["open_time"])
            close_ms = _bar_close_ms(row)
            if close_ms < start_ms or close_ms > end_ms:
                continue
            if live_funnel and not alt_eligible_at(
                _alt_pool_for(close_ms), symbol, is_major=is_major_sym
            ):
                continue
            for ev in _pick_signals_on_bar(events, bar_index):
                kind = str(ev.get("kind") or "")
                if kind not in structure_kinds or kind == "spring_2b":
                    continue
                side = str(ev.get("side") or "")
                if side not in ("bull", "bear"):
                    continue
                bar_close_sec = int(open_ms // 1000)
                signal_at_ms = _align_signal_at_ms(close_ms)
                hit = {
                    **ev,
                    "time": bar_close_sec,
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                    "price": float(row["close"]),
                }
                if not filter_structure_card_hits(
                    [hit], interval=interval, now_ms=signal_at_ms
                ):
                    continue
                _append_settled(
                    kind=kind,
                    type_label=str(ev.get("type_label") or kind),
                    pattern_label=str(ev.get("pattern_label") or ""),
                    side=side,
                    close_time_ms=close_ms,
                    bar_close_sec=bar_close_sec,
                    entry=float(row["close"]),
                    defense=ev.get("defense"),
                    emit="struct",
                )

    if candle_kinds:
        allow_shoot = "shooting_star" in candle_kinds
        allow_consec = (
            "consecutive_flat_shooting_star" in candle_kinds and is_major_sym
        )
        candle_kind_set = set(candle_kinds)
        if not allow_consec:
            candle_kind_set.discard("consecutive_flat_shooting_star")
        for ch in iter_candle_card_hits_in_range(
            df,
            start_ms=start_ms,
            end_ms=end_ms,
            kinds=candle_kind_set,
            allow_shooting_star=allow_shoot,
            allow_consecutive_shoot=allow_consec,
        ):
            kind = str(ch.get("kind") or "")
            bar_row = df.iloc[int(ch["bar_index"])]
            close_ms = _bar_close_ms(bar_row)
            if live_funnel and not alt_eligible_at(
                _alt_pool_for(close_ms), symbol, is_major=is_major_sym
            ):
                continue
            bar_close_sec = int(bar_row["open_time"] // 1000)
            side = str(ch.get("side") or "bear")
            _append_settled(
                kind=kind,
                type_label=str(ch.get("type_label") or kind),
                pattern_label=str(ch.get("text") or ""),
                side=side,
                close_time_ms=close_ms,
                bar_close_sec=bar_close_sec,
                entry=float(ch.get("close") or ch.get("price") or 0),
                defense=ch.get("prior_high"),
                emit="candle",
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


def _summarize_by_type_label(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for it in items:
        key = str(it.get("typeLabel") or it.get("kind") or "unknown")
        groups.setdefault(key, []).append(it)
    out: list[dict[str, Any]] = []
    for label, bucket in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        s = summarize(_pseudo_alerts(bucket))
        out.append({"typeLabel": label, "label": label, "count": len(bucket), **s})
    return out


async def _run_job(job: BacktestJob, get_pool_rows: Callable[[], list[dict[str, Any]] | None]) -> None:
    job.status = "running"
    job.started_at = time.time()
    await _persist_job_async(job)
    try:
        p = job.params
        start_ms = int(p["startMs"])
        end_ms = int(p["endMs"])
        intervals = [iv for iv in p.get("intervals") or [] if iv in STRUCTURE_CARD_INTERVALS]
        kinds = set(p.get("kinds") or DEFAULT_KINDS)
        scope = str(p.get("symbolScope") or "top200")
        max_symbols = int(p.get("maxSymbols") or 200)

        skip_fetch = bool(p.get("skipFetch", True))
        live_funnel = bool(p.get("liveFunnel", True))
        store = BacktestKlineStore()
        symbols: list[str] = []
        universe_meta: dict[str, Any] | None = None
        daily_alt_pools: dict[int, frozenset[str]] = {}
        scan_jobs: list[tuple[str, str, bool]] = []
        funnel = CardFunnelState() if live_funnel else None

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
                    await _persist_job_async(job)

        if not symbols:
            job.status = "failed"
            job.error = "无可用币种（pool 为空时可改用 top200 / majors / all）"
            job.finished_at = time.time()
            await _persist_job_async(job)
            return
        if universe_meta:
            job.params["universe"] = universe_meta
        job.params["symbols"] = symbols
        job.params["liveFunnel"] = live_funnel

        job.progress = {"phase": "prepare", "done": 0, "total": 0, "current": "构建 Live 漏斗"}
        await _persist_job_async(job)

        if live_funnel:
            daily_alt_pools = await asyncio.to_thread(
                build_daily_alt_pools,
                store,
                symbols,
                start_ms,
                end_ms,
            )
            scan_jobs = build_live_scan_jobs(union_alt_symbols(daily_alt_pools))
            job.params["funnel"] = live_funnel_meta(daily_alt_pools, scan_jobs)
        else:
            scan_jobs = [(sym, iv, sym.upper() in _MAJORS) for sym in symbols for iv in intervals]

        if not scan_jobs:
            scan_jobs = [(sym, iv, sym.upper() in _MAJORS) for sym in symbols for iv in intervals]
        tasks = scan_jobs
        unique_symbols = sorted({t[0] for t in tasks})
        total = len(tasks)
        fetch5m_total = len(unique_symbols)
        all_items: list[dict[str, Any]] = []
        job.items = all_items
        settled_5m: set[str] = set()
        px = proxy_url()
        fetch_session = make_http_session(trust_env=False, default_proxy=px)

        try:
            for i, (sym, iv, is_major) in enumerate(tasks):
                if sym not in settled_5m:
                    job.progress = {
                        "phase": "fetch5m",
                        "done": len(settled_5m),
                        "total": fetch5m_total,
                        "symbols": len(unique_symbols),
                        "current": f"5m {sym}",
                        "source": "binance" if live_funnel else "bybit",
                    }
                    try:
                        await _ensure_symbol_settle_5m(
                            fetch_session,
                            store,
                            symbol=sym,
                            start_ms=start_ms,
                            end_ms=end_ms,
                            live_funnel=live_funnel,
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("回测 5m 补全失败 %s: %s", sym, exc)
                    settled_5m.add(sym)
                    await _persist_job_async(job)

                job.progress = {
                    "phase": "scan",
                    "done": i,
                    "total": total,
                    "symbols": len(unique_symbols),
                    "current": f"扫描 {sym} {iv}",
                    "source": "binance" if live_funnel else "bybit",
                    "fetch5mDone": len(settled_5m),
                    "fetch5mTotal": fetch5m_total,
                }
                try:
                    chunk = await asyncio.to_thread(
                        _scan_symbol_interval,
                        store,
                        symbol=sym,
                        interval=iv,
                        start_ms=start_ms,
                        end_ms=end_ms,
                        kinds=kinds,
                        is_major=is_major,
                        live_funnel=live_funnel,
                        daily_alt_pools=daily_alt_pools if live_funnel else None,
                        funnel=funnel,
                    )
                    if chunk:
                        all_items.extend(chunk)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("回测扫描失败 %s %s: %s", sym, iv, exc)
                job.progress["done"] = i + 1
                if i % 2 == 1 or i + 1 == total:
                    _refresh_live_stats(job)
                    await asyncio.sleep(0)
                if i % 4 == 3 or i + 1 == total:
                    await _persist_job_async(job)
        finally:
            if not fetch_session.closed:
                await fetch_session.close()

        _refresh_live_stats(job)
        job.status = "done"
        job.finished_at = time.time()
        job.progress["current"] = ""
        await _persist_job_async(job)
    except Exception as exc:  # noqa: BLE001
        logger.exception("回测任务失败 %s", job.id)
        job.status = "failed"
        job.error = str(exc)
        job.finished_at = time.time()
        if job.items:
            job.params = {**job.params, "partial": True}
            _refresh_live_stats(job)
        await _persist_job_async(job)


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
            "liveFunnel": bool(params.get("liveFunnel", True)),
        },
    )

    async with _jobs_lock:
        if len(_jobs) >= _MAX_JOBS:
            finished = [j for j in _jobs.values() if j.status in ("done", "failed")]
            if finished:
                oldest = min(finished, key=lambda j: j.finished_at or j.started_at or 0)
                _jobs.pop(oldest.id, None)
        _jobs[job.id] = job
    _persist_job(job)

    asyncio.create_task(_run_job(job, get_pool_rows), name=f"structure-backtest-{job.id}")
    return job


def get_backtest_job(job_id: str) -> BacktestJob | None:
    hit = _jobs.get(job_id)
    if hit is not None:
        return hit
    loaded = _load_job_from_disk(job_id)
    if loaded is None:
        return None
    _jobs[loaded.id] = loaded
    return loaded


def get_latest_backtest_job() -> BacktestJob | None:
    if _LAST_JOB_FILE.is_file():
        try:
            data = json.loads(_LAST_JOB_FILE.read_text(encoding="utf-8"))
            job_id = str((data or {}).get("id") or "").strip()
            if job_id:
                job = get_backtest_job(job_id)
                if job is not None:
                    return job
        except Exception:  # noqa: BLE001
            logger.debug("读取 latest 回测失败", exc_info=True)
    if _jobs:
        return max(_jobs.values(), key=lambda j: j.started_at or j.finished_at or 0)
    return None


def list_backtest_jobs(limit: int = 40) -> list[dict[str, Any]]:
    """历史回测摘要（不含信号明细），按开始时间倒序。"""
    cap = max(1, min(int(limit or _MAX_LIST), 80))
    by_id: dict[str, dict[str, Any]] = {}
    if _INDEX_FILE.is_file():
        try:
            raw = json.loads(_INDEX_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                for row in raw:
                    if isinstance(row, dict) and row.get("id"):
                        by_id[str(row["id"])] = row
        except Exception:  # noqa: BLE001
            logger.debug("读取回测索引失败", exc_info=True)
    if _JOB_DIR.is_dir():
        for path in _JOB_DIR.glob("*.meta.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("id"):
                    by_id[str(data["id"])] = data
            except Exception:  # noqa: BLE001
                logger.debug("读取回测摘要失败 %s", path.name, exc_info=True)
        for path in _JOB_DIR.glob("*.json"):
            if path.name in ("latest.json", "index.json") or path.name.endswith(".meta.json"):
                continue
            job_id = path.stem
            if job_id in by_id:
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("id"):
                    by_id[str(data["id"])] = _list_row_from_payload(data)
            except Exception:  # noqa: BLE001
                logger.debug("读取回测快照失败 %s", job_id, exc_info=True)
    for job in _jobs.values():
        by_id[job.id] = _list_row_from_job(job)
    rows = sorted(by_id.values(), key=lambda r: float(r.get("startedAt") or 0), reverse=True)
    return rows[:cap]


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
    interval_only = _filter_items(
        job.items,
        kind_filter=kind_filter,
        interval_filter=interval_filter,
    )
    total = len(filtered)
    pages = max(1, (total + page_size - 1) // page_size) if total else 1
    if page > pages:
        page = pages
    start = (page - 1) * page_size
    chunk = filtered[start : start + page_size]
    filtered_summary = summarize(_pseudo_alerts(filtered)) if filtered else None
    interval_summary = summarize(_pseudo_alerts(interval_only)) if interval_only else None
    return {
        "id": job.id,
        "status": job.status,
        "error": job.error,
        "params": job.params,
        "progress": job.progress,
        "summary": job.summary,
        "filteredSummary": filtered_summary,
        "intervalSummary": interval_summary,
        "byKind": job.by_kind,
        "byType": _summarize_by_type_label(interval_only),
        "byInterval": job.by_interval,
        "items": chunk,
        "total": total,
        "totalAll": len(job.items),
        "page": page,
        "pageSize": page_size,
        "pages": pages,
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
        "settleRules": (
            "Live漏斗 · BTC/ETH/SOL 100x · 山寨 20x · ±5% · 3h · Binance 5m · 收盘+下一5m"
            if job.params.get("liveFunnel")
            else "BTC/ETH/SOL 100x · 山寨 20x · 默认 ±5% · 信号后 3h · 5m K 核实 · 收盘对齐下一 5m"
        ),
        "klineSource": "bybit_v5_parquet",
        "storageStats": storage_stats(),
        "kindOptions": KIND_OPTIONS,
    }
