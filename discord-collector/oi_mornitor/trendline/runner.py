"""按 K 线收盘调度：BTC 趋势线 + QQQ 趋势线/EMA144（仅 TG 告警）。"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

import aiohttp

from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.trendline.btc_data import fetch_btc_perp_klines
from oi_mornitor.trendline.signals import detect_active_lines, find_last_closed_trendline_hit
from oi_mornitor.trendline.store import update_series
from oi_mornitor.trendline.yahoo_data import fetch_yahoo_klines
from oi_mornitor.trendline_config import (
    TRENDLINE_BAR_CLOSE_GRACE_SEC,
    TRENDLINE_BTC_EMA_INTERVALS,
    TRENDLINE_BTC_INTERVALS,
    TRENDLINE_BTC_SYMBOL,
    TRENDLINE_QQQ_INTERVALS,
    TRENDLINE_QQQ_SYMBOL,
    TRENDLINE_QQQ_TICKER,
    is_trendline_enabled,
)

logger = logging.getLogger("OI_Trendline")

_INTERVAL_MS = {
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
    "1w": 7 * 86_400_000,
    "1wk": 7 * 86_400_000,
}

_last_bar: dict[str, int] = {}


def _bar_key(asset: str, interval: str) -> str:
    return f"{asset}:{interval}"


def _latest_closed_open_ms(rows: list, interval: str, now_ms: int) -> int | None:
    if not rows:
        return None
    span = _INTERVAL_MS.get(interval, 900_000)
    for row in reversed(rows):
        open_ms = int(row[0])
        close_ms = open_ms + span - 1
        if close_ms <= now_ms:
            return open_ms
    return None


def _should_run(asset: str, interval: str, open_ms: int) -> bool:
    key = _bar_key(asset, interval)
    prev = _last_bar.get(key)
    if prev == open_ms:
        return False
    _last_bar[key] = open_ms
    return True


def _alert_from_hit(
    hit: dict[str, Any],
    *,
    symbol: str,
    asset_class: str,
    data_meta: dict[str, Any],
    scan_ts: float,
) -> dict[str, Any]:
    close_ts = int(hit["time"])
    iv = str(hit["interval"])
    return {
        "symbol": symbol,
        "type": "trendline_signal_card",
        "interval": iv,
        "status": "TRENDLINE",
        "status_label": hit.get("type_label"),
        "signal_kind": hit.get("kind"),
        "kind": hit.get("kind"),
        "side": hit.get("side"),
        "type_label": hit.get("type_label"),
        "signal_text": hit.get("type_label"),
        "pattern": hit.get("pattern"),
        "line_id": hit.get("line_id"),
        "line_price": hit.get("line_price"),
        "line_side": hit.get("line_side"),
        "distance_pct": hit.get("distance_pct"),
        "vol_ratio": hit.get("vol_ratio"),
        "ema144": hit.get("ema144"),
        "tags": hit.get("tags"),
        "entry": hit.get("entry"),
        "sl": hit.get("sl"),
        "tp1": hit.get("tp1"),
        "tp2": hit.get("tp2"),
        "step_pct": hit.get("step_pct"),
        "invalid_level": hit.get("invalid_level"),
        "price": hit.get("entry"),
        "close": hit.get("entry"),
        "kline_open_time": close_ts,
        "time": close_ts,
        "kline_close_time": hit.get("kline_close_time"),
        "message": f"{hit.get('type_label')} · {iv}",
        "scan_ts": scan_ts,
        "asset_class": asset_class,
        "data_source": data_meta.get("data_source"),
        "data_meta": data_meta,
        "observation_only": asset_class == "equity" and str(data_meta.get("error") or "") == "empty",
        "push_mtf_min": 1,
    }


async def _scan_btc_interval(
    session: aiohttp.ClientSession,
    interval: str,
    *,
    now_ms: int,
    scan_ts: float,
) -> list[dict[str, Any]]:
    rows, meta = await fetch_btc_perp_klines(session, interval)
    if not rows:
        return []
    open_ms = _latest_closed_open_ms(rows, interval, now_ms)
    if open_ms is None or not _should_run("BTC", interval, open_ms):
        return []
    df = klines_to_df(rows)
    lines = detect_active_lines(df)
    update_series(
        f"BTC:{interval}",
        {"lines": lines, "meta": meta, "symbol": TRENDLINE_BTC_SYMBOL, "interval": interval},
    )
    htf_df = None
    if interval in ("15m", "1h"):
        h4, _ = await fetch_btc_perp_klines(session, "4h", limit=200)
        if h4:
            htf_df = klines_to_df(h4)
    prefix = f"趋势线·BTC {interval}"
    hit = find_last_closed_trendline_hit(
        df,
        now_ms=now_ms,
        asset="BTC",
        interval=interval,
        type_label_prefix=prefix,
        htf_df=htf_df,
    )
    out: list[dict[str, Any]] = []
    if hit:
        out.append(_alert_from_hit(hit, symbol=TRENDLINE_BTC_SYMBOL, asset_class="crypto", data_meta=meta, scan_ts=scan_ts))
    return out


async def _scan_btc_ema_combo(
    session: aiohttp.ClientSession,
    interval: str,
    *,
    now_ms: int,
    scan_ts: float,
) -> list[dict[str, Any]]:
    rows, meta = await fetch_btc_perp_klines(session, interval)
    if not rows:
        return []
    open_ms = _latest_closed_open_ms(rows, interval, now_ms)
    key = f"BTC-ema:{interval}"
    if open_ms is None:
        return []
    if _last_bar.get(key) == open_ms:
        return []
    df = klines_to_df(rows)
    hit = find_last_closed_trendline_hit(
        df,
        now_ms=now_ms,
        asset="BTC",
        interval=interval,
        type_label_prefix=f"趋势线+EMA144·BTC {interval}",
        bb_ema_combo=True,
    )
    if not hit:
        return []
    _last_bar[key] = open_ms
    return [
        _alert_from_hit(
            hit,
            symbol=TRENDLINE_BTC_SYMBOL,
            asset_class="crypto",
            data_meta=meta,
            scan_ts=scan_ts,
        )
    ]


async def _scan_qqq_interval(
    session: aiohttp.ClientSession,
    interval: str,
    *,
    now_ms: int,
    scan_ts: float,
) -> list[dict[str, Any]]:
    iv = "1wk" if interval in ("1w", "1wk") else interval
    rows, meta = await fetch_yahoo_klines(session, TRENDLINE_QQQ_TICKER, iv)
    if not rows:
        return []
    open_ms = _latest_closed_open_ms(rows, iv, now_ms)
    if open_ms is None or not _should_run("QQQ", iv, open_ms):
        return []
    df = klines_to_df(rows)
    lines = detect_active_lines(df)
    update_series(
        f"QQQ:{iv}",
        {
            "lines": lines,
            "meta": meta,
            "symbol": TRENDLINE_QQQ_SYMBOL,
            "ticker": TRENDLINE_QQQ_TICKER,
            "interval": iv,
        },
    )
    htf_df = None
    if iv in ("4h", "1d"):
        d_rows, _ = await fetch_yahoo_klines(session, TRENDLINE_QQQ_TICKER, "1d")
        if d_rows:
            htf_df = klines_to_df(d_rows)
    prefix = f"趋势线+EMA144·QQQ {iv}" if iv in ("4h", "1d", "1wk") else f"趋势线·QQQ {iv}"
    hit = find_last_closed_trendline_hit(
        df,
        now_ms=now_ms,
        asset="QQQ",
        interval=iv,
        type_label_prefix=prefix,
        htf_df=htf_df,
        require_ema_confluence=iv in ("4h", "1d", "1wk"),
    )
    out: list[dict[str, Any]] = []
    if hit:
        if meta.get("error"):
            meta = {**meta, "observation_note": "settle_data_limited"}
        out.append(
            _alert_from_hit(
                hit,
                symbol=TRENDLINE_QQQ_SYMBOL,
                asset_class="equity",
                data_meta=meta,
                scan_ts=scan_ts,
            )
        )
    return out


async def run_trendline_scan_once(
    session: aiohttp.ClientSession,
) -> list[dict[str, Any]]:
    if not is_trendline_enabled():
        return []
    grace_ms = TRENDLINE_BAR_CLOSE_GRACE_SEC * 1000
    now_ms = int(time.time() * 1000) - grace_ms
    scan_ts = time.time()
    alerts: list[dict[str, Any]] = []
    for iv in TRENDLINE_BTC_INTERVALS:
        alerts.extend(await _scan_btc_interval(session, iv, now_ms=now_ms, scan_ts=scan_ts))
    for iv in TRENDLINE_BTC_EMA_INTERVALS:
        alerts.extend(await _scan_btc_ema_combo(session, iv, now_ms=now_ms, scan_ts=scan_ts))
    for iv in TRENDLINE_QQQ_INTERVALS:
        alerts.extend(await _scan_qqq_interval(session, iv, now_ms=now_ms, scan_ts=scan_ts))
    return alerts


async def run_trendline_loop(
    running: Callable[[], bool],
    get_session: Callable[[], aiohttp.ClientSession | None],
) -> None:
    logger.info("趋势线信号循环已启动")
    while running():
        session = get_session()
        if session is None:
            await asyncio.sleep(5)
            continue
        try:
            alerts = await run_trendline_scan_once(session)
            for alert in alerts:
                from oi_mornitor.notify_telegram import send_trendline_card_telegram_async

                await send_trendline_card_telegram_async(alert)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("趋势线扫描异常: %s", exc)
        await asyncio.sleep(45)


def start_trendline_background(
    running: Callable[[], bool],
    get_session: Callable[[], aiohttp.ClientSession | None],
) -> asyncio.Task[None]:
    return asyncio.create_task(run_trendline_loop(running, get_session), name="oi-trendline-loop")
