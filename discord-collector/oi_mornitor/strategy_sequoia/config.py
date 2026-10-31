"""Sequoia-X 风格策略参数（加密适配）；默认扫描关闭，优先回测/胜率。"""
from __future__ import annotations

import os

from oi_mornitor.env_parse import env_bool, env_float, env_int, env_str


def _csv_tuple(raw: str, default: tuple[str, ...]) -> tuple[str, ...]:
    parts = [x.strip().lower() for x in str(raw or "").split(",") if x.strip()]
    return tuple(parts) if parts else default


# 实盘扫描默认关；回测 CLI 不依赖此开关
SEQUOIA_SCAN_ENABLED = env_bool("OI_SEQUOIA_SCAN_ENABLED", False)
# 实盘是否推 TG（默认关，仅 ticker + 胜率库）
SEQUOIA_TELEGRAM = env_bool("OI_SEQUOIA_TELEGRAM", False)
# 胜率入库时的多周期共振门槛（默认 1，便于单周期回测/统计）
SEQUOIA_MTF_MIN = max(1, env_int("OI_SEQUOIA_MTF_MIN", 1, min_val=1))
SEQUOIA_INTERVALS = _csv_tuple(
    env_str("OI_SEQUOIA_INTERVALS", "15m,1h,4h"),
    ("15m", "1h", "4h"),
)
# 逗号分隔策略 ID；空=全部六种
_SEQUOIA_IDS_RAW = env_str("OI_SEQUOIA_STRATEGY_IDS", "").strip()
SEQUOIA_STRATEGY_IDS: tuple[str, ...] | None = (
    tuple(x.strip() for x in _SEQUOIA_IDS_RAW.split(",") if x.strip())
    if _SEQUOIA_IDS_RAW
    else None
)

# —— TurtleTrade ——
SEQUOIA_TURTLE_N = max(5, env_int("OI_SEQUOIA_TURTLE_N", 20, min_val=5))
SEQUOIA_TURTLE_LIQ_MULT = env_float("OI_SEQUOIA_TURTLE_LIQ_MULT", 1.2, min_val=0.0)
SEQUOIA_TURTLE_REQUIRE_BULL = env_bool("OI_SEQUOIA_TURTLE_REQUIRE_BULL", True)

# —— MaVolume ——
SEQUOIA_MA_SHORT = max(2, env_int("OI_SEQUOIA_MA_SHORT", 10, min_val=2))
SEQUOIA_MA_LONG = max(3, env_int("OI_SEQUOIA_MA_LONG", 30, min_val=3))
SEQUOIA_MA_VOL_MULT = env_float("OI_SEQUOIA_MA_VOL_MULT", 1.5, min_val=0.0)
SEQUOIA_MA_VOL_SMA = max(5, env_int("OI_SEQUOIA_MA_VOL_SMA", 20, min_val=5))

# —— HighTightFlag ——
SEQUOIA_HTF_RUN_LOOKBACK = max(5, env_int("OI_SEQUOIA_HTF_RUN_LOOKBACK", 20, min_val=5))
SEQUOIA_HTF_RUN_MIN_PCT = env_float("OI_SEQUOIA_HTF_RUN_MIN_PCT", 25.0, min_val=0.0)
SEQUOIA_HTF_FLAG_BARS = max(3, env_int("OI_SEQUOIA_HTF_FLAG_BARS", 8, min_val=3))
SEQUOIA_HTF_FLAG_MAX_RANGE_PCT = env_float("OI_SEQUOIA_HTF_FLAG_MAX_RANGE_PCT", 12.0, min_val=0.0)
SEQUOIA_HTF_VOL_SHRINK = env_float("OI_SEQUOIA_HTF_VOL_SHRINK", 0.7, min_val=0.0)

# —— LimitUpShakeout（大阳后阴线回踩仍守前收）——
SEQUOIA_SHAKE_UP_PCT = env_float("OI_SEQUOIA_SHAKE_UP_PCT", 6.0, min_val=0.0)
SEQUOIA_SHAKE_LOOKBACK = max(1, env_int("OI_SEQUOIA_SHAKE_LOOKBACK", 3, min_val=1))
SEQUOIA_SHAKE_HOLD_TOL_PCT = env_float("OI_SEQUOIA_SHAKE_HOLD_TOL_PCT", 0.3, min_val=0.0)

# —— UptrendLimitDown（趋势中恐慌阴 + 放量）——
SEQUOIA_ULD_TREND_LOOKBACK = max(5, env_int("OI_SEQUOIA_ULD_TREND_LOOKBACK", 30, min_val=5))
SEQUOIA_ULD_TREND_MIN_PCT = env_float("OI_SEQUOIA_ULD_TREND_MIN_PCT", 8.0, min_val=0.0)
SEQUOIA_ULD_DUMP_PCT = env_float("OI_SEQUOIA_ULD_DUMP_PCT", 5.0, min_val=0.0)
SEQUOIA_ULD_VOL_MULT = env_float("OI_SEQUOIA_ULD_VOL_MULT", 1.8, min_val=0.0)

# —— RpsBreakout ——
SEQUOIA_RPS_LOOKBACK = max(5, env_int("OI_SEQUOIA_RPS_LOOKBACK", 20, min_val=5))
SEQUOIA_RPS_MIN_PERCENTILE = env_float("OI_SEQUOIA_RPS_MIN_PERCENTILE", 80.0, min_val=0.0)
SEQUOIA_RPS_NEAR_HIGH_PCT = env_float("OI_SEQUOIA_RPS_NEAR_HIGH_PCT", 3.0, min_val=0.0)
SEQUOIA_RPS_HIGH_LOOKBACK = max(5, env_int("OI_SEQUOIA_RPS_HIGH_LOOKBACK", 55, min_val=5))


def is_sequoia_scan_enabled() -> bool:
    return bool(SEQUOIA_SCAN_ENABLED)


# —— 币圈回测流水线默认（backtest/sequoia_pipeline.py）——
SEQUOIA_BT_SL_PCT = env_float("OI_SEQUOIA_BT_SL_PCT", 5.0, min_val=0.0)
SEQUOIA_BT_LEVERAGE = env_float("OI_SEQUOIA_BT_LEVERAGE", 20.0, min_val=1.0)
SEQUOIA_BT_MARGIN_CNY = env_float("OI_SEQUOIA_BT_MARGIN_CNY", 100.0, min_val=0.0)
SEQUOIA_BT_HOLD_BARS = max(1, env_int("OI_SEQUOIA_BT_HOLD_BARS", 5, min_val=1))

# 美股合约轨道（检测用 Sequoia 同款信号；交易所 USDT 本位杠杆）
SEQUOIA_BT_US_SL_PCT = env_float("OI_SEQUOIA_BT_US_SL_PCT", 5.0, min_val=0.0)
SEQUOIA_BT_US_LEVERAGE = env_float("OI_SEQUOIA_BT_US_LEVERAGE", 10.0, min_val=1.0)
SEQUOIA_BT_US_MARGIN_CNY = env_float("OI_SEQUOIA_BT_US_MARGIN_CNY", 100.0, min_val=0.0)
SEQUOIA_BT_US_HOLD_BARS = max(1, env_int("OI_SEQUOIA_BT_US_HOLD_BARS", 5, min_val=1))
