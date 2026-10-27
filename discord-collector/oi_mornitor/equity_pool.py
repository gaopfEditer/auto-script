"""币股白名单池：按 24h 成交额入池，与加密 OI 分层池并行。"""
from __future__ import annotations

import logging
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from oi_mornitor.config import (
    OI_EQUITY_ENABLED,
    OI_EQUITY_MAX_POOL,
    OI_EQUITY_MIN_TURNOVER_USD,
    OI_EQUITY_SESSION_END_UTC,
    OI_EQUITY_SESSION_START_UTC,
    OI_EQUITY_SIGNAL_SESSION_ONLY,
    OI_EQUITY_WHITELIST_EXTRA,
)
from oi_mornitor.symbol_aliases import is_stablecoin_symbol

logger = logging.getLogger("OI_Radar")

# —— 白名单优先级（核心 → 次级 → 卫星）——
EQUITY_CORE_BASES: tuple[str, ...] = (
    "NVDA",
    "TSLA",
    "MSTR",
    "COIN",
    "HOOD",
    "CRCL",
    "QQQ",
    "XAU",
)
EQUITY_SECONDARY_BASES: tuple[str, ...] = (
    "SPY",
    "META",
    "AAPL",
    "MSFT",
    "AMZN",
    "GOOGL",
    "GOOG",
    "AVGO",
    "TSM",
    "PLTR",
    "MARA",
)
EQUITY_SATELLITE_BASES: tuple[str, ...] = (
    "ORCL",
    "SMCI",
    "IWM",
    "TLT",
    "SOXL",
)
# 仅观察，默认不进可交易扫描池
EQUITY_OBSERVE_BASES: frozenset[str] = frozenset(
    {"SPCX", "SOXS", "GME", "RIOT"}
)

# 交易所符号别名（小写匹配）；解析顺序：perp > tradfi/xstock
EQUITY_SYMBOL_ALIASES: dict[str, tuple[str, ...]] = {
    "NVDA": ("NVDAUSDT", "NVDAXUSDT", "NVDAX"),
    "TSLA": ("TSLAUSDT", "TSLAXUSDT", "TSLAX"),
    "XAU": ("XAUUSDT", "PAXGUSDT", "GLDUSDT", "GLDXUSDT"),
    "QQQ": ("QQQUSDT", "QQQXUSDT"),
    "SPY": ("SPYUSDT", "SPYXUSDT"),
    "MSTR": ("MSTRUSDT", "MSTRXUSDT"),
    "COIN": ("COINUSDT", "COINXUSDT"),
    "HOOD": ("HOODUSDT", "HOODXUSDT"),
    "CRCL": ("CRCLUSDT", "CRCLXUSDT"),
    "META": ("METAUSDT", "METAXUSDT"),
    "AAPL": ("AAPLUSDT", "AAPLXUSDT"),
    "MSFT": ("MSFTUSDT", "MSFTXUSDT"),
    "AMZN": ("AMZNUSDT", "AMZNXUSDT"),
    "GOOGL": ("GOOGLUSDT", "GOOGUSDT", "GOOGLXUSDT", "GOOGXUSDT"),
    "GOOG": ("GOOGUSDT", "GOOGLUSDT", "GOOGXUSDT", "GOOGLXUSDT"),
    "AVGO": ("AVGOUSDT", "AVGOXUSDT"),
    "TSM": ("TSMUSDT", "TSMXUSDT"),
    "PLTR": ("PLTRUSDT", "PLTRXUSDT"),
    "MARA": ("MARAUSDT", "MARAXUSDT"),
    "ORCL": ("ORCLUSDT", "ORCLXUSDT"),
    "SMCI": ("SMCIUSDT", "SMCIXUSDT"),
    "IWM": ("IWMUSDT", "IWMXUSDT"),
    "TLT": ("TLTUSDT", "TLTXUSDT"),
    "SPCX": ("SPCXUSDT",),
    "SOXL": ("SOXLUSDT",),
    "SOXS": ("SOXSUSDT",),
    "GME": ("GMEUSDT", "GMEXUSDT"),
    "RIOT": ("RIOTUSDT", "RIOTXUSDT"),
}

EQUITY_UI_TAGS: dict[str, str] = {
    "NVDA": "beta",
    "TSLA": "beta",
    "MSTR": "crypto-proxy",
    "COIN": "crypto-proxy",
    "HOOD": "beta",
    "CRCL": "beta",
    "QQQ": "macro",
    "XAU": "macro",
    "SPY": "macro",
    "META": "beta",
    "AAPL": "mag7",
    "MSFT": "mag7",
    "AMZN": "mag7",
    "GOOGL": "mag7",
    "GOOG": "mag7",
    "SOXL": "leveraged",
    "AVGO": "beta",
    "TSM": "beta",
    "PLTR": "beta",
    "MARA": "crypto-proxy",
    "ORCL": "beta",
    "SMCI": "beta",
    "IWM": "macro",
    "TLT": "macro",
    "RIOT": "crypto-proxy",
}

_PRODUCT_RANK = {"perp": 0, "tradfi": 1, "spot_xstock": 2}


@dataclass
class EquityItem:
    base: str
    symbol: str
    venue: str = ""
    product: str = "perp"
    last_price: float = 0.0
    turnover_24h_usd: float = 0.0
    oi_usd: float | None = None
    oi_available: bool = False
    asset_class: str = "equity"
    tier: str = "equity"
    session_ok: bool = False
    in_watchlist: bool = True
    ui_tag: str = ""
    price_change_pct_24h: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class EquityPoolStats:
    equity_count: int = 0
    equity_eligible: int = 0
    equity_excluded: int = 0
    equity_no_oi: int = 0


def _whitelist_bases() -> list[tuple[str, int]]:
    """(base, priority) 越小越优先。"""
    out: list[tuple[str, int]] = []
    for i, b in enumerate(EQUITY_CORE_BASES):
        out.append((b, i))
    off = len(EQUITY_CORE_BASES)
    for i, b in enumerate(EQUITY_SECONDARY_BASES):
        out.append((b, off + i))
    off += len(EQUITY_SECONDARY_BASES)
    for i, b in enumerate(EQUITY_SATELLITE_BASES):
        out.append((b, off + i))
    extra = [x.strip().upper() for x in (OI_EQUITY_WHITELIST_EXTRA or "").split(",") if x.strip()]
    for i, b in enumerate(extra):
        if b and b not in {x[0] for x in out}:
            out.append((b, off + len(EQUITY_SATELLITE_BASES) + i))
    return out


def _guess_product(sym: str, base: str) -> str:
    su = sym.upper()
    bu = base.upper()
    if su == f"{bu}USDT":
        return "perp"
    if su.endswith("XUSDT") or su.endswith("X"):
        return "tradfi"
    return "spot_xstock"


def _is_leveraged_token(sym: str) -> bool:
    su = sym.upper()
    return "UPUSDT" in su or "DOWNUSDT" in su


def _ticker_index(tickers: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    idx: dict[str, dict[str, Any]] = {}
    for item in tickers:
        sym = str(item.get("symbol") or "").upper()
        if not sym or _is_leveraged_token(sym) or is_stablecoin_symbol(sym):
            continue
        idx[sym] = item
    return idx


def _resolve_base_match(
    base: str,
    ticker_idx: dict[str, dict[str, Any]],
) -> tuple[str, dict[str, Any], str] | None:
    aliases = EQUITY_SYMBOL_ALIASES.get(base.upper(), (f"{base.upper()}USDT",))
    candidates: list[tuple[str, dict[str, Any], str]] = []
    for alias in aliases:
        sym = alias.upper()
        item = ticker_idx.get(sym)
        if not item:
            continue
        product = _guess_product(sym, base)
        candidates.append((sym, item, product))
    if not candidates:
        return None
    candidates.sort(key=lambda x: _PRODUCT_RANK.get(x[2], 9))
    return candidates[0]


def is_us_equity_session_now(*, ts: float | None = None) -> bool:
    """美股常规时段（UTC，不含夏令时自动切换）。"""
    now = datetime.fromtimestamp(ts or datetime.now(timezone.utc).timestamp(), tz=timezone.utc)
    if now.weekday() >= 5:
        return False
    start_parts = [int(x) for x in OI_EQUITY_SESSION_START_UTC.split(":")]
    end_parts = [int(x) for x in OI_EQUITY_SESSION_END_UTC.split(":")]
    start_m = start_parts[0] * 60 + (start_parts[1] if len(start_parts) > 1 else 0)
    end_m = end_parts[0] * 60 + (end_parts[1] if len(end_parts) > 1 else 0)
    cur_m = now.hour * 60 + now.minute
    return start_m <= cur_m < end_m


def build_equity_pool(
    exchange_tickers: list[dict[str, Any]],
    *,
    venue: str = "",
    oi_map: dict[str, float] | None = None,
    scan_ts: float | None = None,
) -> tuple[list[EquityItem], EquityPoolStats]:
    """
    白名单 × 别名匹配 → 成交额门槛 → 优先级截断。
    不调用 classify_oi_tier()；无 OI 仍可入池。
    """
    if not OI_EQUITY_ENABLED:
        return [], EquityPoolStats()

    ticker_idx = _ticker_index(exchange_tickers)
    oi_map = oi_map or {}
    session_ok = is_us_equity_session_now(ts=scan_ts)
    min_turn = float(OI_EQUITY_MIN_TURNOVER_USD or 0)
    max_pool = max(1, int(OI_EQUITY_MAX_POOL or 18))

    matched: list[EquityItem] = []
    excluded_turnover = 0
    no_oi = 0
    whitelist = _whitelist_bases()

    for base, prio in whitelist:
        if base in EQUITY_OBSERVE_BASES:
            continue
        resolved = _resolve_base_match(base, ticker_idx)
        if not resolved:
            continue
        sym, item, product = resolved
        try:
            turnover = float(item.get("quoteVolume") or 0)
        except (TypeError, ValueError):
            turnover = 0.0
        try:
            price = float(item.get("lastPrice") or 0)
        except (TypeError, ValueError):
            price = 0.0
        try:
            pct_24h = float(item.get("priceChangePercent") or 0)
        except (TypeError, ValueError):
            pct_24h = 0.0

        if turnover < min_turn:
            excluded_turnover += 1
            continue

        oi_base = oi_map.get(sym)
        oi_usd: float | None = None
        oi_available = False
        if oi_base is not None and price > 0:
            try:
                oi_usd = float(oi_base) * price
                oi_available = oi_usd > 0
            except (TypeError, ValueError):
                pass
        if not oi_available:
            no_oi += 1

        matched.append(
            EquityItem(
                base=base,
                symbol=sym,
                venue=venue,
                product=product,
                last_price=price,
                turnover_24h_usd=turnover,
                oi_usd=oi_usd,
                oi_available=oi_available,
                session_ok=session_ok,
                in_watchlist=True,
                ui_tag=EQUITY_UI_TAGS.get(base, "beta"),
                price_change_pct_24h=pct_24h,
                tier="equity",
                asset_class="equity",
            )
        )

    matched.sort(
        key=lambda x: (
            next((p for b, p in whitelist if b == x.base), 999),
            -x.turnover_24h_usd,
        )
    )
    pool = matched[:max_pool]
    stats = EquityPoolStats(
        equity_count=len(matched),
        equity_eligible=len(pool),
        equity_excluded=excluded_turnover,
        equity_no_oi=sum(1 for x in pool if not x.oi_available),
    )
    logger.info(
        "币股池 %s: 匹配=%d 入池=%d 成交额不足=%d 池内无OI=%d session=%s",
        venue or "?",
        stats.equity_count,
        stats.equity_eligible,
        stats.equity_excluded,
        stats.equity_no_oi,
        session_ok,
    )
    return pool, stats


def equity_pool_meta(stats: EquityPoolStats) -> dict[str, Any]:
    return {
        "equity_count": stats.equity_count,
        "equity_eligible": stats.equity_eligible,
        "equity_excluded": stats.equity_excluded,
        "equity_no_oi": stats.equity_no_oi,
    }


def merge_equity_into_pool_meta(
    pool_meta: dict[str, Any], stats: EquityPoolStats | None
) -> dict[str, Any]:
    if not OI_EQUITY_ENABLED:
        return pool_meta
    out = {**pool_meta, "equity_enabled": True}
    if stats:
        out.update(equity_pool_meta(stats))
    return out
