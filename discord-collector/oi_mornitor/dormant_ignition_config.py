"""第三梯队：沉寂阴跌 → 梯级放量点火（1h）。"""
from __future__ import annotations

import os

DORMANT_IGNITION_ENABLED = os.environ.get("OI_DORMANT_IGNITION", "1").strip().lower() not in (
    "0",
    "false",
    "no",
)
DORMANT_IGNITION_INTERVAL_SEC = int(os.environ.get("OI_DORMANT_IGNITION_INTERVAL_SEC") or "900")
DORMANT_IGNITION_TTL_H = float(os.environ.get("OI_DORMANT_IGNITION_TTL_H") or "36")
DORMANT_IGNITION_MAX_SCAN = int(os.environ.get("OI_DORMANT_IGNITION_MAX_SCAN") or "120")
DORMANT_IGNITION_KLINE_LIMIT = int(os.environ.get("OI_DORMANT_IGNITION_KLINE_LIMIT") or "720")
DORMANT_IGNITION_INTERVAL = str(os.environ.get("OI_DORMANT_IGNITION_TF") or "1h").strip()

# 阶段一：沉寂
DORMANT_VOL_RATIO = float(os.environ.get("OI_DORMANT_VOL_RATIO") or "0.30")
DORMANT_ATR_QUANTILE = float(os.environ.get("OI_DORMANT_ATR_QUANTILE") or "0.10")
# 阶段二：点火
IGNITION_VOL_MA5_MULT = float(os.environ.get("OI_IGNITION_VOL_MA5_MULT") or "1.5")
IGNITION_VOL_BAR_MULT = float(os.environ.get("OI_IGNITION_VOL_BAR_MULT") or "2.0")
IGNITION_OI_MA120_MULT = float(os.environ.get("OI_IGNITION_OI_MA120_MULT") or "1.25")
IGNITION_OI_MA72_MULT = float(os.environ.get("OI_IGNITION_OI_MA72_MULT") or "1.25")

# 三阶段漏斗（顶栏「沉寂拉盘」）
FUNNEL_SLOW_INTERVAL_SEC = int(os.environ.get("OI_DORMANT_FUNNEL_SLOW_SEC") or "14400")
FUNNEL_FAST_INTERVAL_SEC = int(os.environ.get("OI_DORMANT_FUNNEL_FAST_SEC") or "900")
FUNNEL_KLINE_LIMIT = int(os.environ.get("OI_DORMANT_FUNNEL_KLINE_LIMIT") or "750")
FUNNEL_MAX_UNIVERSE = int(os.environ.get("OI_DORMANT_FUNNEL_MAX_SCAN") or "180")
FUNNEL_VOL168_VS720 = float(os.environ.get("OI_FUNNEL_VOL168_720") or "0.35")
FUNNEL_ATR_RATIO_MAX = float(os.environ.get("OI_FUNNEL_ATR_RATIO_MAX") or "0.025")
FUNNEL_BB_WIDTH_MAX = float(os.environ.get("OI_FUNNEL_BB_WIDTH_MAX") or "0.06")
FUNNEL_TEST_VOL_MULT = float(os.environ.get("OI_FUNNEL_TEST_VOL_MULT") or "3.0")
FUNNEL_VOL5_VS20 = float(os.environ.get("OI_FUNNEL_VOL5_VS20") or "1.5")
FUNNEL_VOL_BAR_MULT = float(os.environ.get("OI_FUNNEL_VOL_BAR_MULT") or "2.5")
FUNNEL_OI_MA72_MULT = float(os.environ.get("OI_FUNNEL_OI_MA72_MULT") or "1.15")
FUNNEL_FUNDING_HIGH_PCT = float(os.environ.get("OI_FUNNEL_FUNDING_HIGH_PCT") or "-0.03")
