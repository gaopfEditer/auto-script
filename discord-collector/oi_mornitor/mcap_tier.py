"""市值梯队（一 / 二 / 三）：与结算 tier(major/altcoin) 独立，用于筛选与胜率分桶。"""
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

_symbol_to_tier: dict[str, str] | None = None
_tier_labels: dict[str, str] | None = None
_tier_mcap_notes: dict[str, str] | None = None
_default_tier: str = "t3"


def _config_path() -> Path:
    raw = str(os.environ.get("OI_MCAP_TIER_JSON") or "").strip()
    if raw:
        return Path(raw).expanduser()
    return _DEFAULT_FILE


def _load_config() -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    global _symbol_to_tier, _tier_labels, _tier_mcap_notes, _default_tier
    if _symbol_to_tier is not None:
        return _symbol_to_tier, _tier_labels or {}, _tier_mcap_notes or {}

    sym_map: dict[str, str] = {}
    labels: dict[str, str] = {
        "t1": "第一梯队",
        "t2": "第二梯队",
        "t3": "第三梯队",
    }
    notes: dict[str, str] = {}

    path = _config_path()
    try:
        if path.is_file():
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                _default_tier = str(raw.get("default") or "t3").strip().lower() or "t3"
                bands = raw.get("bands")
                if isinstance(bands, dict):
                    for tid in MCAP_TIER_ORDER:
                        block = bands.get(tid)
                        if not isinstance(block, dict):
                            continue
                        labels[tid] = str(block.get("label") or labels.get(tid, tid))
                        note = str(block.get("mcapNote") or "").strip()
                        if note:
                            notes[tid] = note
                        syms = block.get("symbols") or []
                        if isinstance(syms, list):
                            for s in syms:
                                n = normalize_usdt_symbol(str(s))
                                if n:
                                    sym_map[n] = tid
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取市值梯队配置失败 %s: %s", path, exc)

    if not sym_map:
        sym_map = {
            normalize_usdt_symbol("BTCUSDT"): "t1",
            normalize_usdt_symbol("ETHUSDT"): "t1",
            normalize_usdt_symbol("BNBUSDT"): "t2",
            normalize_usdt_symbol("SOLUSDT"): "t2",
            normalize_usdt_symbol("XRPUSDT"): "t2",
        }

    _symbol_to_tier = sym_map
    _tier_labels = labels
    _tier_mcap_notes = notes
    return sym_map, labels, notes


def reload_mcap_tier_config() -> None:
    global _symbol_to_tier, _tier_labels, _tier_mcap_notes
    _symbol_to_tier = None
    _tier_labels = None
    _tier_mcap_notes = None
    _load_config()


def resolve_mcap_tier(symbol: str) -> str:
    """t1 | t2 | t3；未在白名单的永续币为 default（第三梯队 / 其他）。"""
    sym_map, _, _ = _load_config()
    n = normalize_usdt_symbol(symbol)
    if not n:
        return _default_tier
    return sym_map.get(n, _default_tier)


def mcap_tier_label(tier_id: str) -> str:
    _, labels, _ = _load_config()
    tid = str(tier_id or "").strip().lower()
    return labels.get(tid, tid or "—")


def mcap_tier_strategy_hint(tier_id: str) -> str:
    tid = str(tier_id or "").strip().lower()
    return _STRATEGY_HINTS.get(tid, "")


def mcap_tier_mcap_note(tier_id: str) -> str:
    _, _, notes = _load_config()
    tid = str(tier_id or "").strip().lower()
    return notes.get(tid, "")


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
    for it in items:
        if not isinstance(it, dict):
            continue
        sym = str(it.get("tradeSymbol") or it.get("symbol") or "")
        it["mcapTier"] = resolve_mcap_tier(sym)


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
    out: list[dict[str, Any]] = []
    for tid in MCAP_TIER_ORDER:
        out.append(
            {
                "id": tid,
                "label": mcap_tier_label(tid),
                "mcapNote": mcap_tier_mcap_note(tid),
                "strategyHint": mcap_tier_strategy_hint(tid),
            }
        )
    return out


def symbol_mcap_tier_for_api(symbol: str) -> dict[str, Any]:
    """单币市值梯队（形态图 pattern-chart-meta）。"""
    sym_map, _, _ = _load_config()
    n = normalize_usdt_symbol(symbol)
    tid = resolve_mcap_tier(symbol)
    return {
        "id": tid,
        "label": mcap_tier_label(tid),
        "mcapNote": mcap_tier_mcap_note(tid),
        "strategyHint": mcap_tier_strategy_hint(tid),
        "listedInTierConfig": bool(n and n in sym_map),
    }
