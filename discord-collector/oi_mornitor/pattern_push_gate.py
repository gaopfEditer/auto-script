"""形态推送硬过滤：多周期共振门槛（推送与胜率入库前）。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.config import OI_PATTERN_PUSH_MTF_MIN
from oi_mornitor.pattern_mtf_resonance import attach_mtf_resonance
from oi_mornitor.pattern_alert_stats import alert_stats_key
from oi_mornitor.symbol_aliases import human_base_asset, normalize_usdt_symbol


def _side_from_alert(alert: dict[str, Any]) -> str:
    side = str(alert.get("side") or "").lower()
    if side in ("bull", "long"):
        return "long"
    if side in ("bear", "short"):
        return "short"
    hint = str(alert.get("side_hint") or "")
    if "多" in hint:
        return "long"
    if "空" in hint:
        return "short"
    return ""


def alert_to_resonance_stub(alert: dict[str, Any]) -> dict[str, Any]:
    sym_raw = str(alert.get("symbol") or "")
    side = _side_from_alert(alert)
    type_label = str(
        alert.get("type_label") or alert.get("pattern_label") or alert.get("signal_text") or ""
    ).strip()
    from oi_mornitor.pattern_signal_time import resolve_signal_at_from_alert

    signal_at = resolve_signal_at_from_alert(alert)
    return {
        "key": alert_stats_key(alert),
        "symbol": human_base_asset(sym_raw) or sym_raw.strip().upper(),
        "tradeSymbol": normalize_usdt_symbol(sym_raw),
        "side": side,
        "dir": "多" if side == "long" else ("空" if side == "short" else ""),
        "signalAt": signal_at,
        "typeLabel": type_label,
        "interval": str(alert.get("interval") or "").strip(),
    }


def mtf_tier_count_for_alert(
    alert: dict[str, Any],
    peers: list[dict[str, Any]] | None = None,
) -> int:
    """当前 alert 在 peers+自身集合中的共振周期数；无共振 eligible 时返回 1。"""
    from oi_mornitor.pattern_alert_stats import list_alert_stats

    pool = list(peers if peers is not None else list_alert_stats())
    stub = alert_to_resonance_stub(alert)
    if not stub.get("key") or not stub.get("signalAt"):
        return 1
    combined = pool + [stub]
    attach_mtf_resonance(combined)
    mtf = stub.get("mtfResonance")
    if isinstance(mtf, dict):
        try:
            return max(1, int(mtf.get("tiers") or 1))
        except (TypeError, ValueError):
            pass
    return 1


def passes_push_mtf_gate(
    alert: dict[str, Any],
    peers: list[dict[str, Any]] | None = None,
    *,
    min_tiers: int | None = None,
) -> bool:
    """OI_PATTERN_PUSH_MTF_MIN：共振周期数不足则不入库、不推 TG。"""
    need = int(min_tiers if min_tiers is not None else OI_PATTERN_PUSH_MTF_MIN)
    if need <= 1:
        return True
    return mtf_tier_count_for_alert(alert, peers) >= need
