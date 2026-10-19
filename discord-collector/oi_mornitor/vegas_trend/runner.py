"""维加斯顺势扫描（TG 告警）。"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

import aiohttp

from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.range_reversal.data import fetch_perp_klines
from oi_mornitor.strategy.candle_signals import closed_bar_index, _ts_sec
from oi_mornitor.trendline.signals import enrich_trendline_indicators
from oi_mornitor.vegas_trend.detect import evaluate_vegas_trend_at_bar
from oi_mornitor.vegas_trend.symbols import scan_symbol_list_crypto
from oi_mornitor.vegas_trend_config import VEGAS_TREND_INTERVALS, VEGAS_TREND_KLINE_LIMIT, is_vegas_trend_enabled

logger = logging.getLogger("OI_VegasTrend")

_INTERVAL_MS = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000}
_last: dict[str, int] = {}


def _alert(hit: dict[str, Any], *, meta: dict[str, Any], scan_ts: float) -> dict[str, Any]:
    ts = _ts_sec(int(hit.get("kline_close_time") or hit.get("time") or 0))
    tags = []
    if hit.get("vol_ok"):
        tags.append("放量优选")
    return {
        "symbol": hit.get("symbol"),
        "type": "vegas_trend_signal_card",
        "interval": hit.get("interval"),
        "status": "VEGAS_TREND",
        "type_label": hit.get("type_label"),
        "signal_kind": hit.get("kind"),
        "kind": hit.get("kind"),
        "side": hit.get("side"),
        "pattern": hit.get("pattern"),
        "trend_dir": hit.get("trend_dir"),
        "entry": hit.get("entry"),
        "sl": hit.get("sl"),
        "tp1": hit.get("tp1"),
        "tp2": hit.get("tp2"),
        "invalid_level": hit.get("invalid_level"),
        "step_pct": hit.get("step_pct"),
        "price": hit.get("entry"),
        "close": hit.get("entry"),
        "vol_ratio": hit.get("vol_ratio"),
        "vegas_trend": True,
        "vegas_trend_volume": bool(hit.get("vol_ok")),
        "tags": tags,
        "kline_open_time": ts,
        "time": ts,
        "kline_close_time": hit.get("kline_close_time"),
        "message": hit.get("type_label"),
        "scan_ts": scan_ts,
        "asset_class": "crypto",
        "data_meta": meta,
        "push_mtf_min": 1,
    }


async def run_vegas_trend_scan_once(session: aiohttp.ClientSession) -> list[dict[str, Any]]:
    if not is_vegas_trend_enabled():
        return []
    now_ms = int(time.time() * 1000) - 25_000
    scan_ts = time.time()
    alerts: list[dict[str, Any]] = []
    for sym in scan_symbol_list_crypto():
        for iv in VEGAS_TREND_INTERVALS:
            rows, meta = await fetch_perp_klines(session, sym, iv, limit=VEGAS_TREND_KLINE_LIMIT)
            if not rows:
                continue
            df = enrich_trendline_indicators(klines_to_df(rows))
            idx = closed_bar_index(df, now_ms=now_ms)
            if idx < 80:
                continue
            open_ms = int(df.iloc[idx]["open_time"])
            key = f"{sym}:{iv}"
            if _last.get(key) == open_ms:
                continue
            hit = evaluate_vegas_trend_at_bar(df, idx, symbol=sym, interval=iv)
            if not hit:
                continue
            _last[key] = open_ms
            row = df.iloc[idx]
            hit["kline_close_time"] = int(
                row.get("close_time") or (open_ms + _INTERVAL_MS.get(iv, 900_000) - 1)
            )
            alerts.append(_alert(hit, meta=meta, scan_ts=scan_ts))
    return alerts


async def run_vegas_trend_loop(
    running: Callable[[], bool],
    get_session: Callable[[], aiohttp.ClientSession | None],
) -> None:
    logger.info("维加斯顺势扫描已启动")
    while running():
        session = get_session()
        if session is None:
            await asyncio.sleep(5)
            continue
        try:
            for alert in await run_vegas_trend_scan_once(session):
                from oi_mornitor.notify_telegram import send_vegas_trend_card_telegram_async

                await send_vegas_trend_card_telegram_async(alert)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("维加斯顺势扫描异常: %s", exc)
        await asyncio.sleep(55)
