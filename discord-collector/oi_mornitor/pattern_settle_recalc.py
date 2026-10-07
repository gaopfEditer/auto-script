"""胜率库一键重算 V2：拉 K 线 + build_settle_plan + settle_signal_batch。"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from oi_mornitor.config import FAPI_BASE_URL
from oi_mornitor.http_session import make_http_session, proxy_url
from oi_mornitor.pattern_alert_stats import _load, _save, is_retired_pattern_stats_record
from oi_mornitor.pattern_monitor import fetch_pattern_klines
from oi_mornitor.pattern_settle import klines_rows_to_bars, settle_signal_batch
from oi_mornitor.pattern_settle_profile import build_settle_plan, compute_atr14, is_observation_record
from oi_mornitor.signal_policy import is_disabled_pattern_interval

logger = logging.getLogger(__name__)

_ATR_IV = {"15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1d"}
_FETCH_SEM = asyncio.Semaphore(6)


async def _fetch_bars(
    session: Any,
    *,
    symbol: str,
    interval: str,
    limit: int,
    end_time: int | None,
) -> list[dict[str, float]]:
    rows = await fetch_pattern_klines(
        session,
        base_url=FAPI_BASE_URL,
        symbol=symbol,
        interval=interval,
        limit=limit,
        end_time=end_time,
    )
    return klines_rows_to_bars(rows)


async def _settle_one(session: Any, rec: dict[str, Any], *, now_ms: int) -> dict[str, Any] | None:
    if is_retired_pattern_stats_record(rec):
        return None
    iv = str(rec.get("interval") or "15m")
    if is_disabled_pattern_interval(iv):
        return None
    sym = str(rec.get("tradeSymbol") or rec.get("symbol") or "").strip()
    if not sym:
        return None
    try:
        entry = float(rec.get("entry") or 0)
        signal_at = int(rec.get("signalAt") or 0)
    except (TypeError, ValueError):
        return None
    if entry <= 0 or signal_at <= 0:
        return None

    side = str(rec.get("side") or "long")
    work = dict(rec)
    work.setdefault("tradeSymbol", sym)

    atr_iv = _ATR_IV.get(iv, "15m")
    async with _FETCH_SEM:
        atr_rows = await _fetch_bars(
            session,
            symbol=sym,
            interval=atr_iv,
            limit=30,
            end_time=signal_at + 60_000,
        )
        atr = _atr_from_klines_bars(atr_rows) if atr_rows else None
        plan = build_settle_plan(work, atr=atr)

    verify_at = signal_at + plan.verify_delay_ms
    settle_end = min(now_ms, verify_at + 5 * 60_000)
    need_5m = max(36, int((settle_end - signal_at) // (5 * 60_000)) + 4)
    need_5m = min(need_5m, 500)

    async with _FETCH_SEM:
        bars_5m = await _fetch_bars(
            session,
            symbol=sym,
            interval="5m",
            limit=need_5m,
            end_time=settle_end,
        )

    if not bars_5m:
        return {
            **work,
            "outcome": "error",
            "error": "no_klines",
            "settleRulesVersion": 2,
        }

    settled = settle_signal_batch(
        side=side,
        entry=entry,
        symbol=sym,
        signal_at_ms=signal_at,
        bars=bars_5m,
        now_ms=now_ms,
        plan=plan,
    )
    merged = {**work, **settled}
    merged["verifyAt"] = verify_at
    if is_observation_record(work):
        merged["observation_only"] = True
    return merged


def _atr_from_klines_bars(bars: list[dict[str, float]]) -> float | None:
    if len(bars) < 16:
        return None
    return compute_atr14(
        [b["high"] for b in bars],
        [b["low"] for b in bars],
        [b["close"] for b in bars],
    )


async def recalculate_all_settlements_v2(
    *,
    limit: int | None = None,
    include_observation: bool = True,
) -> dict[str, Any]:
    """全库（或前 limit 条）按 V2 规则重算 outcome。"""
    items = _load()
    targets = [dict(r) for r in items if r.get("key")]
    if not include_observation:
        targets = [r for r in targets if not is_observation_record(r)]
    targets.sort(key=lambda r: int(r.get("signalAt") or 0), reverse=True)
    if limit is not None and limit > 0:
        targets = targets[: int(limit)]

    now_ms = int(time.time() * 1000)
    by_key = {str(r.get("key")): dict(r) for r in items if r.get("key")}
    updated = errors = skipped = 0

    async with make_http_session(default_proxy=proxy_url()) as session:
        for i, rec in enumerate(targets):
            key = str(rec.get("key"))
            try:
                out = await _settle_one(session, rec, now_ms=now_ms)
            except Exception as exc:
                logger.warning("V2 重算失败 %s: %s", key, exc)
                errors += 1
                continue
            if out is None:
                skipped += 1
                continue
            by_key[key] = out
            updated += 1
            if (i + 1) % 50 == 0:
                logger.info("V2 重算进度 %d/%d", i + 1, len(targets))

    _save(list(by_key.values()))
    from oi_mornitor.pattern_alert_stats import summarize

    return {
        "ok": True,
        "processed": len(targets),
        "updated": updated,
        "errors": errors,
        "skipped": skipped,
        "summary": summarize(),
    }


def recalculate_all_settlements_v2_sync(**kwargs: Any) -> dict[str, Any]:
    return asyncio.run(recalculate_all_settlements_v2(**kwargs))
