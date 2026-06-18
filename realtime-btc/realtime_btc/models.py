"""跨模块共享的数据模型."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class GlobalTrend(str, Enum):
    MULTI_ONLY = "MULTI_ONLY"
    SHORT_ONLY = "SHORT_ONLY"
    NEUTRAL = "NEUTRAL"


class LevelKind(str, Enum):
    POC = "POC"
    HIGH_1 = "HIGH_1"
    LOW_1 = "LOW_1"
    VAH = "VAH"
    VAL = "VAL"
    VEGAS_1H = "VEGAS_1H"
    VEGAS_4H = "VEGAS_4H"


class SignalSide(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"


@dataclass
class Candle:
    ts: int
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass
class VegasState:
    ema_fast: float
    ema_slow: float
    close: float

    @property
    def tunnel_top(self) -> float:
        return max(self.ema_fast, self.ema_slow)

    @property
    def tunnel_bottom(self) -> float:
        return min(self.ema_fast, self.ema_slow)

    def trend(self) -> GlobalTrend:
        if self.close > self.tunnel_top:
            return GlobalTrend.MULTI_ONLY
        if self.close < self.tunnel_bottom:
            return GlobalTrend.SHORT_ONLY
        return GlobalTrend.NEUTRAL


@dataclass
class TrendFilterResult:
    symbol: str
    trend_1h: VegasState
    trend_4h: VegasState
    global_trend: GlobalTrend

    @property
    def label_zh(self) -> str:
        if self.global_trend == GlobalTrend.MULTI_ONLY:
            return "【多头强趋势】 (只多不空)"
        if self.global_trend == GlobalTrend.SHORT_ONLY:
            return "【空头强趋势】 (只空不多)"
        return "【震荡区间】 (隧道内观望)"


@dataclass
class PriceLevel:
    price: float
    kind: LevelKind
    label: str
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class StaticLevelsResult:
    symbol: str
    levels: list[PriceLevel]
    high_1: float
    low_1: float
    poc: float
    vah: float
    val: float
    vegas_1h_line: float

    def all_prices(self) -> list[float]:
        return [lv.price for lv in self.levels]


@dataclass
class LiquidationEvent:
    ts_ms: int
    symbol: str
    side: str  # BUY = 空头被平, SELL = 多头被平
    price: float
    qty: float
    usd: float


@dataclass
class RealtimeFlowState:
    symbol: str
    oi_current: float
    oi_delta: float
    oi_spike: bool
    oi_spike_threshold: float
    liquidation_panic: bool
    liquidation_long_usd_1m: float
    liquidation_short_usd_1m: float
    recent_liquidations: list[LiquidationEvent] = field(default_factory=list)


@dataclass
class ConfidenceBreakdown:
    trend: int = 0
    confluence: int = 0
    flow: int = 0
    liquidation: int = 0

    @property
    def total(self) -> int:
        return self.trend + self.confluence + self.flow + self.liquidation

    def tier_zh(self) -> str:
        t = self.total
        if t >= 80:
            return "极高信心，建议分批分仓"
        if t >= 60:
            return "中等信心，轻仓试探"
        if t >= 40:
            return "低信心，观望为主"
        return "信号不足，不建议入场"


@dataclass
class TradeGuidance:
    logic_type: str
    entry_hint: str
    stop_loss: float
    take_profit_1: float
    take_profit_2: float


@dataclass
class DecisionResult:
    symbol: str
    price: float
    triggered: bool
    target_level: PriceLevel | None
    distance_pct: float
    side: SignalSide | None
    confidence: ConfidenceBreakdown
    guidance: TradeGuidance | None
    pin_detected: bool
    notes: list[str] = field(default_factory=list)
