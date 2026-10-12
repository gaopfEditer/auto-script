"""潜力信号事后评判：观察窗与 K 线粒度。"""
from __future__ import annotations

import os

POTENTIAL_OUTCOME_ENABLED = os.environ.get("OI_POTENTIAL_OUTCOME_ENABLED", "1").strip().lower() not in (
    "0",
    "false",
    "no",
)
POTENTIAL_OUTCOME_HOURS = float(os.environ.get("OI_POTENTIAL_OUTCOME_HOURS") or "12")
POTENTIAL_OUTCOME_KLINE_IV = str(os.environ.get("OI_POTENTIAL_OUTCOME_KLINE_IV") or "15m").strip() or "15m"
POTENTIAL_OUTCOME_MAX_SETTLE_PER_PASS = max(
    1, int(os.environ.get("OI_POTENTIAL_OUTCOME_MAX_SETTLE") or "24")
)
