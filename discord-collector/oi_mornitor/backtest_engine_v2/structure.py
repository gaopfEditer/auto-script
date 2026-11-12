"""接通 structure_broken：用已收盘价穿越结构位判定，不改其余出场优先级。"""
from __future__ import annotations


def structure_broken_on_close(
    bar: dict,
    *,
    side: str,
    structure_level: float | None,
) -> bool:
    if structure_level is None:
        return False
    try:
        level = float(structure_level)
        close = float(bar["close"])
    except (TypeError, ValueError, KeyError):
        return False
    if str(side or "").lower() in ("short", "bear"):
        return close > level
    return close < level
