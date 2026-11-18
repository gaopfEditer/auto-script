"""5m 振幅分档：工作日 / 周末 / 美股重叠（上海 21:30–04:00）。"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Shanghai")

DOW_AMP = {0: 1.10, 1: 1.14, 2: 1.12, 3: 1.15, 4: 1.18, 5: 0.70, 6: 0.60}
US_RTH_START_H = 21.5
US_RTH_END_H = 4.0
US_OVERLAY_WEEKDAY = 1.10
US_OVERLAY_WEEKEND = 1.05
AMP_CLAMP = (0.55, 1.40)


def _in_us_rth(hour_frac: float) -> bool:
    return hour_frac >= US_RTH_START_H or hour_frac < US_RTH_END_H


def amp_mult(ts_ms: int) -> float:
    dt = datetime.fromtimestamp(int(ts_ms) / 1000, tz=TZ)
    m = float(DOW_AMP.get(dt.weekday(), 1.0))
    hf = dt.hour + dt.minute / 60.0
    if _in_us_rth(hf):
        m *= US_OVERLAY_WEEKDAY if dt.weekday() < 5 else US_OVERLAY_WEEKEND
    lo, hi = AMP_CLAMP
    return max(lo, min(hi, m))


def session_tag(ts_ms: int) -> str:
    dt = datetime.fromtimestamp(int(ts_ms) / 1000, tz=TZ)
    hf = dt.hour + dt.minute / 60.0
    wkend = dt.weekday() >= 5
    us = _in_us_rth(hf)
    if wkend and us:
        return "weekend_us"
    if wkend:
        return "weekend"
    if us:
        return "weekday_us"
    return "weekday"