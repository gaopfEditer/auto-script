"""结算 V2：按信号类型/周期/市值梯队解析 SL(R/ATR/invalid) 与 TP(R 倍数)。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from oi_mornitor.mcap_tier import resolve_mcap_tier

_VERIFY_MS = {
    "15m": 3 * 60 * 60 * 1000,
    "30m": 4 * 60 * 60 * 1000,
    "1h": 6 * 60 * 60 * 1000,
    "4h": 12 * 60 * 60 * 1000,
}
_MCAP_VERIFY_MULT = {"t1": 1.5, "t2": 1.0, "t3": 0.67}

_ATR_K = {"t1": 1.5, "t2": 2.0, "t3": 2.5}
_CAP_PCT = {"t1": 0.02, "t2": 0.03, "t3": 0.04}


@dataclass(frozen=True)
class SettlePlan:
    profile_id: str
    sl_price: float
    tp1_price: float
    tp2_price: float
    batch_weights: tuple[float, float, float]
    runner_trail_pct: float
    verify_delay_ms: int
    risk_r: float
    tp1_r: float
    tp2_r: float


def _norm_label(rec: dict[str, Any]) -> str:
    return str(rec.get("typeLabel") or rec.get("type_label") or "").strip()


def is_observation_record(rec: dict[str, Any]) -> bool:
    lab = _norm_label(rec)
    if "观察" in lab:
        return True
    if rec.get("observation_only"):
        return True
    if rec.get("vp_formal") is False and str(rec.get("source") or "") == "telegram_push":
        return False
    return False


def _profile_preset(type_label: str) -> tuple[str, float, float, tuple[float, float, float], float]:
    """profile_id, tp1_r, tp2_r, weights, runner_trail_pct。"""
    lab = type_label.lower()
    if any(x in type_label for x in ("二次探底", "Spring", "spring", "流动性掠夺", "顶部结构", "头肩", "M顶", "圆弧")):
        return ("structure", 1.5, 3.0, (0.30, 0.30, 0.40), 7.0)
    if "量价确认" in type_label or "量价推进" in type_label:
        return ("vp_breakout", 1.0, 2.0, (0.40, 0.30, 0.30), 5.0)
    if any(x in type_label for x in ("高潮反转", "努力无", "努力无果")):
        return ("reversal", 1.0, 2.0, (0.50, 0.30, 0.20), 3.0)
    return ("default", 1.0, 2.0, (0.30, 0.30, 0.40), 5.0)


def compute_atr14(
    highs: list[float],
    lows: list[float],
    closes: list[float],
    *,
    period: int = 14,
) -> float | None:
    n = min(len(highs), len(lows), len(closes))
    if n < period + 1:
        return None
    trs: list[float] = []
    for i in range(1, n):
        h, l, pc = highs[i], lows[i], closes[i - 1]
        tr = max(h - l, abs(h - pc), abs(l - pc))
        trs.append(tr)
    if len(trs) < period:
        return None
    window = trs[-period:]
    return sum(window) / float(period)


def _side(rec: dict[str, Any]) -> str:
    s = str(rec.get("side") or "").lower()
    if s in ("long", "short"):
        return s
    d = str(rec.get("dir") or "")
    return "long" if d == "多" else ("short" if d == "空" else "long")


def resolve_verify_delay_ms(rec: dict[str, Any]) -> int:
    iv = str(rec.get("interval") or "15m").strip().lower()
    base = _VERIFY_MS.get(iv, _VERIFY_MS["15m"])
    sym = str(rec.get("tradeSymbol") or rec.get("symbol") or "")
    tier = resolve_mcap_tier(sym)
    mult = _MCAP_VERIFY_MULT.get(tier, 1.0)
    if str(rec.get("assetClass") or "") == "equity":
        return 4 * 60 * 60 * 1000
    return int(base * mult)


def build_settle_plan(
    rec: dict[str, Any],
    *,
    atr: float | None = None,
) -> SettlePlan:
    """根据 entry / invalid / ATR 生成 SL 与 R 倍数 TP。"""
    side = _side(rec)
    is_short = side == "short"
    entry = float(rec.get("entry") or 0)
    if entry <= 0:
        raise ValueError("invalid entry")

    sym = str(rec.get("tradeSymbol") or rec.get("symbol") or "")
    tier = resolve_mcap_tier(sym)
    atr_k = float(os.environ.get(f"OI_SETTLE_ATR_K_{tier.upper()}") or _ATR_K.get(tier, 2.0))
    cap = float(os.environ.get(f"OI_SETTLE_CAP_{tier.upper()}") or _CAP_PCT.get(tier, 0.03))

    invalid_raw = rec.get("invalid_level") or rec.get("invalidLevel")
    try:
        invalid = float(invalid_raw) if invalid_raw is not None else None
    except (TypeError, ValueError):
        invalid = None

    atr_val = float(atr) if atr is not None and atr > 0 else entry * cap

    if is_short:
        cands: list[float] = [entry * (1 + cap)]
        if invalid is not None and invalid > entry:
            cands.append(invalid)
        cands.append(entry + atr_k * atr_val)
        sl = min(cands)
        risk = max(sl - entry, entry * 0.001)
        tp1 = entry - risk * 1.0
        tp2 = entry - risk * 2.0
    else:
        cands = [entry * (1 - cap)]
        if invalid is not None and invalid < entry:
            cands.append(invalid)
        cands.append(entry - atr_k * atr_val)
        sl = max(cands)
        risk = max(entry - sl, entry * 0.001)
        tp1 = entry + risk * 1.0
        tp2 = entry + risk * 2.0

    preset_id, tp1_r, tp2_r, weights, trail = _profile_preset(_norm_label(rec))
    if is_short:
        tp1 = entry - risk * tp1_r
        tp2 = entry - risk * tp2_r
    else:
        tp1 = entry + risk * tp1_r
        tp2 = entry + risk * tp2_r

    iv = str(rec.get("interval") or "15m")
    profile_id = f"{preset_id}_{tier}_{iv}"

    return SettlePlan(
        profile_id=profile_id,
        sl_price=sl,
        tp1_price=tp1,
        tp2_price=tp2,
        batch_weights=weights,
        runner_trail_pct=trail,
        verify_delay_ms=resolve_verify_delay_ms(rec),
        risk_r=risk,
        tp1_r=tp1_r,
        tp2_r=tp2_r,
    )


def settle_rules_summary_v2() -> str:
    return (
        "V2：SL=结构invalid与ATR×k、cap%取更紧 · TP=1R/2R 分类型 · "
        "核实窗按周期×市值梯队 · 观察档不计入默认胜率"
    )
