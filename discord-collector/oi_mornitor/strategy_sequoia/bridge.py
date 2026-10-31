"""Sequoia 命中 → 与量价/形态卡片同形的 alert，可进 ticker / 胜率库。"""
from __future__ import annotations

import time
from typing import Any

from oi_mornitor.strategy_sequoia import config as cfg


def hit_to_alert(
    hit: dict[str, Any],
    *,
    symbol: str,
    interval: str,
    scan_ts: float | None = None,
    source: str = "sequoia_scan",
) -> dict[str, Any]:
    """产出 record_alert_from_push / ticker 可消费的结构。"""
    sym = str(symbol or "").strip().upper()
    iv = str(interval or "").strip().lower()
    side = str(hit.get("side") or "long").lower()
    if side in ("bull",):
        side = "long"
    elif side in ("bear",):
        side = "short"
    open_ms = int(hit.get("open_time") or 0)
    close_ms = int(hit.get("close_time") or open_ms)
    if close_ms and close_ms < 1e12:
        close_ms *= 1000
    if open_ms and open_ms < 1e12:
        open_ms *= 1000
    price = float(hit.get("price") or hit.get("close") or 0)
    kind = str(hit.get("kind") or hit.get("strategy_id") or "sequoia")
    type_label = str(hit.get("type_label") or kind)
    ts = float(scan_ts if scan_ts is not None else time.time())
    return {
        "symbol": sym,
        "type": "sequoia_card",
        "sequoia_id": str(hit.get("strategy_id") or kind),
        "kind": kind,
        "signal_kind": kind,
        "type_label": type_label,
        "status_label": type_label,
        "side": side,
        "interval": iv,
        "price": price,
        "close": price,
        "entry_hint": price,
        "message": str(hit.get("reason") or type_label),
        "kline_open_time": open_ms,
        "kline_close_time": close_ms or open_ms,
        "scan_ts": ts,
        "source": source,
        "observation_only": False,
        "bar_index": hit.get("bar_index"),
        "sequoia_meta": {
            k: hit.get(k)
            for k in (
                "break_level",
                "vol_ratio",
                "run_pct",
                "flag_range_pct",
                "rps_percentile",
                "dump_pct",
                "trend_pct",
                "up_pct",
            )
            if hit.get(k) is not None
        },
    }


def record_sequoia_alert(alert: dict[str, Any]) -> dict[str, Any] | None:
    """写入胜率库；使用 Sequoia 专用 MTF 门槛（默认 1）。"""
    from oi_mornitor.pattern_alert_stats import record_alert_from_push
    from oi_mornitor.pattern_push_gate import passes_push_mtf_gate

    if not isinstance(alert, dict):
        return None
    # 预检：仅用 Sequoia MTF 门槛，避免被全局 OI_PATTERN_PUSH_MTF_MIN=2 卡死回测
    if not passes_push_mtf_gate(alert, min_tiers=cfg.SEQUOIA_MTF_MIN):
        return None
    # record_alert_from_push 内部仍会走全局 MTF；塞标记让 gate 识别
    stub = dict(alert)
    stub["_sequoia_mtf_min"] = int(cfg.SEQUOIA_MTF_MIN)
    return record_alert_from_push(stub)
