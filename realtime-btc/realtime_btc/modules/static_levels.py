"""模块 2：静态空间锚定 — 昨日高低、POC/VAH/VAL、1H Vegas."""

from __future__ import annotations

from realtime_btc.config import Settings
from realtime_btc.exchange.rest_client import BinanceRestClient
from realtime_btc.indicators.volume_profile import volume_profile
from realtime_btc.models import LevelKind, PriceLevel, StaticLevelsResult


class StaticLevelsModule:
    """计算核心支撑压力位."""

    def __init__(self, settings: Settings, rest: BinanceRestClient) -> None:
        self.settings = settings
        self.rest = rest

    def evaluate(self, vegas_1h_line: float) -> StaticLevelsResult:
        daily = self.rest.fetch_ohlcv("1d", limit=10)
        if len(daily) < 2:
            raise ValueError("日线数据不足，无法计算昨日高低")

        yesterday = daily[-2]
        recent_3d = daily[-4:-1] if len(daily) >= 4 else daily[:-1]
        poc, vah, val = volume_profile(
            recent_3d,
            bins=self.settings.volume_profile_bins,
            value_area_pct=self.settings.value_area_pct,
        )

        high_1 = yesterday.high
        low_1 = yesterday.low

        levels = [
            PriceLevel(poc, LevelKind.POC, "筹码密集区 POC"),
            PriceLevel(high_1, LevelKind.HIGH_1, "昨日最高价 High[1]"),
            PriceLevel(low_1, LevelKind.LOW_1, "昨日最低价 Low[1]"),
            PriceLevel(vah, LevelKind.VAH, "价值区高点 VAH"),
            PriceLevel(val, LevelKind.VAL, "价值区低点 VAL"),
            PriceLevel(vegas_1h_line, LevelKind.VEGAS_1H, "1H Vegas 隧道中线"),
        ]
        return StaticLevelsResult(
            symbol=self.settings.symbol,
            levels=levels,
            high_1=high_1,
            low_1=low_1,
            poc=poc,
            vah=vah,
            val=val,
            vegas_1h_line=vegas_1h_line,
        )
