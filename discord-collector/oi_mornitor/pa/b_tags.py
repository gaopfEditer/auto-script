"""B-group tag taxonomy, liquidity phases, and directional inference (read-only)."""

from __future__ import annotations

from typing import Any

_STRUCTURE_LONG = frozenset({"structure_up"})
_STRUCTURE_SHORT = frozenset({"structure_down"})
_EVENT_LONG = frozenset({"event:bos_bullish", "event:choch_bullish"})
_EVENT_SHORT = frozenset({"event:bos_bearish", "event:choch_bearish"})

POSITION_PREFIXES = ("vwap_", "near_ob:", "in_fvg:")
STRUCTURE_PREFIXES = ("structure_", "event:")
LIQUIDITY_PREFIXES = ("liq_sweep:", "liq_sweep_reclaim", "liq_state:")


def categorize_b_tag(tag: str) -> str:
    if tag.startswith(POSITION_PREFIXES):
        return "position"
    if tag.startswith(STRUCTURE_PREFIXES):
        return "structure"
    if tag.startswith(LIQUIDITY_PREFIXES) or tag == "liq_sweep_reclaim":
        return "liquidity"
    if tag.startswith("liq_"):
        return "liquidity"
    return "other"


def categorize_tags(tags: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {"position": [], "structure": [], "liquidity": [], "other": []}
    for t in tags:
        out[categorize_b_tag(t)].append(t)
    return out


def liquidity_zone_phase(
    zone: dict[str, Any],
    events: list[dict[str, Any]],
    *,
    since_bars: int = 24,
) -> tuple[int, str, list[str]]:
    """
    Five-phase liquidity state (research labels):
    1 zone_exists → 2 touched → 3 swept → 4 reclaimed → 5 reversal_confirmed
    """
    reasons: list[str] = ["zone_exists"]
    phase = 1
    phase_name = "zone_exists"

    if zone.get("tested"):
        phase, phase_name = 2, "touched"
        reasons.append("touched")

    if zone.get("mitigated") or zone.get("swept_at") is not None:
        phase, phase_name = 3, "swept"
        reasons.append("swept")

    if zone.get("reclaimed"):
        phase, phase_name = 4, "reclaimed"
        reasons.append("reclaimed")

    if phase >= 4 and events:
        kind = str(zone.get("kind") or "")
        want = "choch_bullish" if kind == "equal_lows" else "choch_bearish" if kind == "equal_highs" else ""
        if not want:
            want_bos = "bos_bullish" if kind == "equal_lows" else "bos_bearish"
        else:
            want_bos = want.replace("choch", "bos")
        tail = events[-since_bars:]
        types = {e.get("type") for e in tail}
        if want in types or want_bos in types:
            phase, phase_name = 5, "reversal_confirmed"
            reasons.append("reversal_confirmed")

    return phase, phase_name, reasons


def build_liquidity_state_tags(zones: list[dict], events: list[dict], *, tail: int = 6) -> tuple[list[str], list[dict]]:
    tags: list[str] = []
    states: list[dict] = []
    for z in zones[-tail:]:
        phase, phase_name, steps = liquidity_zone_phase(z, events)
        kind = z.get("kind") or "zone"
        tags.append(f"liq_state:{kind}:{phase_name}")
        states.append(
            {
                "zoneId": z.get("zone_id"),
                "kind": kind,
                "phase": phase,
                "phaseName": phase_name,
                "mitigated": bool(z.get("mitigated")),
                "tested": bool(z.get("tested")),
                "reclaimed": bool(z.get("reclaimed")),
                "steps": steps,
            }
        )
        if z.get("mitigated"):
            tags.append(f"liq_sweep:{kind}")
        if z.get("reclaimed"):
            tags.append("liq_sweep_reclaim")
    tags = list(dict.fromkeys(tags))
    return tags, states


def infer_b_direction(tags: list[str], *, categories: dict[str, list[str]] | None = None) -> str:
    """Direction from structure (+ liquidity reversal confirm), never from position tags."""
    cats = categories or categorize_tags(tags)
    struct = cats.get("structure") or []
    votes: list[str] = []
    for t in struct:
        if t in _STRUCTURE_LONG or t in _EVENT_LONG:
            votes.append("long")
        elif t in _STRUCTURE_SHORT or t in _EVENT_SHORT:
            votes.append("short")
    for t in cats.get("liquidity") or []:
        if t.endswith(":reversal_confirmed"):
            if "equal_lows" in t:
                votes.append("long")
            elif "equal_highs" in t:
                votes.append("short")
    if not votes:
        return "neutral"
    if all(v == "long" for v in votes):
        return "long"
    if all(v == "short" for v in votes):
        return "short"
    return "mixed"


def b_group_activation(categories: dict[str, list[str]], min_b_tags: int) -> dict[str, Any]:
    """Position-only tags do not activate B (research-quality gate)."""
    pos = categories.get("position") or []
    struct = categories.get("structure") or []
    liq = categories.get("liquidity") or []
    core = bool(struct) or any(
        "swept" in t or "reclaimed" in t or "reversal_confirmed" in t or t.startswith("liq_sweep:")
        for t in liq
    )
    if core:
        source = "structure" if struct else "liquidity"
        return {"active": True, "activationSource": source, "positionOnly": False}
    if pos and len(pos) >= min_b_tags:
        return {"active": False, "activationSource": "position_only", "positionOnly": True}
    if struct or liq or pos:
        return {"active": bool(struct or liq), "activationSource": "none", "positionOnly": bool(pos) and not (struct or liq)}
    return {"active": False, "activationSource": "none", "positionOnly": False}
