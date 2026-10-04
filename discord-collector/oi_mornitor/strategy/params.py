"""信号参数集（v1.0）。阈值集中、可环境变量覆盖，写入 signal_log.params_version。"""
from __future__ import annotations

import os
from dataclasses import asdict, dataclass


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    return int(raw)


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    return float(raw)


def _env_str(name: str, default: str) -> str:
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip() or default


PARAMS_VERSION = _env_str("OI_SIGNAL_PARAMS_VERSION", "v1.0")

# 长周期 EMA 预热：至少 3 倍周期长度
EMA_WARMUP_MULT = _env_int("OI_KLINE_EMA_WARMUP_MULT", 3)
KLINE_CACHE_MIN_BARS = _env_int("OI_KLINE_CACHE_MIN_BARS", 2028)

# 因果摆动点：左 5 右 3，确认时刻 = 摆动点 + 3
SWING_LEFT = _env_int("OI_SWING_LEFT", 5)
SWING_RIGHT = _env_int("OI_SWING_RIGHT", 3)

# 量价滚动分位（不含当前 K）
VP_THRESHOLD_ROLLING = _env_int("OI_VP_THRESHOLD_ROLLING", 500)
VP_THRESHOLD_MIN_PERIODS = _env_int("OI_VP_THRESHOLD_MIN_PERIODS", 50)
VP_THRESHOLD_QUANTILE = _env_float("OI_VP_THRESHOLD_QUANTILE", 0.8)

# 回测成本
TAKER_FEE_PCT = _env_float("OI_TAKER_FEE_PCT", 0.05)  # 单边，占名义本金 %
SLIPPAGE_PCT = _env_float("OI_SLIPPAGE_PCT", 0.02)

# 倒锤子（真正的长上影底部形态）
INV_HAMMER_WICK_RATIO = _env_float("OI_INV_HAMMER_WICK_RATIO", 2.0)
INV_HAMMER_LOWER_WICK_MAX = _env_float("OI_INV_HAMMER_LOWER_WICK_MAX", 0.25)
INV_HAMMER_BODY_MAX = _env_float("OI_INV_HAMMER_BODY_MAX", 0.35)


def ema_warmup_bars(period: int, *, mult: int | None = None) -> int:
    return int(period) * int(mult if mult is not None else EMA_WARMUP_MULT)


@dataclass(frozen=True)
class SignalParams:
    version: str = PARAMS_VERSION
    ema_warmup_mult: int = EMA_WARMUP_MULT
    kline_cache_min_bars: int = KLINE_CACHE_MIN_BARS
    swing_left: int = SWING_LEFT
    swing_right: int = SWING_RIGHT
    vp_threshold_rolling: int = VP_THRESHOLD_ROLLING
    taker_fee_pct: float = TAKER_FEE_PCT
    slippage_pct: float = SLIPPAGE_PCT

    def to_dict(self) -> dict[str, float | int | str]:
        return asdict(self)


DEFAULT_PARAMS = SignalParams()
