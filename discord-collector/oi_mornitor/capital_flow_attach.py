"""Live：为形态告警附加 capitalFlow（异步拉数 + 写入 alert / 胜率 stub）。"""
from __future__ import annotations

import logging
from typing import Any

import aiohttp

from oi_mornitor.capital_flow_config import CF_ENABLED, CF_FETCH_LIMIT
from oi_mornitor.capital_flow_features import compute_capital_flow
from oi_mornitor.capital_flow_fetch import (
    fetch_funding_at,
    fetch_oi_hist_series,
    fetch_ratio_series,
    fetch_taker_buy_ratio_series,
)
from oi_mornitor.capital_flow_store import liquidations_in_window
from oi_mornitor.exchange_sources import fetch_klines_with_fallback
from oi_mornitor.pattern_signal_time import resolve_signal_at_from_alert

logger = logging.getLogger(__name__)


async def enrich_alert_capital_flow(
    session: aiohttp.ClientSession,
    alert: dict[str, Any],
    *,
    base_url: str,
) -> dict[str, Any] | None:
    if not CF_ENABLED or not isinstance(alert, dict):
        return None
    sym = str(alert.get("symbol") or alert.get("tradeSymbol") or "").strip()
    iv = str(alert.get("interval") or "15m").strip()
    signal_at = resolve_signal_at_from_alert(alert)
    if not sym or signal_at <= 0:
        return None
    try:
        klines, _src = await fetch_klines_with_fallback(
            session,
            symbol=sym,
            interval=iv,
            limit=CF_FETCH_LIMIT,
            end_time=signal_at,
            binance_base_url=base_url,
        )
        oi = await fetch_oi_hist_series(
            session,
            symbol=sym,
            interval=iv,
            limit=CF_FETCH_LIMIT,
            primary_base=base_url,
            end_time_ms=signal_at,
        )
        funding = await fetch_funding_at(
            session, symbol=sym, signal_at_ms=signal_at, primary_base=base_url
        )
        global_ls = await fetch_ratio_series(
            session,
            endpoint="globalLongShortAccountRatio",
            symbol=sym,
            interval=iv,
            limit=CF_FETCH_LIMIT,
            primary_base=base_url,
            end_time_ms=signal_at,
        )
        top_pos = await fetch_ratio_series(
            session,
            endpoint="topLongShortPositionRatio",
            symbol=sym,
            interval=iv,
            limit=CF_FETCH_LIMIT,
            primary_base=base_url,
            end_time_ms=signal_at,
        )
        taker = await fetch_taker_buy_ratio_series(
            session,
            symbol=sym,
            interval=iv,
            limit=CF_FETCH_LIMIT,
            primary_base=base_url,
            end_time_ms=signal_at,
        )
        liq = liquidations_in_window(
            sym,
            start_ms=signal_at - 12 * 3600_000,
            end_ms=signal_at,
        )
        cf = compute_capital_flow(
            signal_at_ms=signal_at,
            klines=klines,
            oi_series=oi,
            funding_rate=funding,
            global_ls=global_ls,
            top_pos_ls=top_pos,
            taker_buy=taker,
            liq_events=liq,
        )
        alert["capitalFlow"] = cf
        return cf
    except Exception as exc:  # noqa: BLE001
        logger.debug("capitalFlow 附加失败 %s: %s", sym, exc)
        return None


async def enrich_alert_capital_flow_auto(alert: dict[str, Any]) -> dict[str, Any] | None:
    """从 RadarService 取 session / base_url。"""
    if not CF_ENABLED:
        return None
    try:
        from oi_mornitor.radar import get_service

        svc = get_service()
        session = await svc._ensure_session()
        base = svc.radar.base_url
        return await enrich_alert_capital_flow(session, alert, base_url=base)
    except Exception as exc:  # noqa: BLE001
        logger.debug("capitalFlow auto 失败: %s", exc)
        return None
