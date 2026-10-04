"""回测与实盘共用的检测入口：已收盘 DataFrame → 事件列表。"""
from __future__ import annotations

import logging
from typing import Any

import pandas as pd

from oi_mornitor.strategy.candle_signals import collect_candle_signal_markers, find_last_closed_candle_card_hits
from oi_mornitor.strategy.divergence import detect_macd_divergence
from oi_mornitor.strategy.features import add_core_features, snapshot_bar_features
from oi_mornitor.strategy.ma_confluence import detect_ma_confluence
from oi_mornitor.strategy.structure_signals import detect_structure_events
from oi_mornitor.strategy.wyckoff_signals import detect_wyckoff_events

logger = logging.getLogger(__name__)


def _safe(name: str, fn, df: pd.DataFrame) -> list[dict[str, Any]]:
    try:
        return fn(df)
    except Exception:
        logger.exception("检测器 %s 失败", name)
        return []


def _side_norm(side: str) -> str:
    s = str(side or "").lower()
    if s in ("bull", "long"):
        return "long"
    if s in ("bear", "short"):
        return "short"
    return s


def collect_legacy_pattern_events(df: pd.DataFrame) -> list[dict[str, Any]]:
    markers = _safe("candle_markers", collect_candle_signal_markers, df)
    out: list[dict[str, Any]] = []
    open_by_ts = {}
    if "open_time" in df.columns:
        for i, ot in enumerate(df["open_time"].tolist()):
            open_by_ts[int(ot) // 1000] = i
    for m in markers:
        t = int(m.get("time") or 0)
        idx = open_by_ts.get(t, -1)
        if idx < 0:
            continue
        row = df.iloc[idx]
        close_ts = int(row["close_time"]) if "close_time" in df.columns else int(row.get("open_time") or 0)
        kind = str(m.get("kind") or "")
        side = "long" if kind in ("hammer", "inverted_hammer", "inv_hammer") else "short"
        out.append(
            {
                "family": "pattern",
                "kind": kind,
                "side": side,
                "bar_index": idx,
                "bar_open_ts": int(row.get("open_time") or t * 1000),
                "bar_close_ts": close_ts,
                "price_close": float(row["close"]),
                "strength": 0.6,
                "tags": {
                    "near_vegas": str(m.get("text") or "").startswith("V"),
                    "oi_anomaly": bool(m.get("oi_anomaly")),
                },
                "text": m.get("text"),
            }
        )
    for ev in _safe("structure", detect_structure_events, df):
        idx = int(ev.get("bar_index") or -1)
        if idx < 0 or idx >= len(df):
            continue
        row = df.iloc[idx]
        close_ts = int(row["close_time"]) if "close_time" in df.columns else int(row.get("open_time") or 0)
        out.append(
            {
                "family": "pattern",
                "kind": ev.get("kind"),
                "side": _side_norm(str(ev.get("side") or "")),
                "bar_index": idx,
                "bar_open_ts": int(row.get("open_time") or 0),
                "bar_close_ts": close_ts,
                "price_close": float(row["close"]),
                "strength": 0.7,
                "tags": {"oi_anomaly": bool(ev.get("oi_anomaly"))},
            }
        )
    return out


def collect_all_events(df: pd.DataFrame) -> list[dict[str, Any]]:
    """全历史因果扫描（各检测器内部隔离异常）。"""
    if df is None or df.empty:
        return []
    work = add_core_features(df)
    events: list[dict[str, Any]] = []
    events.extend(collect_legacy_pattern_events(work))
    events.extend(_safe("wyckoff", detect_wyckoff_events, work))
    events.extend(_safe("divergence", detect_macd_divergence, work))
    events.extend(_safe("ma_confluence", detect_ma_confluence, work))
    for ev in events:
        ev["side"] = _side_norm(str(ev.get("side") or ""))
        idx = int(ev.get("bar_index") or -1)
        if 0 <= idx < len(work) and not ev.get("features"):
            ev["features"] = snapshot_bar_features(work.iloc[idx])
    return events


def events_on_bar(events: list[dict[str, Any]], bar_index: int) -> list[dict[str, Any]]:
    return [e for e in events if int(e.get("bar_index") or -1) == bar_index]
