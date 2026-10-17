"""扫描 / 回测币种池（主流 + t2/t3 梯队）。"""
from __future__ import annotations

from oi_mornitor.backtest_universe import load_latest_universe
from oi_mornitor.mcap_tier import resolve_mcap_tier
from oi_mornitor.range_reversal_config import (
    RANGE_REVERSAL_BT_ALT_MAX,
    RANGE_REVERSAL_MAJOR_SYMBOLS,
    RANGE_REVERSAL_SCAN_ALT_MAX,
)
from oi_mornitor.symbol_aliases import normalize_usdt_symbol


def _tier_symbols(tiers: tuple[str, ...]) -> list[str]:
    from oi_mornitor.mcap_tier import _load_config

    sym_map, _, _ = _load_config()
    out: list[str] = []
    for sym, tid in sym_map.items():
        if str(tid).lower() in tiers:
            out.append(normalize_usdt_symbol(sym))
    return sorted(set(out))


def pick_liquid_alt_symbols(*, max_n: int, tiers: tuple[str, ...] = ("t2", "t3")) -> list[str]:
    """优先 universe 流动性排序，否则 mcap 配置表。"""
    uni = load_latest_universe()
    majors = {normalize_usdt_symbol(s) for s in RANGE_REVERSAL_MAJOR_SYMBOLS}
    ranked: list[str] = []
    if uni and isinstance(uni.get("symbols"), list):
        for sym in uni["symbols"]:
            n = normalize_usdt_symbol(str(sym))
            if not n or n in majors:
                continue
            if resolve_mcap_tier(n) in tiers:
                ranked.append(n)
    if not ranked:
        ranked = [s for s in _tier_symbols(tiers) if s not in majors]
    seen: set[str] = set()
    out: list[str] = []
    for s in ranked:
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
        if len(out) >= max_n:
            break
    return out


def scan_symbol_list() -> list[str]:
    alts = pick_liquid_alt_symbols(max_n=RANGE_REVERSAL_SCAN_ALT_MAX)
    majors = [normalize_usdt_symbol(s) for s in RANGE_REVERSAL_MAJOR_SYMBOLS]
    seen: set[str] = set()
    out: list[str] = []
    for s in majors + alts:
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def backtest_symbol_list() -> list[str]:
    alts = pick_liquid_alt_symbols(max_n=RANGE_REVERSAL_BT_ALT_MAX)
    majors = [normalize_usdt_symbol(s) for s in RANGE_REVERSAL_MAJOR_SYMBOLS]
    return majors + alts
