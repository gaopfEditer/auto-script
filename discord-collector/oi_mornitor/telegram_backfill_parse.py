"""从 OI 形态 Telegram 卡片文案反解析为 alert 字典（供回溯结算）。"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

_TZ_CN = ZoneInfo("Asia/Shanghai")

_RE_PAIR = re.compile(r"交易对:\s*([^\n]+)", re.I)
_RE_INTERVAL = re.compile(r"周期:\s*(\S+)", re.I)
_RE_TIME = re.compile(r"时间:\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})", re.I)
_RE_PRICE = re.compile(r"(?:现价|价格):\s*([0-9.,]+)", re.I)
_RE_TYPE_CANDLE = re.compile(r"类型:\s*([^\n(]+)", re.I)
_RE_SIGNAL_HEAD = re.compile(r"信号:\s*([^\n(]+)", re.I)
_RE_PATTERN = re.compile(r"形态:\s*([^\n]+)", re.I)

_TYPE_KIND: list[tuple[str, str, str, str]] = [
    # (substring in label, card type, kind, side bear|bull)
    ("连续走平射击之星", "candle_pattern_card", "consecutive_flat_shooting_star", "bear"),
    ("射击之星", "candle_pattern_card", "shooting_star", "bear"),
    ("倒锤子", "candle_pattern_card", "inverted_hammer", "bull"),
    ("底部二次探底", "structure_pattern_card", "bottom_secondary_test", "bull"),
    ("2B", "structure_pattern_card", "spring_2b", "bull"),
    ("Spring", "structure_pattern_card", "spring_2b", "bull"),
    ("头肩", "structure_pattern_card", "hs_vegas_break", "bear"),
    ("M顶", "structure_pattern_card", "m_top_vegas_break", "bear"),
    ("流动性掠夺", "structure_pattern_card", "liquidity_sweep", "bear"),
    ("圆弧", "structure_pattern_card", "curvature_decay", "bear"),
    ("顶部结构", "structure_pattern_card", "hs_vegas_break", "bear"),
]


def _side_from_text(text: str) -> str | None:
    if "看跌" in text or "(空" in text:
        return "bear"
    if "看涨" in text or "(多" in text:
        return "bull"
    return None


def _normalize_symbol(raw: str) -> str:
    s = str(raw or "").strip().upper()
    s = s.replace("/", "").replace(" ", "")
    if s and not s.endswith("USDT"):
        s = f"{s}USDT"
    return s


def _parse_price(raw: str | None) -> float | None:
    if not raw:
        return None
    try:
        n = float(str(raw).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _parse_time_ms(raw: str | None) -> int:
    if not raw:
        return 0
    try:
        dt = datetime.strptime(raw.strip(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=_TZ_CN)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return 0


def _infer_type_kind(label: str, side: str | None) -> tuple[str, str, str] | None:
    lab = str(label or "").strip()
    if not lab:
        return None
    for needle, card_type, kind, default_side in _TYPE_KIND:
        if needle in lab:
            sd = side or default_side
            return card_type, kind, sd
    return None


def parse_oi_telegram_card(text: str, *, fallback_ms: int = 0) -> dict[str, Any] | None:
    """
    解析 notify_telegram 推送的形态/结构卡片正文。
    无法识别或非 OI 卡片时返回 None。
    """
    body = str(text or "").strip()
    if not body or "交易对:" not in body:
        return None
    if "💰" not in body and "交易对" not in body:
        return None

    sym_m = _RE_PAIR.search(body)
    if not sym_m:
        return None
    symbol = _normalize_symbol(sym_m.group(1))

    iv_m = _RE_INTERVAL.search(body)
    interval = iv_m.group(1).strip() if iv_m else ""

    time_m = _RE_TIME.search(body)
    kline_ms = _parse_time_ms(time_m.group(1) if time_m else None)
    if kline_ms <= 0 and fallback_ms > 0:
        kline_ms = int(fallback_ms)

    price_m = _RE_PRICE.search(body)
    price = _parse_price(price_m.group(1) if price_m else None)

    side = _side_from_text(body)
    type_label = ""
    pat_m = _RE_PATTERN.search(body)
    if pat_m:
        type_label = pat_m.group(1).strip()
    if not type_label:
        sig_m = _RE_SIGNAL_HEAD.search(body)
        if sig_m:
            type_label = sig_m.group(1).strip()
    if not type_label:
        ty_m = _RE_TYPE_CANDLE.search(body)
        if ty_m:
            type_label = ty_m.group(1).strip()

    inferred = _infer_type_kind(type_label, side)
    if inferred is None:
        # 结算摘要等非卡片
        if "胜率" in body and "本档" in body:
            return None
        return None
    card_type, kind, side_eff = inferred

    return {
        "type": card_type,
        "symbol": symbol,
        "tradeSymbol": symbol,
        "interval": interval,
        "kind": kind,
        "side": side_eff,
        "type_label": type_label,
        "pattern_label": type_label,
        "price": price,
        "close": price,
        "kline_open_time": kline_ms,
        "kline_close_time": kline_ms,
        "source": "telegram_backfill",
    }
