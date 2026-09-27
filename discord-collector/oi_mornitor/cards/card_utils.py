"""卡片价位校验与近场阈值。"""
from __future__ import annotations

from oi_mornitor.config import (
    CARD_NEAR_ENTRY_MAJOR_LEV,
    CARD_NEAR_ENTRY_PCT,
    CARD_NEAR_ENTRY_PCT_MAJOR,
    CARD_SL_MAX_DIST_PCT,
    CARD_TP_MAX_DIST_PCT,
    SANDBOX_MAJOR_SYMBOLS,
)


def is_major_symbol(symbol: str) -> bool:
    sym = symbol.upper()
    return sym in SANDBOX_MAJOR_SYMBOLS or sym in ("BTCUSDT", "ETHUSDT")


def card_near_entry_pct(symbol: str, leverage: float | None = None) -> float:
    lev = float(leverage) if leverage and float(leverage) > 0 else 0.0
    if is_major_symbol(symbol) or lev >= CARD_NEAR_ENTRY_MAJOR_LEV:
        return CARD_NEAR_ENTRY_PCT_MAJOR
    return CARD_NEAR_ENTRY_PCT


def price_move_pct(entry: float, level: float) -> float:
    e = float(entry or 0)
    if e <= 0:
        return float("inf")
    return abs(float(level) - e) / e * 100.0


def validate_card_levels(
    side: str,
    entry: float,
    sl: float | None,
    tps: list[float] | None = None,
    *,
    sl_max_pct: float | None = None,
    tp_max_pct: float | None = None,
) -> tuple[bool, str]:
    side_u = str(side or "").upper()
    entry_v = float(entry or 0)
    if entry_v <= 0:
        return False, "入场价无效"
    sl_cap = float(sl_max_pct if sl_max_pct is not None else CARD_SL_MAX_DIST_PCT)
    tp_cap = float(tp_max_pct if tp_max_pct is not None else CARD_TP_MAX_DIST_PCT)

    if sl is not None:
        sl_v = float(sl)
        if sl_v <= 0:
            return False, "止损无效"
        if side_u == "LONG" and sl_v >= entry_v:
            return False, f"多单止损须低于入场（SL={sl_v:.6g} ≥ entry={entry_v:.6g}）"
        if side_u == "SHORT" and sl_v <= entry_v:
            return False, f"空单止损须高于入场（SL={sl_v:.6g} ≤ entry={entry_v:.6g}）"
        dist = price_move_pct(entry_v, sl_v)
        if sl_cap > 0 and dist > sl_cap:
            return False, f"止损距入场 {dist:.1f}% 超过上限 {sl_cap:g}%（疑小数错位）"

    for i, tp in enumerate(tps or []):
        try:
            tp_v = float(tp)
        except (TypeError, ValueError):
            continue
        if tp_v <= 0:
            continue
        if side_u == "LONG" and tp_v <= entry_v:
            return False, f"多单 TP{i + 1}={tp_v:.6g} 须高于入场"
        if side_u == "SHORT" and tp_v >= entry_v:
            return False, f"空单 TP{i + 1}={tp_v:.6g} 须低于入场"
        dist = price_move_pct(entry_v, tp_v)
        if tp_cap > 0 and dist > tp_cap:
            return False, f"TP{i + 1} 距入场 {dist:.1f}% 超过上限 {tp_cap:g}%"

    return True, ""


def exit_reason_label(code: str) -> str:
    labels = {
        "card_sl": "止损",
        "card_tp": "止盈",
        "card_tp_all": "全部止盈",
    }
    return labels.get(code, code or "出场")
