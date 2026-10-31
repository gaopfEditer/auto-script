"""实盘/扫描：对 klines_map 跑 Sequoia（默认由 OI_SEQUOIA_SCAN_ENABLED 控制）。"""
from __future__ import annotations

import logging
import time
from typing import Any

import pandas as pd

from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.strategy_sequoia import config as cfg
from oi_mornitor.strategy_sequoia.bridge import hit_to_alert
from oi_mornitor.strategy_sequoia.strategies import detect_last_closed

logger = logging.getLogger(__name__)


def _df_from_klines(klines: list[list[Any]] | None) -> pd.DataFrame:
    if not klines:
        return pd.DataFrame()
    try:
        return klines_to_df(klines)
    except Exception:  # noqa: BLE001
        return pd.DataFrame()


def scan_sequoia_ticker_alerts(
    klines_by_interval: dict[str, dict[str, list[list[Any]]]],
    *,
    scan_ts: float | None = None,
    strategy_ids: tuple[str, ...] | list[str] | None = None,
    now_ms: int | None = None,
    force: bool = False,
) -> list[dict[str, Any]]:
    """
    klines_by_interval: { "15m": { "BTCUSDT": [[...], ...] }, "1h": {...} }
    """
    if not force and not cfg.is_sequoia_scan_enabled():
        return []
    ts = float(scan_ts if scan_ts is not None else time.time())
    intervals = [iv for iv in cfg.SEQUOIA_INTERVALS if iv in (klines_by_interval or {})]
    if not intervals:
        intervals = list((klines_by_interval or {}).keys())
    alerts: list[dict[str, Any]] = []
    for iv in intervals:
        sym_map = klines_by_interval.get(iv) or {}
        for sym, klines in sym_map.items():
            df = _df_from_klines(klines)
            if df.empty:
                continue
            try:
                hits = detect_last_closed(df, now_ms=now_ms, strategy_ids=strategy_ids)
            except Exception as exc:  # noqa: BLE001
                logger.debug("sequoia detect %s %s: %s", sym, iv, exc)
                continue
            for hit in hits:
                alert = hit_to_alert(hit, symbol=str(sym), interval=str(iv), scan_ts=ts)
                alerts.append(alert)
    return alerts
