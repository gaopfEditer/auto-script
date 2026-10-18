"""资金流共振特征：阈值与环境变量（空值回退安全默认）。"""
from __future__ import annotations

from oi_mornitor.env_parse import env_bool_off, env_float, env_int, env_str

# 总开关（默认开；显式 0/false 关闭）
CF_ENABLED = env_bool_off("OI_CAPITAL_FLOW_ENABLED", True)

# OI 骤降（窗口内峰值 → 当前）
CF_OI_FLUSH_DROP_PCT = env_float("OI_CF_OI_FLUSH_DROP_PCT", 0.10, min_val=0.01, max_val=0.5)
CF_OI_FLUSH_LOOKBACK_BARS = env_int("OI_CF_OI_FLUSH_LOOKBACK", 8, min_val=2, max_val=48)
CF_WICK_BODY_MIN_RATIO = env_float("OI_CF_WICK_BODY_RATIO", 1.8, min_val=0.5, max_val=8.0)

# OI 重建（flush 后）
CF_REBUILD_BARS = env_int("OI_CF_REBUILD_BARS", 5, min_val=2, max_val=16)
CF_REBUILD_OI_RISE_PCT = env_float("OI_CF_REBUILD_OI_RISE_PCT", 0.04, min_val=0.01, max_val=0.3)

# 资金费率（8h 费率小数；0.0005 = 0.05%）
CF_FUNDING_CROWDED_LONG = env_float("OI_CF_FUNDING_LONG", 0.0005, min_val=0.0)
CF_FUNDING_CROWDED_SHORT = env_float("OI_CF_FUNDING_SHORT", -0.0003, max_val=0.0)
CF_FUNDING_NEUTRAL_ABS = env_float("OI_CF_FUNDING_NEUTRAL", 0.0002, min_val=0.0)

# 震荡吸筹 ATR%
CF_QUIET_ATR_PCT_MAX = env_float("OI_CF_QUIET_ATR_PCT", 1.2, min_val=0.1, max_val=10.0)
CF_QUIET_OI_RISE_PCT = env_float("OI_CF_QUIET_OI_RISE_PCT", 0.03, min_val=0.005, max_val=0.2)

# 派发
CF_DIST_VOL_RATIO_MIN = env_float("OI_CF_DIST_VOL_RATIO", 1.4, min_val=1.0, max_val=5.0)
CF_DIST_PRICE_PROG_MAX = env_float("OI_CF_DIST_PRICE_PROG_PCT", 0.35, min_val=0.05, max_val=2.0)

# 清算回收
CF_LIQ_RECLAIM_BARS = env_int("OI_CF_LIQ_RECLAIM_BARS", 3, min_val=1, max_val=8)
CF_LIQ_RECLAIM_WICK_FRAC = env_float("OI_CF_LIQ_RECLAIM_FRAC", 0.5, min_val=0.2, max_val=0.95)
CF_LIQ_PROXY_VOL_RATIO = env_float("OI_CF_LIQ_PROXY_VOL", 1.5, min_val=1.1, max_val=6.0)
CF_LIQ_PROXY_OI_DROP = env_float("OI_CF_LIQ_PROXY_OI_DROP", 0.03, min_val=0.01, max_val=0.3)
CF_LIQ_PROXY_OI_WINDOW = env_int("OI_CF_LIQ_PROXY_OI_WINDOW", 3, min_val=1, max_val=6)

# 拉取 / 缓存
CF_FETCH_LIMIT = env_int("OI_CF_FETCH_LIMIT", 120, min_val=30, max_val=500)
CF_CACHE_TTL_SEC = env_int("OI_CF_CACHE_TTL_SEC", 90, min_val=10, max_val=600)

# 回测完成后附加资金流（默认开；受 max 条数限制）
CF_BACKTEST_ATTACH = env_bool_off("OI_CF_BACKTEST_ATTACH", True)
CF_BACKTEST_MAX_ITEMS = env_int("OI_CF_BACKTEST_MAX", 300, min_val=20, max_val=5000)

# 币安 FAPI 备选（在 OI_FAPI_BASE_URL 之后尝试）
_CF_EXTRA_BASES = env_str("OI_CF_FAPI_FALLBACK_BASES", "https://www.binance.com")
CF_FAPI_FALLBACK_BASES: tuple[str, ...] = tuple(
    b.strip().rstrip("/")
    for b in _CF_EXTRA_BASES.split(",")
    if b.strip()
)
