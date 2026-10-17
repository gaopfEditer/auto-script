"""区间反转扫描循环（TG 告警）。"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

import aiohttp

from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.range_reversal.data import fetch_perp_klines
from oi_mornitor.range_reversal.detect import evaluate_range_reversal_at_bar
from oi_mornitor.range_reversal.symbols import scan_symbol_list
from oi_mornitor.range_reversal_config import (
    RANGE_REVERSAL_INTERVALS,
    is_range_reversal_enabled,
)
from oi_mornitor.strategy.candle_signals import closed_bar_index, _ts_sec
from oi_mornitor.trendline.signals import enrich_trendline_indicators

logger = logging.getLogger("OI_RangeReversal")

_INTERVAL_MS = {
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
}

_last_bar: dict[str, int] = {}


def _key(sym: str, iv: str) -> str:
    return f"{sym}:{iv}"


def _should_emit(sym: str, iv: str, open_ms: int) -> bool:
    k = _key(sym, iv)
    if _last_bar.get(k) == open_ms:
        return False
    _last_bar[k] = open_ms
    return True


def _alert_from_hit(hit: dict[str, Any], *, meta: dict[str, Any], scan_ts: float) -> dict[str, Any]:
    close_ts = _ts_sec(int(hit.get("kline_close_time") or hit.get("time") or 0))
    return {
        "symbol": hit.get("symbol"),
        "type": "range_reversal_signal_card",
        "interval": hit.get("interval"),
        "status": "RANGE_REV",
        "status_label": hit.get("type_label"),
        "signal_kind": hit.get("kind"),
        "kind": hit.get("kind"),
        "side": hit.get("side"),
        "type_label": hit.get("type_label"),
        "pattern": hit.get("pattern"),
        "range_high": hit.get("range_high"),
        "range_low": hit.get("range_low"),
        "entry": hit.get("entry"),
        "sl": hit.get("sl"),
        "tp1": hit.get("tp1"),
        "tp2": hit.get("tp2"),
        "step_pct": hit.get("step_pct"),
        "invalid_level": hit.get("invalid_level"),
        "price": hit.get("entry"),
        "close": hit.get("entry"),
        "vol_ratio": hit.get("vol_ratio"),
        "tags": (["放量子集"] if hit.get("vol_subset") else []),
        "kline_open_time": close_ts,
        "time": close_ts,
        "kline_close_time": hit.get("kline_close_time"),
        "message": hit.get("type_label"),
        "scan_ts": scan_ts,
        "asset_class": "crypto",
        "data_source": meta.get("data_source"),
        "data_meta": meta,
        "push_mtf_min": 1,
    }


async def run_range_reversal_scan_once(session: aiohttp.ClientSession) -> list[dict[str, Any]]:
    if not is_range_reversal_enabled():
        return []
    now_ms = int(time.time() * 1000) - 25_000
    scan_ts = time.time()
    alerts: list[dict[str, Any]] = []
    for sym in scan_symbol_list():
        for iv in RANGE_REVERSAL_INTERVALS:
            rows, meta = await fetch_perp_klines(session, sym, iv)
            if not rows:
                continue
            df = enrich_trendline_indicators(klines_to_df(rows))
            idx = closed_bar_index(df, now_ms=now_ms)
            if idx < 20:
                continue
            open_ms = int(df.iloc[idx]["open_time"])
            if not _should_emit(sym, iv, open_ms):
                continue
            hit = evaluate_range_reversal_at_bar(
                df, idx, symbol=sym, interval=iv, require_range=True
            )
            if not hit:
                continue
            row = df.iloc[idx]
            hit["kline_close_time"] = int(row.get("close_time") or (open_ms + _INTERVAL_MS.get(iv, 900_000) - 1))
            hit["time"] = int(open_ms // 1000)
            alerts.append(_alert_from_hit(hit, meta=meta, scan_ts=scan_ts))
    return alerts


async def run_range_reversal_loop(
    running: Callable[[], bool],
    get_session: Callable[[], aiohttp.ClientSession | None],
) -> None:
    logger.info("区间反转扫描循环已启动")
    while running():
        session = get_session()
        if session is None:
            await asyncio.sleep(5)
            continue
        try:
            alerts = await run_range_reversal_scan_once(session)
            for alert in alerts:
                from oi_mornitor.notify_telegram import send_range_reversal_card_telegram_async

                await send_range_reversal_card_telegram_async(alert)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("区间反转扫描异常: %s", exc)
        await asyncio.sleep(50)
