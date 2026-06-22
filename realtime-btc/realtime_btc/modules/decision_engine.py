"""模块 4：决策引擎与信心指数."""

from __future__ import annotations

from realtime_btc.config import Settings
from realtime_btc.indicators import is_bearish_pin, is_bullish_pin
from realtime_btc.models import (
    Candle,
    ConfidenceBreakdown,
    DecisionResult,
    GlobalTrend,
    LevelKind,
    PriceLevel,
    RealtimeFlowState,
    SignalSide,
    StaticLevelsResult,
    TradeGuidance,
    TrendFilterResult,
)


class DecisionEngine:
    """当价格进入关键位误差带时，计算信心指数与操作向导."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @staticmethod
    def distance_pct(price: float, level: float) -> float:
        if level <= 0:
            return 999.0
        return abs(price - level) / level * 100.0

    def nearest_level(
        self, price: float, levels: StaticLevelsResult
    ) -> tuple[PriceLevel | None, float]:
        best: PriceLevel | None = None
        best_dist = 999.0
        for lv in levels.levels:
            d = self.distance_pct(price, lv.price)
            if d < best_dist:
                best_dist = d
                best = lv
        if best is None or best_dist > self.settings.proximity_band_pct:
            return None, best_dist
        return best, best_dist

    def _confluence_at(self, target: PriceLevel, levels: StaticLevelsResult) -> tuple[int, list[str]]:
        """统计与目标价重合的关键位数量（0.15% 内视为重合）."""
        band = 0.15
        hits: list[str] = []
        for lv in levels.levels:
            if lv.kind == target.kind:
                continue
            if self.distance_pct(target.price, lv.price) <= band:
                hits.append(lv.label)
        score = 30 if len(hits) >= 2 else 15
        return score, hits

    def _trend_score(self, side: SignalSide, trend: TrendFilterResult) -> int:
        gt = trend.global_trend
        if side == SignalSide.LONG and gt == GlobalTrend.MULTI_ONLY:
            return 30
        if side == SignalSide.SHORT and gt == GlobalTrend.SHORT_ONLY:
            return 30
        if gt == GlobalTrend.NEUTRAL:
            return 15
        return 0

    def _infer_side(self, target: PriceLevel, price: float) -> SignalSide:
        if target.kind in (LevelKind.LOW_1, LevelKind.VAL):
            return SignalSide.LONG
        if target.kind in (LevelKind.HIGH_1, LevelKind.VAH):
            return SignalSide.SHORT
        return SignalSide.LONG if price <= target.price else SignalSide.SHORT

    def _pin_score(self, candle_5m: Candle | None, candle_15m: Candle | None, side: SignalSide) -> tuple[int, bool]:
        pin = False
        for c in (candle_5m, candle_15m):
            if c is None:
                continue
            if side == SignalSide.LONG and is_bullish_pin(c, self.settings.pin_wick_body_ratio):
                pin = True
            if side == SignalSide.SHORT and is_bearish_pin(c, self.settings.pin_wick_body_ratio):
                pin = True
        return (10 if pin else 0), pin

    def _flow_score(self, flow: RealtimeFlowState, pin_score: int) -> int:
        score = pin_score
        if flow.oi_spike:
            score += 15
        return min(score, 25)

    def _liquidation_score(self, flow: RealtimeFlowState, side: SignalSide) -> tuple[int, str]:
        if not flow.liquidation_panic:
            return 0, ""
        if side == SignalSide.LONG and flow.liquidation_long_usd_1m >= self.settings.liquidation_panic_usd:
            usd = flow.liquidation_long_usd_1m
            return 15, f"WebSocket 已捕获 {usd/1e4:.0f} 万刀多头强平"
        if side == SignalSide.SHORT and flow.liquidation_short_usd_1m >= self.settings.liquidation_panic_usd:
            usd = flow.liquidation_short_usd_1m
            return 15, f"WebSocket 已捕获 {usd/1e4:.0f} 万刀空头强平"
        return 0, ""

    def _guidance(
        self, side: SignalSide, target: PriceLevel, price: float, levels: StaticLevelsResult
    ) -> TradeGuidance:
        offset = target.price * 0.0003
        if side == SignalSide.LONG:
            logic = "多头流动性猎取 (Liquidity Sweep Long)"
            entry = f"等待 15m K 线回抽收盘在 ${target.price + offset:,.0f} 上方（确认收针）"
            sl = min(target.price * 0.997, levels.low_1 * 0.998)
            tp1 = levels.poc if levels.poc > price else price * 1.01
            tp2 = levels.high_1
        else:
            logic = "空头流动性猎取 (Liquidity Sweep Short)"
            entry = f"等待 15m K 线反抽收盘在 ${target.price - offset:,.0f} 下方（确认收针）"
            sl = max(target.price * 1.003, levels.high_1 * 1.002)
            tp1 = levels.poc if levels.poc < price else price * 0.99
            tp2 = levels.low_1
        return TradeGuidance(
            logic_type=logic,
            entry_hint=entry,
            stop_loss=sl,
            take_profit_1=tp1,
            take_profit_2=tp2,
        )

    def evaluate(
        self,
        price: float,
        trend: TrendFilterResult,
        levels: StaticLevelsResult,
        flow: RealtimeFlowState,
        candle_5m: Candle | None = None,
        candle_15m: Candle | None = None,
    ) -> DecisionResult:
        target, dist = self.nearest_level(price, levels)
        if target is None:
            return DecisionResult(
                symbol=self.settings.symbol,
                price=price,
                triggered=False,
                target_level=None,
                distance_pct=dist,
                side=None,
                confidence=ConfidenceBreakdown(),
                guidance=None,
                pin_detected=False,
            )

        side = self._infer_side(target, price)
        trend_pts = self._trend_score(side, trend)
        conf_pts, conf_hits = self._confluence_at(target, levels)
        pin_pts, pin = self._pin_score(candle_5m, candle_15m, side)
        flow_pts = self._flow_score(flow, pin_pts)
        liq_pts, liq_note = self._liquidation_score(flow, side)

        breakdown = ConfidenceBreakdown(
            trend=trend_pts,
            confluence=conf_pts,
            flow=flow_pts,
            liquidation=liq_pts,
        )
        notes = list(conf_hits)
        if liq_note:
            notes.append(liq_note)

        return DecisionResult(
            symbol=self.settings.symbol,
            price=price,
            triggered=True,
            target_level=target,
            distance_pct=dist,
            side=side,
            confidence=breakdown,
            guidance=self._guidance(side, target, price, levels),
            pin_detected=pin,
            notes=notes,
        )
