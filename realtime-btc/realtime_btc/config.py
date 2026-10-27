"""系统配置（环境变量 + 默认值）."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(_ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    symbol: str = "BTCUSDT"
    exchange_id: str = "binanceusdm"
    api_key: str = ""
    api_secret: str = ""

    # Vegas 隧道
    vegas_fast: int = 144
    vegas_slow: int = 169

    # 静态空间
    volume_profile_bins: int = 48
    value_area_pct: float = 0.70

    # 实时流
    oi_interval: str = "15m"
    oi_lookback_bars: int = 20
    oi_spike_std_mult: float = 2.0
    liquidation_window_sec: int = 60
    liquidation_panic_usd: float = 1_000_000.0

    # 决策
    proximity_band_pct: float = 0.5
    pin_wick_body_ratio: float = 2.0

    log_level: str = "INFO"
    webhook_url: str = ""

    # 网络（国内访问币安通常需要代理）
    proxy_url: str = ""
    request_timeout_ms: int = 30_000

    kline_intervals: tuple[str, ...] = field(
        default_factory=lambda: ("5m", "15m", "1h", "4h", "1d")
    )

    @property
    def ccxt_symbol(self) -> str:
        """ccxt 统一符号，如 BTC/USDT:USDT."""
        base = self.symbol.replace("USDT", "")
        if self.exchange_id in ("binanceusdm", "binancecoinm"):
            return f"{base}/USDT:USDT"
        return f"{base}/USDT"

    @property
    def ws_symbol_lower(self) -> str:
        return self.symbol.lower()


def _resolve_proxy_url() -> str:
    for key in ("BINANCE_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        v = os.getenv(key, "").strip()
        if v:
            return v
    return ""


def load_settings() -> Settings:
    return Settings(
        symbol=os.getenv("SYMBOL", "BTCUSDT").upper(),
        exchange_id=os.getenv("EXCHANGE_ID", "binanceusdm"),
        api_key=os.getenv("BINANCE_API_KEY", ""),
        api_secret=os.getenv("BINANCE_API_SECRET", ""),
        oi_lookback_bars=int(os.getenv("OI_LOOKBACK_BARS", "20")),
        oi_spike_std_mult=float(os.getenv("OI_SPIKE_STD_MULT", "2.0")),
        liquidation_panic_usd=float(os.getenv("LIQUIDATION_PANIC_USD", "1000000")),
        proximity_band_pct=float(os.getenv("PROXIMITY_BAND_PCT", "0.5")),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        webhook_url=os.getenv("WEBHOOK_URL", "").strip(),
        proxy_url=_resolve_proxy_url(),
        request_timeout_ms=int(os.getenv("BINANCE_REQUEST_TIMEOUT_MS", "30000")),
    )
