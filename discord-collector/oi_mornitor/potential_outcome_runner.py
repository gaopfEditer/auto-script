"""潜力信号 · 检查点与窗口终点异步结算。"""
from __future__ import annotations

import logging
import time

import aiohttp

from oi_mornitor.config import FAPI_BASE_URL
from oi_mornitor.pattern_monitor import fetch_pattern_klines
from oi_mornitor.potential_outcome_config import (
    POTENTIAL_OUTCOME_ENABLED,
    POTENTIAL_OUTCOME_HOURS,
    POTENTIAL_OUTCOME_KLINE_IV,
    POTENTIAL_OUTCOME_MAX_CHECKPOINT_PER_PASS,
    POTENTIAL_OUTCOME_MAX_SETTLE_PER_PASS,
    POTENTIAL_TRACK_DAYS,
)
from oi_mornitor.potential_outcome_eval import compute_window_excursions
from oi_mornitor.potential_outcome_tracker import (
    SETTLE_DROPPED,
    SETTLE_EXITING,
    SETTLE_RENEWED,
    SETTLE_WINDOW,
    apply_checkpoint,
    apply_settlement,
    list_due_for_checkpoint,
    list_due_for_settlement,
    window_end_default_ms,
)

logger = logging.getLogger("OI_Radar")


def _resolve_settle_reason(track: dict) -> str:
    early = str(track.get("early_end") or "")
    if early == SETTLE_EXITING:
        return SETTLE_EXITING
    if early == SETTLE_DROPPED:
        return SETTLE_DROPPED
    if early == SETTLE_RENEWED:
        return SETTLE_RENEWED
    sig = int(track.get("signal_time_ms") or 0)
    end = int(track.get("window_end_ms") or 0)
    if end >= window_end_default_ms(sig):
        return SETTLE_WINDOW
    return SETTLE_WINDOW


def _bars_needed(span_ms: int) -> int:
    return min(500, max(48, int(span_ms / (15 * 60 * 1000)) + 5))


async def _fetch_klines(
    session: aiohttp.ClientSession,
    *,
    base_url: str,
    sym: str,
    sig_ms: int,
    end_ms: int,
) -> list:
    span_ms = max(end_ms - sig_ms, 15 * 60 * 1000)
    bars_needed = _bars_needed(span_ms)
    return await fetch_pattern_klines(
        session,
        base_url=base_url,
        symbol=sym,
        interval=POTENTIAL_OUTCOME_KLINE_IV,
        limit=bars_needed,
        end_time=end_ms,
    )


async def run_potential_checkpoint_pass(
    session: aiohttp.ClientSession,
    *,
    base_url: str = FAPI_BASE_URL,
) -> int:
    if not POTENTIAL_OUTCOME_ENABLED:
        return 0
    now_ms = int(time.time() * 1000)
    due = list_due_for_checkpoint(now_ms)[:POTENTIAL_OUTCOME_MAX_CHECKPOINT_PER_PASS]
    if not due:
        return 0
    n = 0
    for tid, cp_key, track in due:
        sym = str(track.get("symbol") or "")
        sig_ms = int(track.get("signal_time_ms") or 0)
        cps = track.get("checkpoints") or {}
        cp = cps.get(cp_key) if isinstance(cps, dict) else None
        if not isinstance(cp, dict):
            continue
        end_ms = min(int(cp.get("due_ms") or now_ms), now_ms)
        if not tid or not sym or sig_ms <= 0:
            continue
        try:
            klines = await _fetch_klines(
                session, base_url=base_url, sym=sym, sig_ms=sig_ms, end_ms=end_ms
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("潜力检查点 K 线失败 %s %s: %s", sym, cp_key, exc)
            apply_checkpoint(tid, cp_key, {"ok": False, "error": str(exc)})
            n += 1
            continue
        result = compute_window_excursions(
            klines or [],
            signal_time_ms=sig_ms,
            window_end_ms=end_ms,
            direction=str(track.get("direction") or "long"),
            entry_price=track.get("entry_price"),
        )
        apply_checkpoint(tid, cp_key, result)
        n += 1
    return n


async def run_potential_outcome_pass(
    session: aiohttp.ClientSession,
    *,
    base_url: str = FAPI_BASE_URL,
) -> int:
    if not POTENTIAL_OUTCOME_ENABLED:
        return 0
    await run_potential_checkpoint_pass(session, base_url=base_url)
    now_ms = int(time.time() * 1000)
    due = list_due_for_settlement(now_ms)[:POTENTIAL_OUTCOME_MAX_SETTLE_PER_PASS]
    if not due:
        return 0
    n = 0
    for track in due:
        tid = str(track.get("id") or "")
        sym = str(track.get("symbol") or "")
        sig_ms = int(track.get("signal_time_ms") or 0)
        end_ms = int(track.get("window_end_ms") or now_ms)
        if not tid or not sym or sig_ms <= 0:
            continue
        try:
            klines = await _fetch_klines(
                session, base_url=base_url, sym=sym, sig_ms=sig_ms, end_ms=end_ms
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("潜力评判 K 线失败 %s: %s", sym, exc)
            apply_settlement(tid, {"ok": False, "error": str(exc)}, reason=_resolve_settle_reason(track))
            n += 1
            continue
        result = compute_window_excursions(
            klines or [],
            signal_time_ms=sig_ms,
            window_end_ms=end_ms,
            direction=str(track.get("direction") or "long"),
            entry_price=track.get("entry_price"),
        )
        reason = _resolve_settle_reason(track)
        apply_settlement(tid, result, reason=reason)
        if result.get("ok"):
            logger.info(
                "潜力评判 %s %s %s · 盈%s%% 回撤%s%% (%sd窗)",
                sym,
                track.get("model_id"),
                reason,
                result.get("max_profit_pct"),
                result.get("max_drawdown_pct"),
                int(POTENTIAL_TRACK_DAYS) if POTENTIAL_TRACK_DAYS == int(POTENTIAL_TRACK_DAYS) else POTENTIAL_TRACK_DAYS,
            )
        n += 1
    return n
