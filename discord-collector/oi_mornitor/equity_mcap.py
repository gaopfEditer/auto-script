"""美股集合 / 大市值个股：识别、公司市值缓存（不与加密流通市值混用）。"""

from __future__ import annotations

import json
import logging
import re
import time
import urllib.request
from pathlib import Path
from typing import Any

from oi_mornitor.equity_pool import EQUITY_SYMBOL_ALIASES
from oi_mornitor.symbol_aliases import normalize_usdt_symbol

logger = logging.getLogger(__name__)

# 集合子类（不套 500/80 亿门槛）
BASKET_INDEX_BASES: frozenset[str] = frozenset({"QQQ", "SPY", "IWM"})
BASKET_LEVERAGED_BASES: frozenset[str] = frozenset({"SOXL", "SOXS"})
BASKET_MACRO_BASES: frozenset[str] = frozenset({"XAU", "TLT", "PAXG", "GLD"})

# 按公司市值进梯队的大市值科技股
EQUITY_STOCK_CAP_BASES: frozenset[str] = frozenset(
    {
        "AAPL",
        "NVDA",
        "MSFT",
        "GOOG",
        "GOOGL",
        "AMZN",
        "TSM",
        "AVGO",
        "META",
        "TSLA",
        "PLTR",
        "ORCL",
    }
)

# 白名单里有、但暂不按「主要科技股」归档
EQUITY_OTHER_BASES: frozenset[str] = frozenset(
    {"MSTR", "COIN", "HOOD", "MARA", "CRCL", "SMCI", "GME", "RIOT", "SPCX"}
)

# 入池 / 关注名单优先顺序（集合 + 大市值个股）
EQUITY_PREFERRED_BASES: tuple[str, ...] = (
    "QQQ",
    "SPY",
    "IWM",
    "SOXL",
    "XAU",
    "TLT",
    "NVDA",
    "TSLA",
    "AAPL",
    "MSFT",
    "AMZN",
    "GOOGL",
    "META",
    "AVGO",
    "TSM",
    "PLTR",
    "ORCL",
)

CMC_SLUGS: dict[str, str] = {
    "AAPL": "apple",
    "NVDA": "nvidia",
    "MSFT": "microsoft",
    "GOOG": "alphabet-google",
    "GOOGL": "alphabet-google",
    "AMZN": "amazon",
    "TSM": "tsmc",
    "AVGO": "broadcom",
    "META": "meta-platforms",
    "TSLA": "tesla",
    "PLTR": "palantir",
    "ORCL": "oracle",
}

# 2026-11-13 00:20–00:24 Asia/Shanghai，CompaniesMarketCap，作磁盘缓存种子
_SEED_CAPS_USD: dict[str, float] = {
    "AAPL": 5_208_330_000_000,
    "NVDA": 4_013_110_000_000,
    "MSFT": 3_925_190_000_000,
    "GOOG": 3_648_670_000_000,
    "GOOGL": 3_648_670_000_000,
    "AMZN": 2_931_710_000_000,
    "TSM": 2_132_780_000_000,
    "AVGO": 1_761_470_000_000,
    "META": 1_602_780_000_000,
    "TSLA": 1_551_340_000_000,
    "PLTR": 415_410_000_000,
    "ORCL": 401_510_000_000,
}

_CACHE_FILE = Path(__file__).resolve().parent / "data" / "equity_mcap_cache.json"
_TTL_SEC = 6 * 3600
_MAP: dict[str, float] = {}
_MAP_TS = 0.0
_FROZEN = False
_BASE_BY_SYMBOL: dict[str, str] | None = None

_TIER_BY_BASKET = {
    "index": "eq-index",
    "leveraged": "eq-lev",
    "macro": "eq-macro",
}


def _build_symbol_index() -> dict[str, str]:
    out: dict[str, str] = {}
    for base, aliases in EQUITY_SYMBOL_ALIASES.items():
        bu = base.upper()
        for a in aliases:
            n = normalize_usdt_symbol(str(a))
            if n:
                out[n] = bu
            au = str(a).strip().upper()
            if au:
                out[au] = bu
        out[f"{bu}USDT"] = bu
        out[f"{bu}XUSDT"] = bu
        out[bu] = bu
    # 黄金代币并入宏观集合
    for gold in ("PAXGUSDT", "PAXG", "GLDUSDT", "GLDXUSDT", "GLD"):
        out[gold] = "XAU"
    return out


def equity_base_for_symbol(symbol: str) -> str:
    """NVDAUSDT / NVDAXUSDT / NVDA → NVDA。无法识别则空串。"""
    global _BASE_BY_SYMBOL
    if _BASE_BY_SYMBOL is None:
        _BASE_BY_SYMBOL = _build_symbol_index()
    n = normalize_usdt_symbol(symbol) or str(symbol or "").strip().upper()
    if not n:
        return ""
    if n in _BASE_BY_SYMBOL:
        return _BASE_BY_SYMBOL[n]
    if n.endswith("XUSDT"):
        return n[: -len("XUSDT")]
    if n.endswith("USDT"):
        return n[: -len("USDT")]
    return n if n.isalpha() else ""


def basket_kind_for_base(base: str) -> str | None:
    b = (base or "").upper()
    if b in BASKET_INDEX_BASES:
        return "index"
    if b in BASKET_LEVERAGED_BASES:
        return "leveraged"
    if b in BASKET_MACRO_BASES:
        return "macro"
    return None


def classify_equity(symbol: str) -> tuple[str, str] | None:
    """返回 (kind, base)：index/leveraged/macro/stock/other；非币股则 None。"""
    base = equity_base_for_symbol(symbol)
    if not base:
        return None
    bk = basket_kind_for_base(base)
    if bk:
        return bk, base
    if base in EQUITY_STOCK_CAP_BASES:
        return "stock", base
    if base in EQUITY_OTHER_BASES or base in EQUITY_SYMBOL_ALIASES:
        return "other", base
    return None


def is_equity_symbol(symbol: str) -> bool:
    return classify_equity(symbol) is not None


def equity_must_include_symbols() -> list[str]:
    """回测/关注应尽量纳入的 USDT 永续名（GOOG/GOOGL 都列出）。"""
    out: list[str] = []
    seen: set[str] = set()
    for base in EQUITY_PREFERRED_BASES:
        aliases = EQUITY_SYMBOL_ALIASES.get(base, (f"{base}USDT",))
        # 优先裸 USDT 永续名
        perp = f"{base}USDT"
        for cand in (perp, *aliases):
            n = normalize_usdt_symbol(str(cand))
            if n and n not in seen:
                seen.add(n)
                out.append(n)
                break
        if base == "GOOGL":
            n = "GOOGUSDT"
            if n not in seen:
                seen.add(n)
                out.append(n)
    return out


def _cap_key(base: str) -> str:
    b = (base or "").upper()
    if b == "GOOGL":
        return "GOOG"
    return b


def _load_disk() -> None:
    global _MAP, _MAP_TS
    if _MAP:
        return
    caps = dict(_SEED_CAPS_USD)
    ts = 0.0
    try:
        if _CACHE_FILE.is_file():
            raw = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                ts = float(raw.get("ts") or 0)
                stored = raw.get("caps") or {}
                if isinstance(stored, dict):
                    for k, v in stored.items():
                        try:
                            caps[str(k).upper()] = float(v)
                        except (TypeError, ValueError):
                            continue
    except Exception as exc:  # noqa: BLE001
        logger.debug("读取美股市值缓存失败: %s", exc)
    _MAP = caps
    _MAP_TS = ts


def _save_disk() -> None:
    try:
        _CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _CACHE_FILE.write_text(
            json.dumps({"ts": _MAP_TS, "caps": _MAP}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("写入美股市值缓存失败: %s", exc)


def _parse_cmc_cap(html: str) -> float | None:
    vals = re.findall(
        r"\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?)\s*([TBM])\b",
        html,
    )
    parsed: list[float] = []
    for n, u in vals:
        x = float(n.replace(",", ""))
        parsed.append(x * {"T": 1e12, "B": 1e9, "M": 1e6}[u])
    parsed = [p for p in parsed if 1e8 <= p <= 1.5e13]
    if not parsed:
        return None
    # 公司页上当前市值会出现多次
    from collections import Counter

    return float(Counter(round(p, -6) for p in parsed).most_common(1)[0][0])


def _refresh_one(base: str) -> float | None:
    slug = CMC_SLUGS.get(_cap_key(base))
    if not slug:
        return None
    url = f"https://companiesmarketcap.com/{slug}/marketcap/"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "oi-mornitor-equity-mcap/1.0", "Accept": "text/html"},
    )
    with urllib.request.urlopen(req, timeout=12) as resp:
        html = resp.read().decode("utf-8", errors="ignore")
    return _parse_cmc_cap(html)


def ensure_equity_cap_map(*, force: bool = False) -> dict[str, float]:
    global _MAP, _MAP_TS
    if _FROZEN and not force:
        return _MAP
    _load_disk()
    stale = force or (time.time() - _MAP_TS > _TTL_SEC) or not _MAP
    if not stale:
        return _MAP
    updated = dict(_MAP or _SEED_CAPS_USD)
    ok = 0
    for base in ("GOOG", *(b for b in EQUITY_STOCK_CAP_BASES if b not in {"GOOGL", "GOOG"})):
        try:
            cap = _refresh_one(base)
        except Exception as exc:  # noqa: BLE001
            logger.warning("刷新 %s 公司市值失败: %s", base, exc)
            continue
        if cap:
            updated[base] = cap
            if base == "GOOG":
                updated["GOOGL"] = cap
            ok += 1
    _MAP = updated
    if ok:
        _MAP_TS = time.time()
        _save_disk()
    return _MAP


def company_market_cap_usd(symbol_or_base: str, *, refresh: bool = True) -> float | None:
    base = equity_base_for_symbol(symbol_or_base) or str(symbol_or_base or "").upper()
    if not base or base not in EQUITY_STOCK_CAP_BASES:
        return None
    if refresh:
        ensure_equity_cap_map()
    else:
        _load_disk()
    return _MAP.get(_cap_key(base)) or _MAP.get(base)


def reset_equity_cap_cache_for_tests(
    caps: dict[str, float] | None = None,
    *,
    freeze: bool = True,
) -> None:
    global _MAP, _MAP_TS, _FROZEN
    _MAP = {str(k).upper(): float(v) for k, v in (caps or {}).items()}
    _MAP_TS = time.time()
    _FROZEN = bool(freeze)


def equity_tier_from_company_cap(cap_usd: float | None, *, t1_usd: float, t2_usd: float) -> str:
    if cap_usd is None:
        return "eq-t3"
    try:
        cap = float(cap_usd)
    except (TypeError, ValueError):
        return "eq-t3"
    if cap > t1_usd:
        return "eq-t1"
    if cap > t2_usd:
        return "eq-t2"
    return "eq-t3"
