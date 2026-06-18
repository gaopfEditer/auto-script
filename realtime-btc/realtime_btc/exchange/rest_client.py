"""交易所 REST 客户端（ccxt）."""

from __future__ import annotations

import logging
from typing import Any

import ccxt

from realtime_btc.config import Settings
from realtime_btc.models import Candle

log = logging.getLogger(__name__)


class BinanceRestClient:
    """通过 ccxt 拉取 K 线与持仓量历史."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        opts: dict[str, Any] = {
            "enableRateLimit": True,
            "timeout": settings.request_timeout_ms,
            "options": {"defaultType": "swap"},
        }
        if settings.api_key:
            opts["apiKey"] = settings.api_key
            opts["secret"] = settings.api_secret
        if settings.proxy_url:
            opts["proxies"] = {
                "http": settings.proxy_url,
                "https": settings.proxy_url,
            }
            log.info("REST 使用代理: %s", settings.proxy_url)
        exchange_cls = getattr(ccxt, settings.exchange_id)
        self.exchange: ccxt.Exchange = exchange_cls(opts)
        self._markets_loaded = False

    def _ensure_markets(self) -> None:
        if not self._markets_loaded:
            self.exchange.load_markets()
            self._markets_loaded = True

    def _fapi_symbol(self) -> str:
        """币安永续原生 symbol，如 BTCUSDT（不依赖 markets 缓存）."""
        return self.settings.symbol

    def fetch_ohlcv(self, interval: str, limit: int = 250) -> list[Candle]:
        self._ensure_markets()
        raw = self.exchange.fetch_ohlcv(
            self.settings.ccxt_symbol,
            timeframe=interval,
            limit=limit,
        )
        return [
            Candle(ts=int(r[0]), open=float(r[1]), high=float(r[2]), low=float(r[3]), close=float(r[4]), volume=float(r[5]))
            for r in raw
        ]

    def fetch_open_interest(self) -> float:
        """当前持仓量."""
        try:
            self._ensure_markets()
            if hasattr(self.exchange, "fetch_open_interest"):
                data = self.exchange.fetch_open_interest(self.settings.ccxt_symbol)
                return float(data.get("openInterestAmount") or data.get("openInterest") or 0)
        except Exception as e:
            log.debug("fetch_open_interest fallback: %s", e)

        resp = self.exchange.fapiPublicGetOpenInterest({"symbol": self._fapi_symbol()})
        return float(resp.get("openInterest", 0))

    def fetch_open_interest_hist(self, period: str = "15m", limit: int = 30) -> list[tuple[int, float]]:
        """币安 OI 历史 → [(timestamp_ms, sum_open_interest), ...]. 失败时返回空列表."""
        try:
            resp = self.exchange.fapiDataGetOpenInterestHist(
                {
                    "symbol": self._fapi_symbol(),
                    "period": period,
                    "limit": limit,
                }
            )
            return [(int(row["timestamp"]), float(row["sumOpenInterest"])) for row in resp]
        except Exception as e:
            log.warning(
                "OI 历史拉取失败（将依赖 WebSocket 实时 OI 预热）: %s。"
                "若在国内网络，请在 .env 设置 BINANCE_PROXY=http://127.0.0.1:7890",
                e,
            )
            return []

    def fetch_last_price(self) -> float:
        self._ensure_markets()
        ticker = self.exchange.fetch_ticker(self.settings.ccxt_symbol)
        return float(ticker.get("last") or ticker.get("close") or 0)
