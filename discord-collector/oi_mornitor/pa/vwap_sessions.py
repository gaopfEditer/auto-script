"""UTC daily VWAP + optional killzone session levels (crypto 24h convention)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from oi_mornitor.pa.params import KILLZONES, SESSION_ALGO_VERSION, SESSION_TIMEZONE, VWAP_ALGO_VERSION


def compute_vwap(candles: list[dict], algo_version: str = VWAP_ALGO_VERSION) -> dict[str, Any]:
    cum_tp = 0.0
    cum_vol = 0.0
    current_day: int | None = None
    points: list[dict] = []
    for c in candles:
        day = int(c["open_time"] // 86400)
        if current_day is None:
            current_day = day
        elif day != current_day:
            cum_tp, cum_vol = 0.0, 0.0
            current_day = day
        tp = (c["high"] + c["low"] + c["close"]) / 3.0
        vol = float(c.get("volume") or 0.0)
        cum_tp += tp * vol
        cum_vol += vol
        vwap = round(cum_tp / cum_vol, 8) if cum_vol > 0 else None
        points.append({"time": c["open_time"], "vwap": vwap})

    cur = points[-1]["vwap"] if points else None
    return {
        "algo_version": algo_version,
        "anchored_at": current_day * 86400 if current_day is not None else None,
        "current": cur,
        "points": points[-20:],
    }


def vwap_position(close: float, vwap: float | None) -> str | None:
    if vwap is None or vwap <= 0:
        return None
    if close > vwap * 1.0001:
        return "above"
    if close < vwap * 0.9999:
        return "below"
    return "at"


def detect_vwap_reclaim(candles: list[dict], vwap_points: list[dict]) -> str | None:
    """Last closed bar reclaim: was below/above prior bar and now on other side."""
    if len(candles) < 3 or len(vwap_points) < 2:
        return None
    prev_c, cur_c = candles[-2], candles[-1]
    prev_v = vwap_points[-2].get("vwap")
    cur_v = vwap_points[-1].get("vwap")
    if prev_v is None or cur_v is None:
        return None
    prev_close = float(prev_c["close"])
    cur_close = float(cur_c["close"])
    if prev_close < prev_v and cur_close > cur_v:
        return "reclaim_above"
    if prev_close > prev_v and cur_close < cur_v:
        return "reclaim_below"
    return None


def compute_session_levels(candles: list[dict], algo_version: str = SESSION_ALGO_VERSION) -> dict[str, Any]:
    by_zone: dict[str, list[tuple[str, dict]]] = {name: [] for name in KILLZONES}
    for c in candles:
        dt = datetime.fromtimestamp(int(c["open_time"]), tz=timezone.utc)
        day = dt.strftime("%Y-%m-%d")
        hour = dt.hour
        for name, (start, end) in KILLZONES.items():
            if start <= hour < end:
                by_zone[name].append((day, c))

    sessions: list[dict] = []
    for name, (start, end) in KILLZONES.items():
        entries = by_zone[name]
        if not entries:
            continue
        latest_day = max(day for day, _ in entries)
        candles_in = [c for day, c in entries if day == latest_day]
        sessions.append(
            {
                "name": name,
                "day": latest_day,
                "start_hour": start,
                "end_hour": end,
                "high": max(x["high"] for x in candles_in),
                "low": min(x["low"] for x in candles_in),
            }
        )

    return {"algo_version": algo_version, "timezone": SESSION_TIMEZONE, "sessions": sessions}
