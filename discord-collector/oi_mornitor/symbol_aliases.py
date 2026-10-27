"""合约符号别名：币安千倍合约 ↔ 人类常用名。"""
from __future__ import annotations


def normalize_usdt_symbol(symbol: str) -> str:
    s = str(symbol or "").strip().upper().replace("-", "").replace("_", "")
    if not s:
        return ""
    if s.endswith(("USDC", "BUSD")):
        return f"{s[:-4]}USDT"
    if s.endswith("USDT"):
        return s
    return f"{s}USDT"


def human_base_asset(symbol: str) -> str:
    """1000PEPEUSDT → PEPE；币安千倍/百万倍合约的展示与跨所名。"""
    base = normalize_usdt_symbol(symbol)
    if base.endswith("USDT"):
        base = base[:-4]
    for prefix in ("1000000", "100000", "10000", "1000", "1M"):
        if base.startswith(prefix) and len(base) > len(prefix):
            return base[len(prefix) :]
    return base


def human_usdt_symbol(symbol: str) -> str:
    base = human_base_asset(symbol)
    return f"{base}USDT" if base else ""


_MULTIPLIER_PREFIXES = ("1000", "10000", "100000", "1000000", "1M")


def multiplier_usdt_symbols(symbol: str) -> list[str]:
    """人类名补千倍候选：KORU → 1000KORUSDT。"""
    base = human_base_asset(symbol)
    if not base:
        return []
    raw_base = normalize_usdt_symbol(symbol)
    if raw_base.endswith("USDT"):
        raw_base = raw_base[:-4]
    for prefix in _MULTIPLIER_PREFIXES:
        if raw_base.startswith(prefix) and len(raw_base) > len(prefix):
            return []
    return [f"{p}{base}USDT" for p in _MULTIPLIER_PREFIXES]


def symbol_lookup_candidates(symbol: str, venue: str = "binance") -> list[str]:
    """跨所候选。OKX/Bitget/Gate 优先 PEPEUSDT；币安/Bybit 再兜底 1000PEPEUSDT。"""
    raw = normalize_usdt_symbol(symbol)
    human = human_usdt_symbol(raw)
    multis = multiplier_usdt_symbols(raw)
    prefer_human = venue.lower() in ("okx", "bitget", "gate")
    ordered = [human, raw, *multis] if prefer_human else [raw, human, *multis]
    out: list[str] = []
    for s in ordered:
        if s and s not in out:
            out.append(s)
    return out


# 稳定币本位：几乎无波动，不进雷达/形态/回溯
STABLECOIN_BASES = frozenset({
    "USDT", "USDC", "FDUSD", "TUSD", "USDE", "USDD", "DAI", "BUSD",
    "USD1", "USDP", "GUSD", "FRAX", "PYUSD", "EURC", "EURT", "USTC",
})


def is_stablecoin_symbol(symbol: str) -> bool:
    """USDCUSDT / USDC / 1000USDCUSDT → True。"""
    s = str(symbol or "").strip().upper().replace("-", "").replace("_", "")
    if not s:
        return False
    if s in STABLECOIN_BASES:
        return True
    base = human_base_asset(s)
    return bool(base) and base.upper() in STABLECOIN_BASES
