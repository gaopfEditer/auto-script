"""Sequoia 回测宇宙：币圈主流 vs 美股合约（交易所 USDT 本位，检测后可开杠杆币股合约）。"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable

from oi_mornitor.equity_pool import (
    EQUITY_CORE_BASES,
    EQUITY_OBSERVE_BASES,
    EQUITY_SATELLITE_BASES,
    EQUITY_SECONDARY_BASES,
    EQUITY_SYMBOL_ALIASES,
)

# 币圈流动性主流（排除币股合约）
# 币圈龙头（filtered / leaders_htf 宇宙）
CRYPTO_LEADER_BASES: tuple[str, ...] = (
    "BTC",
    "ETH",
)

CRYPTO_MAJOR_BASES: tuple[str, ...] = (
    "BTC",
    "ETH",
    "SOL",
    "BNB",
    "XRP",
    "DOGE",
    "ADA",
    "AVAX",
    "LINK",
    "DOT",
    "UNI",
    "NEAR",
    "OP",
    "ARB",
    "SUI",
    "LTC",
    "BCH",
    "ATOM",
    "APT",
    "AAVE",
    "TRX",
    "FIL",
    "1000PEPE",
    "WIF",
    "RENDER",
    "HBAR",
    "CRV",
    "PENDLE",
)

# parquet 里出现过、别名表未覆盖的币股合约
_EXTRA_US_PARQUET: tuple[str, ...] = (
    "AMDSTOCKUSDT",
    "TQQQUSDT",
)


def _parquet_root(klines_root: Path) -> Path:
    pq = klines_root / "parquet"
    return pq if pq.is_dir() else klines_root


def _has_interval(pq: Path, symbol: str, interval: str) -> bool:
    return (pq / symbol.upper() / f"{interval}.parquet").is_file()


def candidate_us_symbols() -> list[str]:
    """白名单别名优先顺序展开 + 额外 parquet 名（去重保序）。"""
    out: list[str] = []
    seen: set[str] = set()
    bases = list(EQUITY_CORE_BASES) + list(EQUITY_SECONDARY_BASES) + list(EQUITY_SATELLITE_BASES)
    # observe 也可回测（标记用），默认纳入数据存在的
    bases += sorted(EQUITY_OBSERVE_BASES)
    for base in bases:
        aliases = EQUITY_SYMBOL_ALIASES.get(base) or (f"{base}USDT",)
        for a in aliases:
            sym = str(a).upper()
            if not sym.endswith("USDT"):
                continue
            if sym in seen:
                continue
            seen.add(sym)
            out.append(sym)
    for extra in _EXTRA_US_PARQUET:
        if extra not in seen:
            seen.add(extra)
            out.append(extra)
    return out


def default_crypto_symbols(klines_root: Path, *, interval: str = "1h") -> list[str]:
    pq = _parquet_root(klines_root)
    out = [f"{b}USDT" for b in CRYPTO_MAJOR_BASES if _has_interval(pq, f"{b}USDT", interval)]
    return out or ["BTCUSDT", "ETHUSDT"]


def default_crypto_leader_symbols(klines_root: Path, *, interval: str = "1h") -> list[str]:
    """BTC/ETH 龙头宇宙（本地有对应周期 parquet 才纳入）。"""
    pq = _parquet_root(klines_root)
    out = [f"{b}USDT" for b in CRYPTO_LEADER_BASES if _has_interval(pq, f"{b}USDT", interval)]
    return out or ["BTCUSDT", "ETHUSDT"]


def default_us_equity_symbols(klines_root: Path, *, interval: str = "1h") -> list[str]:
    """仅保留本地有 K 线的美股/杠杆 ETF 合约。"""
    pq = _parquet_root(klines_root)
    out: list[str] = []
    seen: set[str] = set()
    for sym in candidate_us_symbols():
        if sym in seen:
            continue
        if _has_interval(pq, sym, interval):
            seen.add(sym)
            out.append(sym)
    return out


def default_symbols_for_track(
    track: str,
    klines_root: Path,
    *,
    interval: str = "1h",
) -> list[str]:
    t = (track or "crypto").strip().lower()
    if t in ("us", "us_equity", "equity", "stock"):
        return default_us_equity_symbols(klines_root, interval=interval)
    if t in ("both", "all"):
        # 调用方应分两次跑；这里返回 crypto 以免混池
        return default_crypto_symbols(klines_root, interval=interval)
    return default_crypto_symbols(klines_root, interval=interval)


def filter_existing(symbols: Iterable[str], klines_root: Path, *, interval: str = "1h") -> list[str]:
    pq = _parquet_root(klines_root)
    out: list[str] = []
    for raw in symbols:
        sym = str(raw or "").strip().upper()
        if sym and _has_interval(pq, sym, interval) and sym not in out:
            out.append(sym)
    return out
