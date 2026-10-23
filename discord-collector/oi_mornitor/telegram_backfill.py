"""Telegram 形态群历史回溯：拉取消息 → 解析卡片 → 5m 结算 → 周/月统计（本地缓存）。"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from oi_mornitor.backtest_kline_store import BacktestKlineStore
from oi_mornitor.backtest_trade_config import OI_BT_FEE_PCT, OI_BT_SLIPPAGE_PCT
from oi_mornitor.config import (
    BACKTEST_KLINES_DIR,
    CANDLE_CARD_TELEGRAM_CHAT_ID,
    FAPI_BASE_URL,
    MAIN_CARD_TELEGRAM_CHAT_ID,
    PATTERN_STATE_DB,
    TELEGRAM_PUSH_CHAT_ID,
)
from oi_mornitor.http_session import make_http_session, proxy_url
from oi_mornitor.pattern_alert_stats import alert_stats_key, filter_alert_stats, summarize
from oi_mornitor.pattern_settle import settle_signal_by_5m_bars
from oi_mornitor.pattern_settle_profile import build_settle_plan, resolve_verify_delay_ms
from oi_mornitor.pattern_signal_time import resolve_signal_at_from_alert
from oi_mornitor.structure_backtest import _ensure_symbol_settle_5m
from oi_mornitor.telegram_backfill_parse import parse_oi_telegram_card

logger = logging.getLogger(__name__)

_VERIFY_PAD_MS = 3 * 60 * 60 * 1000 + 5 * 60_000
_JOB_DIR = Path(PATTERN_STATE_DB).resolve().parent / "telegram_backfill_jobs"
_INDEX_FILE = _JOB_DIR / "index.json"
_MAX_JOBS = 24
_MAX_LIST = 40

_jobs: dict[str, "BackfillJob"] = {}
_jobs_lock = asyncio.Lock()


def _repo_telegram_dir() -> Path:
    # oi_mornitor/telegram_backfill.py → 仓库根 telegram/
    return Path(__file__).resolve().parents[2] / "telegram"


def resolve_backfill_chat_ids() -> list[dict[str, Any]]:
    """与推送配置一致的群（去重、保序）。"""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []

    def add(cid: str, label: str) -> None:
        c = str(cid or "").strip()
        if not c or c in seen:
            return
        seen.add(c)
        out.append({"id": c, "label": label})

    add(CANDLE_CARD_TELEGRAM_CHAT_ID, "形态卡片群 (OI_CANDLE_CARD)")
    add(MAIN_CARD_TELEGRAM_CHAT_ID, "主卡镜像群 (MAIN_CARD)")
    add(TELEGRAM_PUSH_CHAT_ID, "推送群 (TELEGRAM_PUSH)")
    return out


def _parse_chat_int(chat_id: str) -> int | None:
    s = str(chat_id or "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


@dataclass
class BackfillJob:
    id: str
    status: str = "pending"
    error: str | None = None
    params: dict[str, Any] = field(default_factory=dict)
    progress: dict[str, Any] = field(default_factory=dict)
    summary: dict[str, Any] | None = None
    by_week: list[dict[str, Any]] = field(default_factory=list)
    by_month: list[dict[str, Any]] = field(default_factory=list)
    by_chat: list[dict[str, Any]] = field(default_factory=list)
    by_type: list[dict[str, Any]] = field(default_factory=list)
    items: list[dict[str, Any]] = field(default_factory=list)
    started_at: float = 0.0
    finished_at: float = 0.0


def _ensure_dir() -> None:
    _JOB_DIR.mkdir(parents=True, exist_ok=True)


def _beijing_bucket_week(signal_at_ms: int) -> str:
    from zoneinfo import ZoneInfo

    dt = datetime.fromtimestamp(signal_at_ms / 1000.0, tz=ZoneInfo("Asia/Shanghai"))
    y, w, _ = dt.isocalendar()
    return f"{y}-W{w:02d}"


def _beijing_bucket_month(signal_at_ms: int) -> str:
    from zoneinfo import ZoneInfo

    dt = datetime.fromtimestamp(signal_at_ms / 1000.0, tz=ZoneInfo("Asia/Shanghai"))
    return f"{dt.year}-{dt.month:02d}"


def _aggregate_dimensions(items: list[dict[str, Any]]) -> tuple[list, list, list, list]:
    by_week: dict[str, list] = {}
    by_month: dict[str, list] = {}
    by_chat: dict[str, list] = {}
    by_type: dict[str, list] = {}
    for r in items:
        sat = int(r.get("signalAt") or 0)
        if sat <= 0:
            continue
        wk = _beijing_bucket_week(sat)
        mo = _beijing_bucket_month(sat)
        by_week.setdefault(wk, []).append(r)
        by_month.setdefault(mo, []).append(r)
        cid = str(r.get("chatId") or "unknown")
        by_chat.setdefault(cid, []).append(r)
        tl = str(r.get("typeLabel") or r.get("type_label") or "—")
        by_type.setdefault(tl, []).append(r)

    def _rows(groups: dict[str, list], *, sort_key: Callable[[str], Any]) -> list[dict[str, Any]]:
        keys = sorted(groups.keys(), key=sort_key)
        out: list[dict[str, Any]] = []
        for k in keys:
            bucket = groups[k]
            s = summarize(bucket)
            out.append(
                {
                    "id": k,
                    "label": k,
                    "count": len(bucket),
                    **s,
                }
            )
        return out

    week_rows = _rows(by_week, sort_key=lambda x: x)
    month_rows = _rows(by_month, sort_key=lambda x: x)
    chat_rows = _rows(by_chat, sort_key=lambda x: x)
    type_rows = _rows(by_type, sort_key=lambda x: (-len(by_type[x]), x))
    return week_rows, month_rows, chat_rows, type_rows


def _item_from_settled(
    *,
    alert: dict[str, Any],
    chat_id: str,
    chat_label: str,
    message_id: int,
    settled: dict[str, Any],
    entry: float,
    signal_at_ms: int,
) -> dict[str, Any]:
    side = str(alert.get("side") or "")
    trade_side = "short" if side in ("bear", "short") else "long"
    sym = str(alert.get("tradeSymbol") or alert.get("symbol") or "")
    type_label = str(alert.get("type_label") or alert.get("pattern_label") or "")
    return {
        "key": alert_stats_key(alert),
        "symbol": sym,
        "tradeSymbol": sym,
        "interval": str(alert.get("interval") or ""),
        "typeLabel": type_label,
        "kind": str(alert.get("kind") or ""),
        "side": trade_side,
        "dir": "空" if trade_side == "short" else "多",
        "signalAt": signal_at_ms,
        "entry": entry,
        "chatId": chat_id,
        "chatLabel": chat_label,
        "messageId": message_id,
        "outcome": settled.get("outcome"),
        "movePct": settled.get("movePct"),
        "pnlPct": settled.get("pnlPct"),
        "exitPrice": settled.get("exitPrice"),
        "source": "telegram_backfill",
    }


async def _fetch_messages_telethon(
    chat_id: int,
    since_ms: int,
    until_ms: int,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
) -> list[dict[str, Any]]:
    tg_dir = _repo_telegram_dir()
    if not tg_dir.is_dir():
        raise RuntimeError(f"未找到 telegram 工具目录: {tg_dir}")

    async def _run(client) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        since_dt = datetime.fromtimestamp(since_ms / 1000.0, tz=timezone.utc)
        until_dt = datetime.fromtimestamp(until_ms / 1000.0, tz=timezone.utc)
        count = 0
        async for message in client.iter_messages(chat_id, offset_date=until_dt, reverse=False):
            if message.date is None:
                continue
            msg_ms = int(message.date.timestamp() * 1000)
            if msg_ms < since_ms:
                break
            if msg_ms > until_ms:
                continue
            text = message.message or ""
            if not str(text).strip():
                continue
            rows.append(
                {
                    "id": int(message.id),
                    "dateMs": msg_ms,
                    "text": str(text),
                }
            )
            count += 1
            if on_progress and count % 50 == 0:
                on_progress({"fetched": count, "lastMs": msg_ms})
        rows.sort(key=lambda r: int(r.get("dateMs") or 0))
        return rows

    def _sync_entry() -> list[dict[str, Any]]:
        import asyncio as _asyncio

        if str(tg_dir) not in sys.path:
            sys.path.insert(0, str(tg_dir))
        from session import create_and_start_client  # type: ignore

        async def _inner() -> list[dict[str, Any]]:
            client, _ = await create_and_start_client()
            try:
                return await _run(client)
            finally:
                await client.disconnect()

        return _asyncio.run(_inner())

    return await asyncio.to_thread(_sync_entry)


def _stats_fallback_items(since_ms: int, until_ms: int, chat_ids: list[str]) -> list[dict[str, Any]]:
    """无 Telethon 时：用已入库的 telegram_push 胜率库（时间窗内）。"""
    rows = filter_alert_stats(time_filter=None)
    out: list[dict[str, Any]] = []
    chat_set = {str(c) for c in chat_ids if str(c).strip()}
    for r in rows:
        sat = int(r.get("signalAt") or 0)
        if sat < since_ms or sat > until_ms:
            continue
        src = str(r.get("source") or "")
        if src not in ("telegram_push", "telegram_backfill"):
            continue
        if chat_set:
            # 库里通常无 chatId；有 chat 筛选时仍保留 push 记录
            pass
        out.append(dict(r))
    return out


async def _settle_parsed_alerts(
    parsed: list[tuple[dict[str, Any], str, str, int]],
    *,
    since_ms: int,
    until_ms: int,
    job: BackfillJob,
) -> list[dict[str, Any]]:
    store = BacktestKlineStore(Path(BACKTEST_KLINES_DIR))
    px = proxy_url()
    session = make_http_session(trust_env=False, default_proxy=px)
    symbols = sorted({str(a.get("tradeSymbol") or a.get("symbol") or "") for a, _, _, _ in parsed if a})
    symbols = [s for s in symbols if s]
    settled_syms: set[str] = set()
    items: list[dict[str, Any]] = []

    try:
        for i, sym in enumerate(symbols):
            job.progress = {
                "phase": "fetch5m",
                "done": i,
                "total": len(symbols),
                "current": sym,
            }
            await _persist_job_async(job)
            if sym not in settled_syms:
                try:
                    await _ensure_symbol_settle_5m(
                        session,
                        store,
                        symbol=sym,
                        start_ms=since_ms,
                        end_ms=until_ms,
                        live_funnel=True,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("TG 回溯 5m 补全失败 %s: %s", sym, exc)
                settled_syms.add(sym)

        job.progress = {"phase": "settle", "done": 0, "total": len(parsed), "current": ""}
        await _persist_job_async(job)

        for j, (alert, chat_id, chat_label, msg_id) in enumerate(parsed):
            entry = alert.get("price") or alert.get("close")
            try:
                entry_f = float(entry)
            except (TypeError, ValueError):
                entry_f = 0.0
            if entry_f <= 0:
                continue
            signal_at_ms = resolve_signal_at_from_alert(alert)
            if signal_at_ms <= 0:
                continue
            sym = str(alert.get("tradeSymbol") or alert.get("symbol") or "")
            side = str(alert.get("side") or "")
            trade_side = "short" if side in ("bear", "short") else "long"
            settle_stub: dict[str, Any] = {
                **alert,
                "side": trade_side,
                "entry": entry_f,
                "tradeSymbol": sym,
                "symbol": sym,
                "signalAt": signal_at_ms,
                "typeLabel": str(alert.get("type_label") or ""),
                "interval": str(alert.get("interval") or ""),
            }
            from oi_mornitor.mcap_tier import resolve_mcap_tier

            settle_stub["mcapTier"] = resolve_mcap_tier(sym)
            verify_ms = resolve_verify_delay_ms(settle_stub)
            settle_end = signal_at_ms + verify_ms + 5 * 60_000
            bars = store.load_5m_bars(sym, signal_at_ms, settle_end)
            settled = settle_signal_by_5m_bars(
                side=trade_side,
                entry=entry_f,
                symbol=sym,
                signal_at_ms=signal_at_ms,
                bars_5m=bars,
                now_ms=settle_end,
                alert_rec=settle_stub,
                fee_pct_per_side=OI_BT_FEE_PCT,
                slippage_pct_per_side=OI_BT_SLIPPAGE_PCT,
            )
            try:
                build_settle_plan(settle_stub)
            except ValueError:
                pass
            items.append(
                _item_from_settled(
                    alert=alert,
                    chat_id=chat_id,
                    chat_label=chat_label,
                    message_id=msg_id,
                    settled=settled,
                    entry=entry_f,
                    signal_at_ms=signal_at_ms,
                )
            )
            if j % 20 == 0:
                job.progress = {
                    "phase": "settle",
                    "done": j + 1,
                    "total": len(parsed),
                    "current": sym,
                }
                await _persist_job_async(job)
    finally:
        await session.close()
    return items


def _job_payload(job: BackfillJob, *, include_items: bool = True) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": job.id,
        "status": job.status,
        "error": job.error,
        "params": job.params,
        "progress": job.progress,
        "summary": job.summary,
        "byWeek": job.by_week,
        "byMonth": job.by_month,
        "byChat": job.by_chat,
        "byType": job.by_type,
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
    }
    if include_items:
        data["items"] = job.items
    return data


def _persist_job(job: BackfillJob) -> None:
    _ensure_dir()
    path = _JOB_DIR / f"{job.id}.json"
    path.write_text(json.dumps(_job_payload(job), ensure_ascii=False), encoding="utf-8")
    row = {
        "id": job.id,
        "status": job.status,
        "error": job.error,
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
        "rangeDays": job.params.get("rangeDays"),
        "sinceMs": job.params.get("sinceMs"),
        "untilMs": job.params.get("untilMs"),
        "mode": job.params.get("mode"),
        "messageCount": job.params.get("messageCount"),
        "parsedCount": job.params.get("parsedCount"),
        "total": (job.summary or {}).get("total"),
        "winRate": (job.summary or {}).get("winRate"),
        "totalPnlPct": (job.summary or {}).get("totalPnlPct"),
    }
    rows: list[dict[str, Any]] = []
    if _INDEX_FILE.is_file():
        try:
            raw = json.loads(_INDEX_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                rows = [r for r in raw if isinstance(r, dict) and str(r.get("id")) != job.id]
        except Exception:  # noqa: BLE001
            rows = []
    rows.insert(0, row)
    _INDEX_FILE.write_text(json.dumps(rows[:_MAX_LIST], ensure_ascii=False), encoding="utf-8")


async def _persist_job_async(job: BackfillJob) -> None:
    await asyncio.to_thread(_persist_job, job)


def _load_job_from_disk(job_id: str) -> BackfillJob | None:
    path = _JOB_DIR / f"{job_id}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    job = BackfillJob(
        id=str(data.get("id") or job_id),
        status=str(data.get("status") or "done"),
        error=data.get("error"),
        params=data.get("params") if isinstance(data.get("params"), dict) else {},
        progress=data.get("progress") if isinstance(data.get("progress"), dict) else {},
        summary=data.get("summary") if isinstance(data.get("summary"), dict) else None,
        by_week=list(data.get("byWeek") or []),
        by_month=list(data.get("byMonth") or []),
        by_chat=list(data.get("byChat") or []),
        by_type=list(data.get("byType") or []),
        items=list(data.get("items") or []),
        started_at=float(data.get("startedAt") or 0),
        finished_at=float(data.get("finishedAt") or 0),
    )
    return job


def get_backfill_job(job_id: str) -> BackfillJob | None:
    job = _jobs.get(job_id)
    if job is not None:
        return job
    loaded = _load_job_from_disk(job_id)
    if loaded is not None:
        _jobs[job_id] = loaded
    return loaded


def list_backfill_jobs(limit: int = 20) -> list[dict[str, Any]]:
    _ensure_dir()
    rows: list[dict[str, Any]] = []
    if _INDEX_FILE.is_file():
        try:
            raw = json.loads(_INDEX_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                rows = [r for r in raw if isinstance(r, dict)]
        except Exception:  # noqa: BLE001
            rows = []
    return rows[: max(1, min(limit, _MAX_LIST))]


def get_latest_backfill_job() -> BackfillJob | None:
    rows = list_backfill_jobs(limit=1)
    if not rows:
        return None
    jid = str(rows[0].get("id") or "")
    return get_backfill_job(jid) if jid else None


def backfill_options() -> dict[str, Any]:
    chats = resolve_backfill_chat_ids()
    return {
        "ok": True,
        "chatTargets": chats,
        "rangePresets": [
            {"id": "30d", "label": "近 1 个月", "days": 30},
            {"id": "90d", "label": "近 3 个月", "days": 90},
        ],
        "defaultRangeId": "30d",
        "hint": (
            "使用仓库根目录 telegram/ 的 Telethon 会话拉取群历史（需 API_ID/HASH 且已登录）。"
            " 若会话不可用，可回退为 pattern_alert_stats 中 source=telegram_push 的记录。"
            " 结算走本地 5m K 线（Binance），与结构回测一致。"
        ),
    }


async def _run_job(job: BackfillJob) -> None:
    params = job.params
    since_ms = int(params.get("sinceMs") or 0)
    until_ms = int(params.get("untilMs") or 0)
    chat_specs: list[dict[str, str]] = list(params.get("chats") or [])
    mode = str(params.get("mode") or "telethon").strip().lower()
    parsed_triples: list[tuple[dict[str, Any], str, str, int]] = []
    message_count = 0
    used_stats = mode == "stats"

    try:
        if mode == "stats":
            job.progress = {"phase": "stats", "done": 0, "total": 1}
            await _persist_job_async(job)
            chat_ids = [str(c.get("id") or "") for c in chat_specs]
            job.items = _stats_fallback_items(since_ms, until_ms, chat_ids)
            job.params["parsedCount"] = len(job.items)
            job.params["messageCount"] = 0
            job.params["mode"] = "stats"
        else:
            for idx, spec in enumerate(chat_specs):
                cid_str = str(spec.get("id") or "")
                label = str(spec.get("label") or cid_str)
                chat_int = _parse_chat_int(cid_str)
                if chat_int is None:
                    continue
                job.progress = {
                    "phase": "fetch",
                    "done": idx,
                    "total": len(chat_specs),
                    "current": label,
                }
                await _persist_job_async(job)

                def _prog(p: dict[str, Any]) -> None:
                    job.progress = {
                        "phase": "fetch",
                        "done": idx,
                        "total": len(chat_specs),
                        "current": label,
                        **p,
                    }

                try:
                    messages = await _fetch_messages_telethon(
                        chat_int,
                        since_ms,
                        until_ms,
                        on_progress=_prog,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Telethon 拉取失败 chat=%s: %s", cid_str, exc)
                    job.params["telethonError"] = str(exc)
                    chat_ids = [str(c.get("id") or "") for c in chat_specs]
                    job.items = _stats_fallback_items(since_ms, until_ms, chat_ids)
                    job.params["mode"] = "stats_fallback"
                    job.params["parsedCount"] = len(job.items)
                    used_stats = True
                    break

                message_count += len(messages)
                for m in messages:
                    alert = parse_oi_telegram_card(
                        str(m.get("text") or ""),
                        fallback_ms=int(m.get("dateMs") or 0),
                    )
                    if alert is None:
                        continue
                    parsed_triples.append(
                        (alert, cid_str, label, int(m.get("id") or 0)),
                    )

            if not used_stats:
                job.params["messageCount"] = message_count
                job.params["parsedCount"] = len(parsed_triples)
                job.items = await _settle_parsed_alerts(
                    parsed_triples,
                    since_ms=since_ms,
                    until_ms=until_ms,
                    job=job,
                )

        job.by_week, job.by_month, job.by_chat, job.by_type = _aggregate_dimensions(job.items)
        job.summary = summarize(job.items)
        job.status = "done"
        job.progress = {"phase": "done", "done": 1, "total": 1}
    except Exception as exc:  # noqa: BLE001
        logger.exception("Telegram 回溯任务失败")
        job.status = "error"
        job.error = str(exc)
    finally:
        job.finished_at = time.time()
        await _persist_job_async(job)


async def start_telegram_backfill(body: dict[str, Any]) -> BackfillJob:
    range_id = str(body.get("rangeId") or body.get("range") or "30d").strip()
    days = int(body.get("days") or 0)
    if days <= 0:
        days = 90 if range_id in ("90d", "3m", "3M") else 30
    until_ms = int(body.get("untilMs") or time.time() * 1000)
    since_ms = int(body.get("sinceMs") or (until_ms - days * 86_400_000))
    mode = str(body.get("mode") or "telethon").strip().lower()
    use_cache = body.get("useCache", True)
    force = bool(body.get("forceRefresh"))

    chats_in = body.get("chatIds") or body.get("chats")
    if isinstance(chats_in, list) and chats_in:
        chat_specs = []
        catalog = {c["id"]: c for c in resolve_backfill_chat_ids()}
        for raw in chats_in:
            cid = str(raw.get("id") if isinstance(raw, dict) else raw).strip()
            if not cid:
                continue
            chat_specs.append(
                {"id": cid, "label": (catalog.get(cid) or {}).get("label") or cid},
            )
    else:
        chat_specs = resolve_backfill_chat_ids()

    cache_key = f"{since_ms}:{until_ms}:" + ",".join(sorted(c["id"] for c in chat_specs)) + f":{mode}"
    if use_cache and not force:
        for row in list_backfill_jobs(limit=_MAX_LIST):
            jid = str(row.get("id") or "")
            existing = get_backfill_job(jid)
            if existing is None:
                continue
            p = existing.params or {}
            if (
                p.get("cacheKey") == cache_key
                and existing.status == "done"
                and int(p.get("sinceMs") or 0) == since_ms
                and int(p.get("untilMs") or 0) == until_ms
            ):
                return existing

    async with _jobs_lock:
        if len(_jobs) >= _MAX_JOBS:
            # 淘汰内存中非 running
            for k in list(_jobs.keys()):
                if _jobs[k].status != "running":
                    del _jobs[k]
        job_id = uuid.uuid4().hex[:12]
        job = BackfillJob(
            id=job_id,
            status="running",
            params={
                "rangeId": range_id,
                "rangeDays": days,
                "sinceMs": since_ms,
                "untilMs": until_ms,
                "chats": chat_specs,
                "mode": mode,
                "cacheKey": cache_key,
            },
            started_at=time.time(),
        )
        _jobs[job_id] = job
        await _persist_job_async(job)

    asyncio.create_task(_run_job(job))
    return job


def job_to_dict(job: BackfillJob, *, page: int = 1, page_size: int = 100) -> dict[str, Any]:
    page = max(1, int(page or 1))
    size = min(500, max(1, int(page_size or 100)))
    items = job.items or []
    start = (page - 1) * size
    chunk = items[start : start + size]
    return {
        **(_job_payload(job, include_items=False)),
        "items": chunk,
        "page": page,
        "pageSize": size,
        "itemTotal": len(items),
    }
