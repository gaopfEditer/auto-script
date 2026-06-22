"""模块 1：趋势过滤器 — Vegas 隧道 (EMA 144 / 169)."""

from __future__ import annotations

from realtime_btc.config import Settings
from realtime_btc.exchange.rest_client import BinanceRestClient
from realtime_btc.indicators import closes, last_ema
from realtime_btc.models import GlobalTrend, TrendFilterResult, VegasState


class TrendFilterModule:
    """基于 1H / 4H K 线计算 Global_Trend."""

    def __init__(self, settings: Settings, rest: BinanceRestClient) -> None:
        self.settings = settings
        self.rest = rest

    def _vegas(self, interval: str) -> VegasState:
        candles = self.rest.fetch_ohlcv(interval, limit=max(250, self.settings.vegas_slow + 10))
        c = closes(candles)
        ema_fast = last_ema(c, self.settings.vegas_fast)
        ema_slow = last_ema(c, self.settings.vegas_slow)
        return VegasState(ema_fast=ema_fast, ema_slow=ema_slow, close=c[-1])

    def evaluate(self) -> TrendFilterResult:
        trend_1h = self._vegas("1h")
        trend_4h = self._vegas("4h")
        # 以大级别 4H 为主定义全局趋势
        global_trend = trend_4h.trend()
        if global_trend == GlobalTrend.NEUTRAL:
            global_trend = trend_1h.trend()
        return TrendFilterResult(
            symbol=self.settings.symbol,
            trend_1h=trend_1h,
            trend_4h=trend_4h,
            global_trend=global_trend,
        )

    def vegas_line_1h(self) -> float:
        """1H 隧道中线，供静态空间模块引用."""
        v = self._vegas("1h")
        return (v.ema_fast + v.ema_slow) / 2
