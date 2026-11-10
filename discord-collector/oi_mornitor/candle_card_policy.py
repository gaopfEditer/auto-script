"""形态群（OI_CANDLE_CARD_TELEGRAM_CHAT_ID）推送白名单。"""
from __future__ import annotations

import os
from typing import FrozenSet

from oi_mornitor.focus_symbols import normalize_focus_symbol

try:
    from oi_mornitor.config import (
        CANDLE_CARD_OTHER_SYMBOLS as _CFG_OTHER,
        CANDLE_CARD_LONG_SYMBOLS as _CFG_LONG,
    )
except ImportError:
    _CFG_LONG = None
    _CFG_OTHER = None


def _split_symbols(raw: str) -> list[str]:
    out: list[str] = []
    for part in str(raw or "").replace(";", ",").split(","):
        n = normalize_focus_symbol(part)
        if n and n not in out:
            out.append(n)
    return out


def _env_symbol_csv(name: str) -> list[str]:
    return _split_symbols(os.environ.get(name, ""))


def _configured_lists() -> tuple[list[str], list[str]]:
    long_list: list[str] = []
    other_list: list[str] = []
    if _CFG_LONG is not None:
        long_list = _split_symbols(",".join(str(x) for x in _CFG_LONG if x))
    if _CFG_OTHER is not None:
        other_list = _split_symbols(",".join(str(x) for x in _CFG_OTHER if x))
    if not long_list:
        long_list = _env_symbol_csv("OI_MAIN_CARD_LONG_SYMBOLS")
    if not other_list:
        other_list = _env_symbol_csv("OI_MAIN_CARD_OTHER_SYMBOLS")
    return long_list, other_list


def candle_card_watch_configured() -> bool:
    long_list, other_list = _configured_lists()
    return bool(long_list or other_list)


def candle_card_watch_symbols() -> FrozenSet[str]:
    long_list, other_list = _configured_lists()
    if not long_list and not other_list:
        return frozenset()
    syms: set[str] = set(long_list)
    syms.update(other_list)
    return frozenset(syms)


def is_candle_card_push_symbol(symbol: str) -> bool:
    """形态群 TG：优先用 LONG/OTHER 名单；未配置时回退到 MAIN_CARD_DEFAULT_SYMBOLS。
    
    修复说明：原先未配置名单时返回 True 放行所有币种，导致 VVV 等非预期币种推送。
    现改为回退到 MAIN 群白名单，避免筛选失效扩大到全市场。
    """
    n = normalize_focus_symbol(symbol)
    if not n:
        return False
    
    # 优先使用形态群专属名单
    if candle_card_watch_configured():
        return n in candle_card_watch_symbols()
    
    # 回退：未配置时使用 MAIN 群白名单（不放行全市场）
    from oi_mornitor.main_card_policy import is_main_card_symbol
    return is_main_card_symbol(n)
