"""模块 3：实时能量与爆仓监控."""

from __future__ import annotations

import logging
import statistics
import time

from realtime_btc.config import Settings
from realtime_btc.exchange.rest_client import BinanceRestClient
from realtime_btc.models import LiquidationEvent, RealtimeFlowState

log = logging.getLogger(__name__)


class RealtimeFlowModule:
    """
    监控：
    - WebSocket !forceOrder@arr 强平流
    - OI 变化与 2×StdDev 阈值
    """

    def __init__(self, settings: Settings, rest: BinanceRestClient) -> None:
        self.settings = settings
        self.rest = rest
        self._oi_history: list[float] = []
        self._last_oi: float | None = None
        self._liquidations: list[LiquidationEvent] = []

    def seed_oi_history(self) -> None:
        """启动时用 REST 历史 OI 预热标准差基线；失败不阻塞启动."""
        hist = self.rest.fetch_open_interest_hist(
            period=self.settings.oi_interval,
            limit=self.settings.oi_lookback_bars + 2,
        )
        if not hist:
            log.warning("OI 历史为空，等待 WebSocket @openInterest 推送后再计算放量信号")
            return
        values = [v for _, v in hist]
        self._oi_history = values[-self.settings.oi_lookback_bars :]
        if values:
            self._last_oi = values[-1]
            log.info("OI 历史已预热 %d 条", len(self._oi_history))

    def on_liquidation(self, evt: LiquidationEvent) -> None:
        self._liquidations.append(evt)
        cutoff = int(time.time() * 1000) - self.settings.liquidation_window_sec * 1000
        self._liquidations = [x for x in self._liquidations if x.ts_ms >= cutoff]

    def on_open_interest(self, oi: float) -> None:
        if self._last_oi is not None:
            delta = oi - self._last_oi
            self._oi_history.append(oi)
            if len(self._oi_history) > self.settings.oi_lookback_bars:
                self._oi_history = self._oi_history[-self.settings.oi_lookback_bars :]
        self._last_oi = oi

    def _oi_spike(self, delta: float) -> tuple[bool, float]:
        if len(self._oi_history) < 3:
            return False, 0.0
        deltas = [
            abs(self._oi_history[i] - self._oi_history[i - 1])
            for i in range(1, len(self._oi_history))
        ]
        if len(deltas) < 2:
            return False, 0.0
        std = statistics.pstdev(deltas)
        threshold = self.settings.oi_spike_std_mult * std
        return abs(delta) > threshold and threshold > 0, threshold

    def _liquidation_totals_1m(self) -> tuple[float, float]:
        """返回 (多头被平 USD, 空头被平 USD). SELL=多头强平, BUY=空头强平."""
        cutoff = int(time.time() * 1000) - self.settings.liquidation_window_sec * 1000
        long_usd = 0.0
        short_usd = 0.0
        for evt in self._liquidations:
            if evt.ts_ms < cutoff:
                continue
            if evt.side.upper() == "SELL":
                long_usd += evt.usd
            elif evt.side.upper() == "BUY":
                short_usd += evt.usd
        return long_usd, short_usd

    def evaluate(self, oi_current: float | None = None) -> RealtimeFlowState:
        oi = oi_current if oi_current is not None else self._last_oi
        if oi is None:
            try:
                oi = self.rest.fetch_open_interest()
            except Exception as e:
                log.debug("REST OI 回退失败: %s", e)
                oi = 0.0
        if self._last_oi is None and oi:
            self._last_oi = oi
        prev = self._oi_history[-1] if self._oi_history else (self._last_oi or oi)
        delta = (oi - prev) if oi and prev else 0.0
        oi_spike, threshold = self._oi_spike(delta)
        long_usd, short_usd = self._liquidation_totals_1m()
        panic = (
            long_usd >= self.settings.liquidation_panic_usd
            or short_usd >= self.settings.liquidation_panic_usd
        )
        return RealtimeFlowState(
            symbol=self.settings.symbol,
            oi_current=oi,
            oi_delta=delta,
            oi_spike=oi_spike,
            oi_spike_threshold=threshold,
            liquidation_panic=panic,
            liquidation_long_usd_1m=long_usd,
            liquidation_short_usd_1m=short_usd,
            recent_liquidations=list(self._liquidations),
        )
