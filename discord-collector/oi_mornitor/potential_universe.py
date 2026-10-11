"""潜力扫描 · 预筛币池（spec §3）。"""
from __future__ import annotations

import os
from typing import Any

from oi_mornitor.focus_symbols import normalize_focus_symbol
from oi_mornitor.mcap_tier import resolve_mcap_tier
from oi_mornitor.potential_models_config import load_potential_config
from oi_mornitor.symbol_aliases import is_stablecoin_symbol

# 常见代币化美股后缀（简化排除）
_XSTOCK_HINTS = ("AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "QQQ", "SOXL")


def _is_xstock(sym: str) -> bool:
    base = sym.replace("USDT", "").replace("USDC", "")
    return base in _XSTOCK_HINTS or base.endswith("X")


def pass_universe(
    symbol: str,
    *,
    quote_volume_24h: float,
    mcap_usd: float | None,
    has_perp: bool = True,
) -> tuple[bool, str]:
    cfg = load_potential_config()["universe"]
    sym = normalize_focus_symbol(symbol)
    if not sym or is_stablecoin_symbol(sym):
        return False, "stable"
    if not has_perp:
        return False, "no_perp"
    if float(quote_volume_24h) < float(cfg["min_quote_volume_24h"]):
        return False, "low_volume"
    if cfg.get("exclude_tokenized_stocks") and _is_xstock(sym):
        return False, "xstock"
    tier = resolve_mcap_tier(sym)
    if mcap_usd is not None:
        lo = float(cfg["mcap_min"])
        hi = float(cfg["mcap_max"])
        in_band = lo <= mcap_usd <= hi
        if not in_band:
            relax = os.environ.get("OI_POTENTIAL_RELAX_MCAP", "1").strip().lower() not in (
                "0",
                "false",
                "no",
            )
            if relax and tier in ("t2", "t3"):
                return True, "mcap_tier_out_of_band"
            return False, "mcap_out_of_range"
    else:
        allow_unknown = os.environ.get("OI_POTENTIAL_ALLOW_MCAP_UNKNOWN", "1").strip().lower() not in (
            "0",
            "false",
            "no",
        )
        if allow_unknown and tier in ("t2", "t3"):
            return True, "mcap_unknown"
        return False, "mcap_unknown"
    return True, ""
