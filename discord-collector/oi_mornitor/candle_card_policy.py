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
    """形态群 TG：配置了 LONG/OTHER 时仅推送并集内币种；未配置则保持原行为（不按名单挡）。"""
    if not candle_card_watch_configured():
        return True
    n = normalize_focus_symbol(symbol)
    return bool(n) and n in candle_card_watch_symbols()
