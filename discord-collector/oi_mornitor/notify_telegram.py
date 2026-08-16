"""形态+OI 短线推荐 → Telegram。"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from oi_mornitor.config import (
    PATTERN_OI_COMBO_TELEGRAM,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    TELEGRAM_PUSH_CHAT_ID,
    TELEGRAM_SEND_URL,
)

logger = logging.getLogger(__name__)


def format_candle_oi_short_message(alert: dict[str, Any]) -> str:
    sym = str(alert.get("symbol") or "").upper()
    iv = str(alert.get("interval") or "")
    sig = str(alert.get("signal_text") or alert.get("message") or "")
    price = alert.get("last_price")
    price_s = f"{float(price):.6g}" if price is not None else "—"
    side_hint = str(alert.get("side_hint") or "短线")
    return (
        f"⚡ {sym} · 形态+OI异动 · 推荐{side_hint}\n"
        f"信号: {sig}\n"
        f"周期: {iv}\n"
        f"现价: {price_s}"
    )


def _send_via_bot_api(text: str, chat_id: str) -> bool:
    try:
        import requests
    except ImportError:
        logger.warning("Telegram: 缺少 requests")
        return False
    if not TELEGRAM_BOT_TOKEN or not chat_id:
        return False
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    try:
        r = requests.post(
            url,
            json={"chat_id": chat_id, "text": text},
            timeout=20,
        )
        body = r.json() if r.content else {}
        ok = bool(isinstance(body, dict) and body.get("ok"))
        if not ok:
            logger.warning("Telegram bot API 失败: %s", body)
        return ok
    except Exception as exc:  # noqa: BLE001
        logger.warning("Telegram bot API 异常: %s", exc)
        return False


def _send_via_http_gateway(text: str, chat_id: str) -> bool:
    if not TELEGRAM_SEND_URL or not chat_id:
        return False
    try:
        import requests
    except ImportError:
        return False
    try:
        r = requests.post(
            TELEGRAM_SEND_URL,
            json={"chat_id": chat_id, "text": text},
            timeout=20,
        )
        if r.status_code >= 400:
            logger.warning("Telegram gateway HTTP %s: %s", r.status_code, r.text[:200])
            return False
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("Telegram gateway 异常: %s", exc)
        return False


def send_pattern_oi_telegram(alert: dict[str, Any]) -> bool:
    """同步发送；未配置或关闭时返回 False。"""
    if not PATTERN_OI_COMBO_TELEGRAM:
        return False
    text = format_candle_oi_short_message(alert)
    chat = (TELEGRAM_PUSH_CHAT_ID or TELEGRAM_CHAT_ID or "").strip()
    if TELEGRAM_SEND_URL and chat:
        if _send_via_http_gateway(text, chat):
            return True
    if TELEGRAM_BOT_TOKEN and chat:
        return _send_via_bot_api(text, chat)
    logger.debug("Telegram 未配置，跳过短线推荐推送")
    return False


async def send_pattern_oi_telegram_async(alert: dict[str, Any]) -> bool:
    return await asyncio.to_thread(send_pattern_oi_telegram, alert)
