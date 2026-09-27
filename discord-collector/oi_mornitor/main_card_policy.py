"""MAIN 群（热门/特别关注）推送白名单：币种、周期、信号类型。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.config import MAIN_CARD_INTERVALS, MAIN_CARD_TYPE_PREFIXES
from oi_mornitor.focus_symbols import is_focus_symbol
from oi_mornitor.signal_policy import is_blocked_ticker_alert, normalize_type_label


def _type_label_of(alert: dict[str, Any]) -> str:
    return normalize_type_label(
        str(
            alert.get("type_label")
            or alert.get("pattern_label")
            or alert.get("signal_text")
            or alert.get("status_label")
            or ""
        )
    )


def _matches_main_type(label: str) -> bool:
    if not label:
        return False
    for prefix in MAIN_CARD_TYPE_PREFIXES:
        p = str(prefix or "").strip()
        if not p:
            continue
        if label == p or label.startswith(p):
            return True
    return False


def is_main_card_eligible(alert: dict[str, Any]) -> bool:
    """是否允许推送到 MAIN_CARD_TELEGRAM_CHAT_ID（热门币种精选）。"""
    if not isinstance(alert, dict):
        return False
    sym = str(alert.get("symbol") or "")
    if not is_focus_symbol(sym):
        return False
    iv = str(alert.get("interval") or "").strip().lower()
    if iv not in MAIN_CARD_INTERVALS:
        return False
    lab = _type_label_of(alert)
    if not _matches_main_type(lab):
        return False
    # MAIN 仍遵守全局停推（如 量价推进·空）
    if is_blocked_ticker_alert(alert):
        return False
    return True
