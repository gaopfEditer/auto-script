"""形态卡片 / 结构信号 / 形态+OI → Telegram。"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from oi_mornitor.config import (
    CANDLE_CARD_TELEGRAM,
    CANDLE_CARD_TELEGRAM_CHAT_ID,
    PATTERN_OI_COMBO_TELEGRAM,
    STRUCTURE_CARD_TELEGRAM,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    TELEGRAM_PUSH_CHAT_ID,
    TELEGRAM_SEND_URL,
)

logger = logging.getLogger(__name__)

_TZ_CN = timezone(timedelta(hours=8))


def _pair_label(symbol: str) -> str:
    """BTCUSDT → BTCUSD（展示用）。"""
    s = str(symbol or "").upper().strip()
    if s.endswith("USDT"):
        return s[:-1]  # USDT → USD
    if s.endswith("BUSD"):
        return s[:-4] + "USD"
    return s


def _fmt_price(v: Any) -> str:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return "—"
    if abs(n - round(n)) < 1e-9 and abs(n) >= 1:
        return str(int(round(n)))
    s = f"{n:.8f}".rstrip("0").rstrip(".")
    return s or "0"


def _fmt_time(ts_sec: Any) -> str:
    try:
        t = int(ts_sec)
    except (TypeError, ValueError):
        return "—"
    if t > 10_000_000_000:
        t = t // 1000
    return datetime.fromtimestamp(t, _TZ_CN).strftime("%Y-%m-%d %H:%M:%S")


def _fmt_vol_x(v: Any) -> str:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return "—"
    return f"{n:.1f}x"


def format_candle_card_message(alert: dict[str, Any]) -> str:
    """射击之星 / 倒锤子卡片文案。"""
    pair = _pair_label(str(alert.get("symbol") or ""))
    type_label = str(
        alert.get("type_label") or alert.get("signal_text") or alert.get("kind") or "—"
    )
    iv = str(alert.get("interval") or "—")
    t = _fmt_time(alert.get("kline_open_time") or alert.get("time") or 0)
    price = _fmt_price(alert.get("price") if alert.get("price") is not None else alert.get("close"))
    high = _fmt_price(alert.get("high"))
    low = _fmt_price(alert.get("low"))
    return (
        f"💰 交易对: {pair}\n"
        f"📈 类型: {type_label}\n"
        f"⏰ 周期: {iv}\n"
        f"⏰ 时间: {t}\n"
        f"💵 价格: {price}\n"
        f"📈 最高: {high}\n"
        f"📉 最低: {low}"
    )


def format_structure_top_message(alert: dict[str, Any]) -> str:
    """顶部结构确认（头肩 / M顶 / Sweep / 圆弧顶）。"""
    pair = _pair_label(str(alert.get("symbol") or ""))
    iv = str(alert.get("interval") or "—")
    t = _fmt_time(alert.get("kline_open_time") or alert.get("time") or 0)
    pattern = str(alert.get("pattern_label") or alert.get("type_label") or "顶部结构")
    price = _fmt_price(alert.get("price") if alert.get("price") is not None else alert.get("close"))
    head = _fmt_price(alert.get("head_high"))
    vegas = _fmt_price(alert.get("vegas_mid"))
    vol_s = _fmt_vol_x(alert.get("vol_ratio"))
    defense = _fmt_price(alert.get("defense") or alert.get("right_shoulder"))
    support = _fmt_price(alert.get("support_ref") or alert.get("neckline"))
    return (
        f"🚨 信号: 顶部结构确认 (看跌)\n"
        f"💰 交易对: {pair}\n"
        f"⏰ 周期: {iv}\n"
        f"⏰ 时间: {t}\n"
        f"📊 形态: {pattern}\n"
        f"💵 现价: {price}\n"
        f"------------------------\n"
        f"🔍 触发逻辑:\n"
        f"• 头部最高: {head} (右肩承压回落)\n"
        f"• 均线破位: 实体跌破 Vegas 中轨 (EMA 144/169 @ {vegas})\n"
        f"• 量能确认: 破位K线放量 {vol_s} MA20\n"
        f"------------------------\n"
        f"🛡️ 关键防守 (右肩高点): {defense}\n"
        f"🎯 下方支撑参考: {support}"
    )


def format_structure_bottom_message(alert: dict[str, Any]) -> str:
    """底部二次探底 / 2B Spring。"""
    pair = _pair_label(str(alert.get("symbol") or ""))
    iv = str(alert.get("interval") or "—")
    t = _fmt_time(alert.get("kline_open_time") or alert.get("time") or 0)
    pattern = str(alert.get("pattern_label") or alert.get("type_label") or "底部确认")
    price = _fmt_price(alert.get("price") if alert.get("price") is not None else alert.get("close"))
    l1 = _fmt_price(alert.get("l1"))
    l2 = _fmt_price(alert.get("l2"))
    climax = _fmt_vol_x(alert.get("climax_vol_ratio") or alert.get("vol_ratio"))
    close_pct = alert.get("close_pct")
    try:
        pct_s = f"{float(close_pct) * 100:.0f}%"
    except (TypeError, ValueError):
        pct_s = "—"
    defense = _fmt_price(alert.get("defense") or alert.get("l1"))
    resist = _fmt_price(alert.get("resistance_ref"))
    title = str(alert.get("type_label") or "底部二次探底确认")
    return (
        f"🚀 信号: {title} (看涨)\n"
        f"💰 交易对: {pair}\n"
        f"⏰ 周期: {iv}\n"
        f"⏰ 时间: {t}\n"
        f"📊 形态: {pattern}\n"
        f"💵 现价: {price}\n"
        f"------------------------\n"
        f"🔍 触发逻辑:\n"
        f"• 前期低点 (L1): {l1} (伴随 {climax} 恐慌放量插针)\n"
        f"• 二次回踩 (L2): {l2} (未破前低/假跌破收回)\n"
        f"• 确认信号: 出现大实体阳线支撑收盘 (收在前 {pct_s} 高位)\n"
        f"------------------------\n"
        f"🛡️ 关键防守 (插针低点): {defense}\n"
        f"🎯 上方阻力参考: {resist} (Vegas通道)"
    )


def format_structure_card_message(alert: dict[str, Any]) -> str:
    side = str(alert.get("side") or "")
    kind = str(alert.get("kind") or "")
    if side == "bull" or kind in ("spring_2b", "bottom_secondary_test"):
        return format_structure_bottom_message(alert)
    return format_structure_top_message(alert)


def format_candle_oi_short_message(alert: dict[str, Any]) -> str:
    """旧版短线推荐文案（Toast 同源）；卡片推送优先用 format_candle_card_message。"""
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


def _resolve_chat_id(override: str | None = None) -> str:
    return (
        (override or "").strip()
        or CANDLE_CARD_TELEGRAM_CHAT_ID
        or TELEGRAM_PUSH_CHAT_ID
        or TELEGRAM_CHAT_ID
        or ""
    ).strip()


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


def send_telegram_text(text: str, *, chat_id: str | None = None) -> bool:
    chat = _resolve_chat_id(chat_id)
    if not chat:
        logger.debug("Telegram 未配置 chat_id，跳过")
        return False
    if TELEGRAM_SEND_URL and chat:
        if _send_via_http_gateway(text, chat):
            return True
    if TELEGRAM_BOT_TOKEN and chat:
        return _send_via_bot_api(text, chat)
    logger.debug("Telegram 未配置 SEND_URL/BOT_TOKEN，跳过")
    return False


def send_candle_card_telegram(alert: dict[str, Any]) -> bool:
    """射击之星 / 倒锤子卡片 → Telegram 群。"""
    if not CANDLE_CARD_TELEGRAM:
        return False
    text = format_candle_card_message(alert)
    return send_telegram_text(text)


def send_structure_card_telegram(alert: dict[str, Any]) -> bool:
    """顶部/底部结构 → Telegram 群。"""
    if not STRUCTURE_CARD_TELEGRAM:
        return False
    text = format_structure_card_message(alert)
    return send_telegram_text(text)


def send_pattern_oi_telegram(alert: dict[str, Any]) -> bool:
    """同步发送；未配置或关闭时返回 False。

    若已开启蜡烛卡片推送，改用卡片文案，避免两套格式并存。
    """
    if CANDLE_CARD_TELEGRAM:
        if not PATTERN_OI_COMBO_TELEGRAM:
            return False
        if alert.get("high") is not None and alert.get("low") is not None:
            return send_candle_card_telegram(alert)
        return False
    if not PATTERN_OI_COMBO_TELEGRAM:
        return False
    text = format_candle_oi_short_message(alert)
    return send_telegram_text(text)


async def send_pattern_oi_telegram_async(alert: dict[str, Any]) -> bool:
    return await asyncio.to_thread(send_pattern_oi_telegram, alert)


async def send_candle_card_telegram_async(alert: dict[str, Any]) -> bool:
    return await asyncio.to_thread(send_candle_card_telegram, alert)


async def send_structure_card_telegram_async(alert: dict[str, Any]) -> bool:
    return await asyncio.to_thread(send_structure_card_telegram, alert)
