"""配置。"""
from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover

    def load_dotenv(*_a, **_k):  # type: ignore[misc]
        return False


ROOT = Path(__file__).resolve().parent


def _safe_load_dotenv(path: Path) -> None:
    try:
        load_dotenv(path)
    except OSError:
        pass


_safe_load_dotenv(ROOT / ".env")
_safe_load_dotenv(ROOT.parent / ".env")

DATA_DIR = Path(os.getenv("NEWS_DATA_DIR", str(ROOT / "data")))
MACRO_FILE = DATA_DIR / "macro.json"
HOT_FILE = DATA_DIR / "hotlists.json"

HOST = os.getenv("NEWS_HOST") or os.getenv("CRYPTO_PULSE_HOST") or "127.0.0.1"
PORT = int(os.getenv("NEWS_PORT") or os.getenv("CRYPTO_PULSE_PORT") or "8770")

MACRO_MIN_STAR = int(os.getenv("NEWS_MACRO_MIN_STAR", "3"))
MACRO_AHEAD_HOURS = int(os.getenv("NEWS_MACRO_AHEAD_HOURS", "72"))
MACRO_BEHIND_HOURS = int(os.getenv("NEWS_MACRO_BEHIND_HOURS", "72"))
# 宏观时间轴（金十 + PANews）默认 8h；热榜等其它源默认 1h
MACRO_REFRESH_SEC = int(os.getenv("NEWS_MACRO_REFRESH_SEC", str(8 * 3600)))
HOT_REFRESH_SEC = int(os.getenv("NEWS_HOT_REFRESH_SEC", str(3600)))
# 兼容旧环境变量：未单独配置时，NEWS_REFRESH_SEC 只影响热榜间隔
_legacy_refresh = os.getenv("NEWS_REFRESH_SEC")
if _legacy_refresh and not os.getenv("NEWS_HOT_REFRESH_SEC"):
    HOT_REFRESH_SEC = int(_legacy_refresh)
REFRESH_SEC = HOT_REFRESH_SEC  # 兼容旧引用
HTTP_TIMEOUT = float(os.getenv("NEWS_HTTP_TIMEOUT", "25"))

JINSHI_CDN = os.getenv(
    "NEWS_JINSHI_CDN", "https://cdn-rili.jin10.com/web_data"
).rstrip("/")
BINANCE_TRENDS_URL = os.getenv(
    "NEWS_BINANCE_TRENDS_URL",
    "https://www.binance.com/zh-CN/square/trends",
)
OKX_TOPICS_URL = os.getenv(
    "NEWS_OKX_TOPICS_URL",
    "https://www.okx.com/zh-hans/orbit/topics",
)
FORESIGHT_HOME_URL = os.getenv(
    "NEWS_FORESIGHT_URL",
    "https://foresightnews.pro/",
)
FORESIGHT_FEED_URL = os.getenv(
    "NEWS_FORESIGHT_FEED_URL",
    "https://api.foresightnews.pro/v1/feed?page=1&size=30",
)
COINDESK_LATEST_URL = os.getenv(
    "NEWS_COINDESK_URL",
    "https://www.coindesk.com/zh/latest-crypto-news",
)
BLOCKBEATS_FLASH_URL = os.getenv(
    "NEWS_BLOCKBEATS_URL",
    "https://www.theblockbeats.info/newsflash",
)
PANEWS_API_BASE = os.getenv(
    "NEWS_PANEWS_API",
    "https://universal-api.panewslab.com",
).rstrip("/")
PANEWS_CALENDAR_URL = os.getenv(
    "NEWS_PANEWS_CALENDAR_URL",
    "https://www.panewslab.com/zh/calendar",
)

CDP_ENABLED = os.getenv("NEWS_CDP", "1").strip().lower() not in ("0", "false", "no")
CHROME_DEBUG_PORT = int(os.getenv("CHROME_DEBUG_PORT", "9222"))
# 0=仅本机客户端可触发 CDP/立即刷新；1=允许远程 refresh（不推荐）
REFRESH_ALLOW_REMOTE = os.getenv("NEWS_REFRESH_ALLOW_REMOTE", "0").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)


def proxy_url() -> str | None:
    for k in (
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ):
        v = (os.getenv(k) or "").strip()
        if v:
            return v
    return None
