"""MAIN 群（热门/特别关注）推送白名单：币种、周期、信号类型。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.config import (
    MAIN_CARD_DEFAULT_SYMBOLS,
    MAIN_CARD_EQUITY_INTERVALS,
    MAIN_CARD_MAJOR_INTERVALS,
    MAIN_CARD_MAJOR_SYMBOLS,
    MAIN_CARD_TYPE_PREFIXES,
)
from oi_mornitor.focus_symbols import normalize_focus_symbol
from oi_mornitor.signal_policy import is_blocked_ticker_alert, normalize_type_label

# MAIN 群 TG 镜像：仅射击之星 / 倒锤子（不含结构、量价）
_MAIN_CANDLE_TYPE_PREFIXES: tuple[str, ...] = (
    "射击之星",
    "倒锤子",
)

_MAIN_SYMBOLS: frozenset[str] | None = None
_MAIN_MAJORS: frozenset[str] | None = None


def _main_card_symbols() -> frozenset[str]:
    global _MAIN_SYMBOLS
    if _MAIN_SYMBOLS is None:
        _MAIN_SYMBOLS = frozenset(
            s
            for s in (normalize_focus_symbol(x) for x in MAIN_CARD_DEFAULT_SYMBOLS)
            if s
        )
    return _MAIN_SYMBOLS


def _main_major_symbols() -> frozenset[str]:
    global _MAIN_MAJORS
    if _MAIN_MAJORS is None:
        _MAIN_MAJORS = frozenset(
            s
            for s in (normalize_focus_symbol(x) for x in MAIN_CARD_MAJOR_SYMBOLS)
            if s
        )
    return _MAIN_MAJORS


def main_card_equity_symbols() -> frozenset[str]:
    """MAIN 白名单内、非 BTC/ETH/SOL 的美股代币等。"""
    return _main_card_symbols() - _main_major_symbols()


def is_main_card_symbol(symbol: str) -> bool:
    """MAIN 群仅推送 env `OI_MAIN_CARD_DEFAULT_SYMBOLS` 中的币种（不含 focus 文件扩展）。"""
    n = normalize_focus_symbol(symbol)
    return bool(n) and n in _main_card_symbols()


def is_main_major_symbol(symbol: str) -> bool:
    n = normalize_focus_symbol(symbol)
    return bool(n) and n in _main_major_symbols()


def main_card_intervals_for_symbol(symbol: str) -> frozenset[str]:
    """主流 BTC/ETH/SOL 与美股代币使用不同周期集合。"""
    if not is_main_card_symbol(symbol):
        return frozenset()
    if is_main_major_symbol(symbol):
        return frozenset(x.strip().lower() for x in MAIN_CARD_MAJOR_INTERVALS if x)
    return frozenset(x.strip().lower() for x in MAIN_CARD_EQUITY_INTERVALS if x)


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


def _main_type_prefixes() -> tuple[str, ...]:
    seen: set[str] = set()
    out: list[str] = []
    for p in (*MAIN_CARD_TYPE_PREFIXES, *_MAIN_CANDLE_TYPE_PREFIXES):
        s = str(p or "").strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return tuple(out)


def _is_main_candle_type_label(label: str) -> bool:
    if not label or label in ("射击之星（2）",):
        return False
    if "（2）" in label:
        return False
    for prefix in _MAIN_CANDLE_TYPE_PREFIXES:
        if label == prefix or label.startswith(prefix):
            return True
    return False


def _matches_main_type(label: str) -> bool:
    if not label:
        return False
    for prefix in _main_type_prefixes():
        if label == prefix or label.startswith(prefix):
            return True
    return False


def is_main_pattern_card(alert: dict[str, Any]) -> bool:
    """蜡烛 / 结构形态卡片（非量价 ticker）。"""
    t = str(alert.get("type") or "")
    return t in ("candle_pattern_card", "structure_pattern_card")


def is_volume_price_card(alert: dict[str, Any]) -> bool:
    """量价 ticker 卡片（量价确认/推进等），不进 MAIN 群。"""
    if not isinstance(alert, dict):
        return False
    if str(alert.get("type") or "") == "volume_price_card":
        return True
    if alert.get("vp_type") or alert.get("vp_formal"):
        return True
    lab = _type_label_of(alert)
    return lab.startswith("量价确认") or lab.startswith("量价推进")


def is_main_card_mirror_eligible(alert: dict[str, Any]) -> bool:
    """MAIN 镜像：白名单币 + 分档周期；仅射击之星/倒锤子蜡烛卡片。"""
    if not isinstance(alert, dict):
        return False
    if is_volume_price_card(alert):
        return False
    if str(alert.get("type") or "") != "candle_pattern_card":
        return False
    sym = str(alert.get("symbol") or "")
    if not is_main_card_symbol(sym):
        return False
    iv = str(alert.get("interval") or "").strip().lower()
    if iv not in main_card_intervals_for_symbol(sym):
        return False
    lab = _type_label_of(alert)
    if not _is_main_candle_type_label(lab):
        return False
    if alert.get("main_mirror_vol_ok") is False:
        return False
    if is_blocked_ticker_alert(alert):
        return False
    return True


def is_main_card_eligible(alert: dict[str, Any]) -> bool:
    """胜率/综合分等：白名单币 + 周期 + 类型前缀（与镜像推送独立）。"""
    if not is_main_card_mirror_eligible(alert):
        return False
    lab = _type_label_of(alert)
    if not _matches_main_type(lab):
        return False
    return True
