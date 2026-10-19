"""扫描 / 回测币池（复用区间模块流动性池逻辑）。"""
from __future__ import annotations

from oi_mornitor.range_reversal.symbols import backtest_symbol_list, scan_symbol_list
from oi_mornitor.symbol_aliases import normalize_usdt_symbol
from oi_mornitor.vegas_trend_config import VEGAS_TREND_MAJOR_SYMBOLS

__all__ = ["scan_symbol_list_crypto", "backtest_symbol_list_crypto"]


def scan_symbol_list_crypto() -> list[str]:
    return scan_symbol_list()


def backtest_symbol_list_crypto() -> list[str]:
    majors = [normalize_usdt_symbol(s) for s in VEGAS_TREND_MAJOR_SYMBOLS]
    pool = backtest_symbol_list()
    seen: set[str] = set()
    out: list[str] = []
    for s in majors + pool:
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out
