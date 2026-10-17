"""区间反转专用结算计划（TP1=中轴，TP2=对侧轨）。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.pattern_settle_profile import SettlePlan, resolve_verify_delay_ms


def build_range_reversal_plan(hit: dict[str, Any]) -> SettlePlan:
    side = str(hit.get("trade_side") or "").lower()
    is_short = side == "short"
    entry = float(hit.get("entry") or 0)
    if entry <= 0:
        raise ValueError("invalid entry")
    sl = float(hit.get("sl") or hit.get("invalid_level") or 0)
    tp1 = float(hit.get("tp1") or entry)
    tp2 = float(hit.get("tp2") or entry)
    if sl <= 0:
        raise ValueError("invalid sl")
    risk = max(abs(sl - entry), entry * 0.001)
    tp1_r = abs(tp1 - entry) / risk
    tp2_r = abs(tp2 - entry) / risk
    sym = str(hit.get("symbol") or "")
    iv = str(hit.get("interval") or "15m")
    rec = {
        "tradeSymbol": sym,
        "symbol": sym,
        "interval": iv,
        "side": "short" if is_short else "long",
        "entry": entry,
        "typeLabel": hit.get("type_label"),
    }
    return SettlePlan(
        profile_id=f"range_reversal_{iv}",
        sl_price=sl,
        tp1_price=tp1,
        tp2_price=tp2,
        batch_weights=(0.30, 0.30, 0.40),
        runner_trail_pct=5.0,
        verify_delay_ms=resolve_verify_delay_ms(rec),
        risk_r=risk,
        tp1_r=tp1_r,
        tp2_r=tp2_r,
    )
