"""市值梯队（一 / 二 / 三）：按 CoinGecko 美元市值实时划分。

门槛（默认，可在 symbol_mcap_tiers.json 调整）：
  第一梯队：市值大于 500 亿美元
  第二梯队：市值大于 80 亿美元、不超过 500 亿美元
  第三梯队：其余（含无数据、稳定币等排除项）

与结算杠杆分档（BTC/ETH/SOL 100x、其余 20x）相互独立。
历史胜率按「当前市值」归档，存在一定事后偏差，需在展示中标明。
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from oi_mornitor.symbol_aliases import normalize_usdt_symbol

logger = logging.getLogger(__name__)

MCAP_TIER_ORDER = ("t1", "t2", "t3")

_DEFAULT_FILE = Path(__file__).resolve().parent / "data" / "symbol_mcap_tiers.json"
_DEFAULT_T1_USD = 50_000_000_000
_DEFAULT_T2_USD = 8_000_000_000

_STRATEGY_HINTS: dict[str, str] = {
    "t1": (
        "机构博弈 · 重宏观与结构：假突破/Spring、流动性掠夺；4H/日线趋势；"
        "少追箱体突破；杠杆宜 2~5x，止损紧凑、盈亏比≥1:2。"
    ),
    "t2": (
        "主升浪先锋 · 重动量与 RS：BTC 横盘时逆势强币；15m/1h EMA 回踩；"
        "OI+突破颈线轧空；杠杆宜 2~3x 或现货，吃日线波段。"
    ),
    "t3": (
        "控盘 / 叙事 · 重爆发与止盈：右侧突破快进快出、移动止损；"
        "高位射击之星/反包果断离场；勿扛单；仓位 3~5%、杠杆 1~2x。"
    ),
}

_cfg_cache: dict[str, Any] | None = None
_default_tier: str = "t3"


def _config_path() -> Path:
    raw = str(os.environ.get("OI_MCAP_TIER_JSON") or "").strip()
    if raw:
        return Path(raw).expanduser()
    return _DEFAULT_FILE


def _base_asset(symbol: str) -> str:
    n = normalize_usdt_symbol(symbol)
    if not n:
        return ""
    if n.endswith("USDT"):
        return n[: -len("USDT")]
    if n.endswith("USD"):
        return n[: -len("USD")]
    return n


def _load_config() -> dict[str, Any]:
    global _cfg_cache, _default_tier
    if _cfg_cache is not None:
        return _cfg_cache

    labels: dict[str, str] = {"t1": "第一梯队", "t2": "第二梯队", "t3": "第三梯队"}
    notes: dict[str, str] = {
        "t1": "市值大于 500 亿美元（按 CoinGecko 美元市值实时划分）",
        "t2": "市值大于 80 亿美元、不超过 500 亿美元",
        "t3": "市值 80 亿美元及以下，或暂无市值数据 / 稳定币等排除项",
    }
    t1_usd = _DEFAULT_T1_USD
    t2_usd = _DEFAULT_T2_USD
    exclude: set[str] = set()
    fallback: dict[str, str] = {}
    default_tier = "t3"

    path = _config_path()
    try:
        if path.is_file():
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                default_tier = str(raw.get("default") or "t3").strip().lower() or "t3"
                th = raw.get("thresholdsUsd") or {}
                if isinstance(th, dict):
                    if th.get("t1") is not None:
                        t1_usd = float(th["t1"])
                    if th.get("t2") is not None:
                        t2_usd = float(th["t2"])
                excl = raw.get("exclude") or {}
                if isinstance(excl, dict):
                    for key in ("bases", "symbols"):
                        items = excl.get(key) or []
                        if isinstance(items, list):
                            for s in items:
                                b = _base_asset(str(s)) or str(s).strip().upper()
                                if b:
                                    exclude.add(b)
                bands = raw.get("bands") or {}
                if isinstance(bands, dict):
                    for tid in MCAP_TIER_ORDER:
                        block = bands.get(tid)
                        if not isinstance(block, dict):
                            continue
                        labels[tid] = str(block.get("label") or labels.get(tid, tid))
                        note = str(block.get("mcapNote") or "").strip()
                        if note:
                            notes[tid] = note
                        # 旧版白名单仅作接口失败时的兜底
                        for s in block.get("symbols") or []:
                            n = normalize_usdt_symbol(str(s))
                            if n:
                                fallback[n] = tid
                fb = raw.get("fallbackSymbols") or {}
                if isinstance(fb, dict):
                    for tid, syms in fb.items():
                        if tid not in MCAP_TIER_ORDER or not isinstance(syms, list):
                            continue
                        for s in syms:
                            n = normalize_usdt_symbol(str(s))
                            if n:
                                fallback[n] = tid
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取市值梯队配置失败 %s: %s", path, exc)

    _default_tier = default_tier
    _cfg_cache = {
        "labels": labels,
        "notes": notes,
        "t1_usd": t1_usd,
        "t2_usd": t2_usd,
        "exclude": exclude,
        "fallback": fallback,
        "default": default_tier,
    }
    return _cfg_cache


def reload_mcap_tier_config() -> None:
    global _cfg_cache
    _cfg_cache = None
    _load_config()


def mcap_thresholds_usd() -> tuple[float, float]:
    cfg = _load_config()
    return float(cfg["t1_usd"]), float(cfg["t2_usd"])


def _is_excluded(symbol: str) -> bool:
    cfg = _load_config()
    base = _base_asset(symbol)
    if not base:
        return False
    return base in cfg["exclude"]


def _fallback_tier(symbol: str) -> str:
    cfg = _load_config()
    n = normalize_usdt_symbol(symbol)
    if n and n in cfg["fallback"]:
        return str(cfg["fallback"][n])
    return str(cfg["default"])


def tier_from_market_cap_usd(cap_usd: float | None, *, excluded: bool = False) -> str:
    """纯函数：便于测试。excluded 或无市值 → 默认第三梯队。门槛为「大于」。"""
    cfg = _load_config()
    if excluded or cap_usd is None:
        return str(cfg["default"])
    try:
        cap = float(cap_usd)
    except (TypeError, ValueError):
        return str(cfg["default"])
    if cap > float(cfg["t1_usd"]):
        return "t1"
    if cap > float(cfg["t2_usd"]):
        return "t2"
    return "t3"


def resolve_mcap_tier(symbol: str) -> str:
    """t1 | t2 | t3。优先用实时市值；排除项与无数据走默认（第三梯队）。

    若 CoinGecko 缓存完全不可用，回退到配置里的 fallbackSymbols。
    """
    from oi_mornitor.mcap_market_quote import ensure_market_cap_map, market_cap_usd_sync

    if _is_excluded(symbol):
        return _default_tier if _cfg_cache else _load_config()["default"]
    cmap = ensure_market_cap_map()
    cap = market_cap_usd_sync(symbol, refresh=False)
    if cap is None and not cmap:
        return _fallback_tier(symbol)
    return tier_from_market_cap_usd(cap, excluded=False)


def mcap_tier_label(tier_id: str) -> str:
    cfg = _load_config()
    tid = str(tier_id or "").strip().lower()
    return cfg["labels"].get(tid, tid or "—")


def mcap_tier_strategy_hint(tier_id: str) -> str:
    tid = str(tier_id or "").strip().lower()
    return _STRATEGY_HINTS.get(tid, "")


def mcap_tier_mcap_note(tier_id: str) -> str:
    cfg = _load_config()
    tid = str(tier_id or "").strip().lower()
    return cfg["notes"].get(tid, "")


def mcap_tier_title(tier_id: str) -> str:
    tid = str(tier_id or "").strip().lower()
    parts = [mcap_tier_label(tid)]
    note = mcap_tier_mcap_note(tid)
    if note:
        parts.append(note)
    hint = mcap_tier_strategy_hint(tid)
    if hint:
        parts.append(hint)
    return "\n".join(parts)


def attach_mcap_tier(items: list[dict[str, Any]]) -> None:
    from oi_mornitor.mcap_market_quote import ensure_market_cap_map, market_cap_usd_sync

    ensure_market_cap_map()
    for it in items:
        if not isinstance(it, dict):
            continue
        sym = str(it.get("tradeSymbol") or it.get("symbol") or "")
        cap = None if _is_excluded(sym) else market_cap_usd_sync(sym, refresh=False)
        it["mcapTier"] = resolve_mcap_tier(sym)
        if cap is not None and cap > 0:
            it["marketCapUsd"] = cap


def filter_by_mcap_tier(
    items: list[dict[str, Any]],
    *,
    mcap_tier: str | None = None,
) -> list[dict[str, Any]]:
    want = str(mcap_tier or "all").strip().lower()
    if not want or want == "all":
        return list(items)
    out: list[dict[str, Any]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        got = str(it.get("mcapTier") or "").strip().lower()
        if not got:
            got = resolve_mcap_tier(str(it.get("tradeSymbol") or it.get("symbol") or ""))
        if got == want:
            out.append(it)
    return out


def tier_catalog_for_api() -> list[dict[str, Any]]:
    t1, t2 = mcap_thresholds_usd()
    out: list[dict[str, Any]] = []
    for tid in MCAP_TIER_ORDER:
        out.append(
            {
                "id": tid,
                "label": mcap_tier_label(tid),
                "mcapNote": mcap_tier_mcap_note(tid),
                "strategyHint": mcap_tier_strategy_hint(tid),
                "thresholdUsd": {"t1": t1, "t2": t2}.get(tid),
                "source": "coingecko_live",
            }
        )
    return out


def symbol_mcap_tier_for_api(symbol: str) -> dict[str, Any]:
    """单币市值梯队（形态图 pattern-chart-meta）。"""
    from oi_mornitor.mcap_market_quote import market_cap_usd_sync

    tid = resolve_mcap_tier(symbol)
    cap = None if _is_excluded(symbol) else market_cap_usd_sync(symbol, refresh=False)
    return {
        "id": tid,
        "label": mcap_tier_label(tid),
        "mcapNote": mcap_tier_mcap_note(tid),
        "strategyHint": mcap_tier_strategy_hint(tid),
        "marketCapUsd": cap,
        "classifiedBy": "market_cap" if cap is not None else (
            "excluded" if _is_excluded(symbol) else "default_or_fallback"
        ),
        "listedInTierConfig": cap is not None,
    }
