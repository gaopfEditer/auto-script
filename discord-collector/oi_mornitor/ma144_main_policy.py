"""144 均线反转扫描：市值梯队 / 美股·黄金 周期映射。"""
from __future__ import annotations

from oi_mornitor.equity_pool import EQUITY_SYMBOL_ALIASES
from oi_mornitor.focus_symbols import normalize_focus_symbol
from oi_mornitor.ma144_reversal_config import (
    MA144_EQUITY_INTERVALS,
    MA144_T12_INTERVALS,
    MA144_T3_INTERVALS,
)
from oi_mornitor.main_card_policy import main_card_equity_symbols
from oi_mornitor.mcap_tier import resolve_mcap_tier

_EQUITY_USDT: frozenset[str] | None = None


def _equity_usdt_symbols() -> frozenset[str]:
    global _EQUITY_USDT
    if _EQUITY_USDT is None:
        s: set[str] = set()
        for aliases in EQUITY_SYMBOL_ALIASES.values():
            for a in aliases:
                n = normalize_focus_symbol(a)
                if n:
                    s.add(n)
        _EQUITY_USDT = frozenset(s)
    return _EQUITY_USDT


def is_ma144_equity_style_symbol(symbol: str) -> bool:
    """美股代币 / 黄金（PAXG 等）用 4h·1d·1w。"""
    n = normalize_focus_symbol(symbol)
    if not n:
        return False
    if n in main_card_equity_symbols():
        return True
    return n in _equity_usdt_symbols()


def ma144_intervals_for_symbol(symbol: str) -> tuple[str, ...]:
    if is_ma144_equity_style_symbol(symbol):
        return MA144_EQUITY_INTERVALS or ("4h", "1d", "1w")
    tier = resolve_mcap_tier(symbol)
    if tier in ("t1", "t2"):
        return MA144_T12_INTERVALS or ("1h", "4h")
    return MA144_T3_INTERVALS or ("15m", "1h")
