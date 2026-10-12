"""潜力信号 · 异步结算最大盈/回撤。"""
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
    POTENTIAL_OUTCOME_MAX_SETTLE_PER_PASS,
)
from oi_mornitor.potential_outcome_eval import compute_window_excursions
from oi_mornitor.potential_outcome_tracker import (
    SETTLE_12H,
    SETTLE_DROPPED,
    SETTLE_EXITING,
    SETTLE_RENEWED,
    apply_settlement,
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
        return SETTLE_12H
    return SETTLE_12H


async def run_potential_outcome_pass(
    session: aiohttp.ClientSession,
    *,
    base_url: str = FAPI_BASE_URL,
) -> int:
    if not POTENTIAL_OUTCOME_ENABLED:
        return 0
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
        span_ms = end_ms - sig_ms
        bars_needed = min(500, max(48, int(span_ms / (15 * 60 * 1000)) + 5))
        try:
            klines = await fetch_pattern_klines(
                session,
                base_url=base_url,
                symbol=sym,
                interval=POTENTIAL_OUTCOME_KLINE_IV,
                limit=bars_needed,
                end_time=end_ms,
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
                "潜力评判 %s %s %s · 盈%s%% 回撤%s%% (%s)",
                sym,
                track.get("model_id"),
                reason,
                result.get("max_profit_pct"),
                result.get("max_drawdown_pct"),
                f"{POTENTIAL_OUTCOME_HOURS}h窗",
            )
        n += 1
    return n
