"""结构止损 vs ATR 止损对照：不把固定 2% 改成另一个硬数字。"""
from __future__ import annotations

from typing import Literal

SlProfile = Literal["structure", "atr"]
SL_PROFILES: tuple[str, ...] = ("structure", "atr")


def resolve_sl_price(
    *,
    entry: float,
    is_short: bool,
    structure_level: float | None,
    atr: float | None,
    atr_k: float = 1.5,
    profile: str = "structure",
    buffer_pct: float = 0.0005,
) -> tuple[float, str]:
    """返回 (sl_price, used_profile)。structure 为默认；atr 供对照测试。"""
    atr_dist = (float(atr) * atr_k) if atr and atr > 0 else None
    buf = entry * buffer_pct
    struct = None
    if structure_level is not None and structure_level > 0:
        if is_short and structure_level > entry:
            struct = structure_level + buf
        elif (not is_short) and structure_level < entry:
            struct = structure_level - buf

    if profile == "atr" and atr_dist:
        sl = entry + atr_dist if is_short else entry - atr_dist
        return sl, "atr"
    if struct is not None:
        return struct, "structure"
    if atr_dist:
        sl = entry + atr_dist if is_short else entry - atr_dist
        return sl, "atr_fallback"
    # 最后兜底：极小距离，避免 0 风险；不是新的「2% 规则」
    dist = entry * 0.005
    sl = entry + dist if is_short else entry - dist
    return sl, "min_fallback"


def tp_prices(entry: float, sl: float, *, is_short: bool, r_multiples: tuple[float, ...] = (1.5, 3.0)) -> list[float]:
    risk = abs(entry - sl)
    out: list[float] = []
    for r in r_multiples:
        if is_short:
            out.append(entry - risk * r)
        else:
            out.append(entry + risk * r)
    return out
