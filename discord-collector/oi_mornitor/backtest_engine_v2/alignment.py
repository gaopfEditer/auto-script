"""15m 信号确认、5m 执行路径与已收盘高周期 K 线对齐。"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

INTERVAL_MS = {
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
}


def to_ms(ts: int | float | None) -> int | None:
    if ts is None:
        return None
    t = int(ts)
    return t * 1000 if t < 1_000_000_000_000 else t


def series_ms(df: pd.DataFrame, ts_col: str = "open_time") -> np.ndarray | None:
    if df is None or len(df) == 0 or ts_col not in df.columns:
        return None
    times = df[ts_col].to_numpy(dtype="int64", copy=False)
    if times.size == 0:
        return None
    if int(times[-1]) < 1_000_000_000_000:
        times = times * 1000
    return times


def signal_timeline(signal_open_ts: int, *, signal_tf: str = "15m") -> dict[str, int]:
    """15m 信号只在该柱收盘后确认；成交发生在收盘时刻=下一根开盘。"""
    open_ts = to_ms(signal_open_ts)
    if open_ts is None:
        raise ValueError("missing signal open ts")
    bar_ms = INTERVAL_MS[signal_tf]
    close_ts = open_ts + bar_ms
    return {
        "signalOpenAt": open_ts,
        "signalCloseAt": close_ts,
        "fillAt": close_ts,
    }


def last_closed_idx(
    df: pd.DataFrame | None,
    asof_ts: int,
    interval: str,
    ts_col: str = "open_time",
) -> int | None:
    """asof 时刻及之前已经收盘的最后一根（不含仍在形成的当前柱）。"""
    times = series_ms(df, ts_col)
    if times is None:
        return None
    close_times = times + INTERVAL_MS[interval]
    asof = to_ms(asof_ts)
    if asof is None:
        return None
    j = int(np.searchsorted(close_times, asof, side="right") - 1)
    return j if j >= 0 else None


def first_bar_idx_at_or_after(
    df: pd.DataFrame | None,
    ts: int,
    ts_col: str = "open_time",
) -> int | None:
    times = series_ms(df, ts_col)
    if times is None:
        return None
    t = to_ms(ts)
    if t is None:
        return None
    j = int(np.searchsorted(times, t, side="left"))
    return j if 0 <= j < times.size else None


def bars_from(
    df: pd.DataFrame,
    start_idx: int,
    limit: int | None = None,
) -> list[dict[str, float]]:
    if df is None or len(df) == 0:
        return []
    start = max(0, int(start_idx))
    end = len(df) if limit is None else min(len(df), start + max(0, int(limit)))
    if start >= end:
        return []
    sl = df.iloc[start:end]
    opens = sl["open"].to_numpy(dtype=float, copy=False)
    highs = sl["high"].to_numpy(dtype=float, copy=False)
    lows = sl["low"].to_numpy(dtype=float, copy=False)
    closes = sl["close"].to_numpy(dtype=float, copy=False)
    times = series_ms(sl) if "open_time" in sl.columns else np.arange(start, end, dtype="int64")
    if times is None:
        times = np.arange(start, end, dtype="int64")
    return [
        {"ts": int(ts), "open": float(o), "high": float(h), "low": float(l), "close": float(c)}
        for ts, o, h, l, c in zip(times, opens, highs, lows, closes)
    ]


def execution_path(
    df_5m: pd.DataFrame | None,
    fill_ts: int,
    *,
    limit: int,
) -> list[dict[str, float]]:
    """路径从成交时刻对应的 5m 开盘柱开始，禁止纳入成交前的 K 线。"""
    fill = to_ms(fill_ts)
    if df_5m is None or fill is None:
        return []
    start = first_bar_idx_at_or_after(df_5m, fill)
    if start is None:
        return []
    bars = bars_from(df_5m, start, limit=limit)
    return [b for b in bars if int(b["ts"]) >= fill]


def path_starts_at_or_after_fill(bars: list[dict[str, float]], fill_ts: int) -> bool:
    fill = to_ms(fill_ts) or 0
    return all(int(b["ts"]) >= fill for b in bars)


def acceptance_timing(row: dict[str, Any]) -> list[str]:
    """逐笔验收：不得在成交前走出路径或离场。"""
    issues: list[str] = []
    fill_at = to_ms(row.get("fillAt") or row.get("entryAt"))
    close_at = to_ms(row.get("signalCloseAt"))
    if fill_at is None:
        issues.append("missing_fillAt")
        return issues
    if close_at is not None and fill_at < close_at:
        issues.append("fill_before_15m_close")
    entry_at = to_ms(row.get("entryAt"))
    if entry_at is not None and entry_at < fill_at:
        issues.append("entryAt_before_fill")
    exit_at = to_ms(row.get("exitAt"))
    if exit_at is not None and exit_at < fill_at:
        issues.append("exit_before_fill")
    for ev in row.get("events") or []:
        ev_t = to_ms(ev.get("ts"))
        if ev_t is not None and ev.get("type") not in ("signal_confirmed",) and ev_t < fill_at:
            issues.append(f"event_before_fill:{ev.get('type')}")
            break
    for b in row.get("path_bars") or []:
        if int(b.get("ts") or 0) < fill_at:
            issues.append("path_bar_before_fill")
            break
    return issues
