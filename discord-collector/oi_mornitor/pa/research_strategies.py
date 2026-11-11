"""Three independent research strategy matchers (read-only; no scheduler)."""

from __future__ import annotations

from typing import Any

STRATEGY_LIQUIDITY_REVERSAL = "liquidity_reversal"
STRATEGY_TREND_PULLBACK = "trend_pullback_continuation"
STRATEGY_RANGE = "range_mean_reversion"

RESEARCH_STRATEGIES_VERSION = "research-strategies-v1"

_HTF_CONTEXT_KEYS = ("htf_1h_structure", "htf_4h_structure", "full_range_box")


def _strategy_shell(strategy_id: str, title: str) -> dict[str, Any]:
    return {
        "id": strategy_id,
        "title": title,
        "matched": False,
        "confidence": "insufficient",
        "matchedSteps": [],
        "missingContext": [],
        "reasons": [],
        "readOnly": True,
    }


def _has_step(steps: list[str], needle: str) -> bool:
    return any(needle in s for s in steps)


def _position_pullback(tags: list[str], categories: dict[str, list[str]]) -> bool:
    pos = categories.get("position") or []
    return any(t.startswith(("near_ob:", "in_fvg:", "vwap_")) for t in pos)


def _infer_simple_range(pa: dict[str, Any]) -> dict[str, Any]:
    """Single-TF range proxy: transition trend or tight recent swing band."""
    structure = pa.get("structure") or {}
    trend = structure.get("trend")
    swings = structure.get("swings") or []
    close = float(pa.get("close") or 0)
    if trend == "transition":
        return {"inRange": True, "reason": "structure_trend_transition"}
    if len(swings) >= 4 and close > 0:
        recent = swings[-6:]
        prices = [s["price"] for s in recent]
        band = max(prices) - min(prices)
        if band / close <= 0.04:
            return {"inRange": True, "reason": "tight_swing_band"}
    return {"inRange": False, "reason": "no_range_proxy"}


def match_liquidity_reversal(
    alert: dict[str, Any],
    pa: dict[str, Any],
    side: str,
    *,
    b_tags: list[str],
    categories: dict[str, list[str]],
    liquidity_states: list[dict],
) -> dict[str, Any]:
    out = _strategy_shell(STRATEGY_LIQUIDITY_REVERSAL, "流动性反转")
    steps: list[str] = []
    want_long = side == "long"
    want_short = side == "short"

    zones = (pa.get("liquidity") or {}).get("zones") or []
    if zones:
        steps.append("liquidity_zone_exists")
    swept = any(z.get("mitigated") for z in zones) or _has_step(b_tags, "swept")
    if swept:
        steps.append("sweep")
    reclaimed = any(z.get("reclaimed") for z in zones) or "liq_sweep_reclaim" in b_tags
    if reclaimed:
        steps.append("reclaim")
    struct = categories.get("structure") or []
    confirm = any(t.startswith("event:choch_") or t.startswith("event:bos_") for t in struct)
    if confirm:
        steps.append("structure_confirmation")
    if _position_pullback(b_tags, categories):
        steps.append("ob_fvg_entry_zone")

    direction_ok = True
    if want_long:
        direction_ok = any(
            s.get("phaseName") in ("reclaimed", "reversal_confirmed") and s.get("kind") == "equal_lows"
            for s in liquidity_states
        ) or any("equal_lows" in t for t in b_tags if "reversal" in t or "reclaim" in t)
    if want_short:
        direction_ok = direction_ok or any(
            s.get("phaseName") in ("reclaimed", "reversal_confirmed") and s.get("kind") == "equal_highs"
            for s in liquidity_states
        )

    required = {"sweep", "reclaim", "structure_confirmation"}
    have = set(steps)
    if required.issubset(have) and (not side or direction_ok or not liquidity_states):
        out["matched"] = True
        out["confidence"] = "full" if "ob_fvg_entry_zone" in have else "partial"
    elif len(have & required) >= 2:
        out["matched"] = True
        out["confidence"] = "partial"
    elif swept or reclaimed:
        out["matched"] = True
        out["confidence"] = "insufficient"

    out["matchedSteps"] = steps
    out["reasons"] = steps
    if not confirm and reclaimed:
        out["missingContext"].append("structure_confirmation_pending")
    return out


def match_trend_pullback(
    alert: dict[str, Any],
    pa: dict[str, Any],
    side: str,
    *,
    b_tags: list[str],
    categories: dict[str, list[str]],
) -> dict[str, Any]:
    out = _strategy_shell(STRATEGY_TREND_PULLBACK, "趋势回调延续")
    out["missingContext"].extend(_HTF_CONTEXT_KEYS)
    steps: list[str] = []

    trend = (pa.get("structure") or {}).get("trend")
    if side == "long" and trend == "up":
        steps.append("ltf_trend_aligned_long")
    elif side == "short" and trend == "down":
        steps.append("ltf_trend_aligned_short")
    elif trend in ("up", "down"):
        steps.append(f"ltf_trend_{trend}")

    if _position_pullback(b_tags, categories):
        steps.append("pullback_ob_fvg_vwap")

    struct = categories.get("structure") or []
    if any(t.startswith("event:bos_") for t in struct):
        steps.append("continuation_bos")
    label = str(alert.get("type_label") or alert.get("typeLabel") or "")
    if alert.get("vp_formal") or "量价推进" in label or "volume_price" in b_tags:
        steps.append("volume_price_thrust")

    aligned = "ltf_trend_aligned_long" in steps or "ltf_trend_aligned_short" in steps
    pullback = "pullback_ob_fvg_vwap" in steps
    continuation = "continuation_bos" in steps or "volume_price_thrust" in steps

    if aligned and pullback and continuation:
        out["matched"] = True
        out["confidence"] = "partial"
        out["reasons"].append("htf_not_available_single_tf_only")
    elif aligned and pullback:
        out["matched"] = True
        out["confidence"] = "insufficient"
    elif aligned:
        out["matched"] = True
        out["confidence"] = "insufficient"

    out["matchedSteps"] = steps
    out["reasons"] = out["reasons"] or steps
    return out


def match_range_mean_reversion(
    alert: dict[str, Any],
    pa: dict[str, Any],
    side: str,
    *,
    b_tags: list[str],
    categories: dict[str, list[str]],
    liquidity_states: list[dict],
) -> dict[str, Any]:
    out = _strategy_shell(STRATEGY_RANGE, "震荡区间")
    out["missingContext"].append("full_range_box")
    steps: list[str] = []

    range_px = _infer_simple_range(pa)
    if range_px.get("inRange"):
        steps.append(f"range_proxy:{range_px.get('reason')}")

    session_list = (pa.get("sessions") or {}).get("sessions") or []
    close = float(pa.get("close") or 0)
    for band in session_list:
        if not isinstance(band, dict):
            continue
        name = band.get("name") or "session"
        hi, lo = band.get("high"), band.get("low")
        if close and hi and lo and close > 0:
            if abs(close - hi) / close < 0.015 or abs(close - lo) / close < 0.015:
                steps.append(f"session_bound_{name}")
                break

    if any(s.get("phaseName") in ("swept", "reclaimed") for s in liquidity_states):
        steps.append("bound_sweep_or_reclaim")

    vwap = pa.get("vwap") or {}
    if vwap.get("position") or vwap.get("reclaim"):
        steps.append("vwap_confirm")
    if alert.get("vp_formal"):
        steps.append("volume_price_confirm")

    if steps.count("bound_sweep_or_reclaim") and len(steps) >= 2:
        out["matched"] = True
        out["confidence"] = "partial"
    elif any(s.startswith("range_proxy:") for s in steps) and len(steps) >= 2:
        out["matched"] = True
        out["confidence"] = "insufficient"

    out["matchedSteps"] = steps
    out["reasons"] = steps
    return out


def evaluate_research_strategies(
    alert: dict[str, Any],
    pa: dict[str, Any],
    side: str,
    *,
    b_tags: list[str],
    categories: dict[str, list[str]],
    liquidity_states: list[dict],
) -> dict[str, Any]:
    """Run all three matchers; signals may match multiple strategies."""
    if pa.get("empty"):
        return {
            "version": RESEARCH_STRATEGIES_VERSION,
            "readOnly": True,
            "matches": [],
            "matchedIds": [],
            "note": "pa_empty",
        }
    matches = [
        match_liquidity_reversal(
            alert, pa, side, b_tags=b_tags, categories=categories, liquidity_states=liquidity_states
        ),
        match_trend_pullback(alert, pa, side, b_tags=b_tags, categories=categories),
        match_range_mean_reversion(
            alert, pa, side, b_tags=b_tags, categories=categories, liquidity_states=liquidity_states
        ),
    ]
    matched_ids = [m["id"] for m in matches if m.get("matched")]
    return {
        "version": RESEARCH_STRATEGIES_VERSION,
        "readOnly": True,
        "matches": matches,
        "matchedIds": matched_ids,
        "scheduler": "none",
        "backtestStatus": "planned_p1",
    }
