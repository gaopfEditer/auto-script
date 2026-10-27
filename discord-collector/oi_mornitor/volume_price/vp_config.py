"""量价门禁参数（环境变量可覆盖）。"""
from __future__ import annotations

import os

ER_WINDOW = 48
ER_MIN = float(os.environ.get("OI_VP_ER_MIN") or "0.35")
BB_DAYS = int(os.environ.get("OI_VP_BB_DAYS") or "20")
BB_WIDTH_PCT = float(os.environ.get("OI_VP_BB_WIDTH_PCT") or "30") / 100.0
VOL_BREAK_MULT = float(os.environ.get("OI_VP_VOL_BREAK_MULT") or "1.5")
BREAKOUT_LOOKBACK = int(os.environ.get("OI_VP_BREAKOUT_LOOKBACK") or "20")
RANGE_LOOKBACK = int(os.environ.get("OI_VP_RANGE_LOOKBACK") or "30")
TOP_ZONE_PCT = float(os.environ.get("OI_VP_TOP_ZONE_PCT") or "0.15")
CLOSE_UPPER_FRAC = float(os.environ.get("OI_VP_CLOSE_UPPER_FRAC") or "0.70")
COOLDOWN_BARS = int(os.environ.get("OI_VP_COOLDOWN_BARS") or "8")
PULLBACK_VOL_RATIO = float(os.environ.get("OI_VP_PULLBACK_VOL_RATIO") or "0.80")

_BARS_PER_DAY = {"15m": 96, "1h": 24, "4h": 6, "30m": 48}


def bb_window_bars(tf: str) -> int:
    tf_s = str(tf or "15m").strip().lower()
    return max(BREAKOUT_LOOKBACK, BB_DAYS * _BARS_PER_DAY.get(tf_s, 96))
