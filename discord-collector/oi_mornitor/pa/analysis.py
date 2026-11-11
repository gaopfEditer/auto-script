"""PA pipeline orchestration (in-memory; optional append-only persistence via pa_storage)."""

from __future__ import annotations

from typing import Any

from oi_mornitor.pa.liquidity import compute_liquidity_zones
from oi_mornitor.pa.obfvg import compute_order_blocks
from oi_mornitor.pa.params import PA_BUNDLE_VERSION, PA_LOOKBACK
from oi_mornitor.pa.swings import detect_structure
from oi_mornitor.pa.vwap_sessions import compute_session_levels, compute_vwap, detect_vwap_reclaim, vwap_position

PA_ALGO_VERSION = PA_BUNDLE_VERSION


def compute_pa_snapshot(
    candles: list[dict[str, Any]],
    *,
    futures: dict[str, Any] | None = None,
    effective_from: int | None = None,
) -> dict[str, Any]:
    """Full chain: swings → liquidity → OB/FVG → VWAP sessions."""
    if not candles:
        return {"algo_version": PA_ALGO_VERSION, "empty": True}
    window = candles[-PA_LOOKBACK:] if len(candles) > PA_LOOKBACK else candles
    structure = detect_structure(window)
    liquidity = compute_liquidity_zones(window, structure, futures=futures)
    obfvg = compute_order_blocks(window, structure)
    vwap = compute_vwap(window)
    sessions = compute_session_levels(window)
    close = float(window[-1]["close"])
    vwap_cur = vwap.get("current")
    eff = effective_from if effective_from is not None else int(window[-1]["open_time"])
    return {
        "algo_version": PA_ALGO_VERSION,
        "effective_from": eff,
        "close": close,
        "structure": structure,
        "liquidity": liquidity,
        "obfvg": obfvg,
        "vwap": {
            **vwap,
            "position": vwap_position(close, vwap_cur),
            "reclaim": detect_vwap_reclaim(window, vwap.get("points") or []),
        },
        "sessions": sessions,
    }
