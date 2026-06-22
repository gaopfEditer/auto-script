"""系统编排：串联四大模块与 WebSocket 事件."""

from __future__ import annotations

import asyncio
import logging
import time

from realtime_btc.config import Settings
from realtime_btc.exchange import BinanceRestClient, BinanceWsClient
from realtime_btc.models import LiquidationEvent, StaticLevelsResult, TrendFilterResult
from realtime_btc.modules import (
    DecisionEngine,
    RealtimeFlowModule,
    StaticLevelsModule,
    TrendFilterModule,
)
from realtime_btc.output import emit_dashboard, format_dashboard

log = logging.getLogger(__name__)


class TradingSystemOrchestrator:
    """主循环：REST 冷启动 + WebSocket 热更新 + 周期性决策."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.rest = BinanceRestClient(settings)
        self.ws = BinanceWsClient(settings)
        self.trend_mod = TrendFilterModule(settings, self.rest)
        self.static_mod = StaticLevelsModule(settings, self.rest)
        self.flow_mod = RealtimeFlowModule(settings, self.rest)
        self.decision_mod = DecisionEngine(settings)

        self._trend: TrendFilterResult | None = None
        self._levels: StaticLevelsResult | None = None
        self._last_dashboard_ts = 0.0
        self._refresh_static_interval = 300.0
        self._last_static_refresh = 0.0

    def bootstrap(self) -> None:
        log.info("冷启动：拉取趋势与静态空间…")
        if self.settings.proxy_url:
            log.info("网络代理: %s", self.settings.proxy_url)
        else:
            log.warning(
                "未配置 BINANCE_PROXY；若连接 fapi.binance.com 超时，"
                "请在 .env 添加 BINANCE_PROXY=http://127.0.0.1:7890"
            )
        try:
            self.flow_mod.seed_oi_history()
        except Exception as e:
            log.warning("OI 预热跳过: %s", e)
        self._refresh_static(force=True)

    def _refresh_static(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_static_refresh < self._refresh_static_interval:
            return
        self._trend = self.trend_mod.evaluate()
        vegas_1h = (self._trend.trend_1h.ema_fast + self._trend.trend_1h.ema_slow) / 2
        self._levels = self.static_mod.evaluate(vegas_1h)
        self._last_static_refresh = now
        log.info(
            "静态空间已更新 | High[1]=%.2f Low[1]=%.2f POC=%.2f | 趋势=%s",
            self._levels.high_1,
            self._levels.low_1,
            self._levels.poc,
            self._trend.global_trend.value,
        )

    def _wire_ws(self) -> None:
        def on_liq(evt: LiquidationEvent) -> None:
            self.flow_mod.on_liquidation(evt)

        async def on_oi(oi: float, _ts: int) -> None:
            self.flow_mod.on_open_interest(oi)

        async def on_kline(interval: str, _candle, closed: bool) -> None:
            if closed and interval in ("15m", "1h", "4h"):
                self._refresh_static()

        self.ws.on_liquidation(on_liq)
        self.ws.on_open_interest(on_oi)
        self.ws.on_kline(on_kline)

    async def _evaluation_loop(self) -> None:
        while True:
            try:
                self._refresh_static()
                if self._trend is None or self._levels is None:
                    await asyncio.sleep(2)
                    continue

                price = self.ws.runtime.last_price or self.rest.fetch_last_price()
                oi = self.ws.runtime.open_interest or None
                flow = self.flow_mod.evaluate(oi_current=oi)
                c5 = self.ws.runtime.klines.get("5m")
                c15 = self.ws.runtime.klines.get("15m")

                decision = self.decision_mod.evaluate(
                    price=price,
                    trend=self._trend,
                    levels=self._levels,
                    flow=flow,
                    candle_5m=c5,
                    candle_15m=c15,
                )

                now = time.time()
                should_emit = decision.triggered or (now - self._last_dashboard_ts >= 60)
                if should_emit:
                    text = format_dashboard(
                        self.settings.symbol,
                        price,
                        self._trend,
                        self._levels,
                        decision,
                    )
                    emit_dashboard(self.settings, text)
                    self._last_dashboard_ts = now
            except Exception as e:
                log.exception("评估循环异常: %s", e)
            await asyncio.sleep(5)

    async def run(self) -> None:
        self.bootstrap()
        self._wire_ws()
        eval_task = asyncio.create_task(self._evaluation_loop(), name="eval-loop")
        try:
            await self.ws.run()
        finally:
            eval_task.cancel()
            await self.ws.stop()
            await asyncio.gather(eval_task, return_exceptions=True)
