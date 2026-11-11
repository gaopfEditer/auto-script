"""Read-only screener filter AST (no SQL); safe allowlisted filters."""

from __future__ import annotations

import json
from typing import Any

ALLOWED_FILTER_TYPES = frozenset(
    {
        "and",
        "or",
        "volume_change",
        "price_change",
        "structure_event",
        "liquidity_sweep_occurred",
        "near_order_block",
        "funding_rate",
        "oi_change",
        "above_below_vwap",
    }
)


def parse_filter_json(raw: str | dict[str, Any]) -> dict[str, Any]:
    node = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(node, dict):
        raise ValueError("filter must be object")
    _validate_node(node)
    return node


def _validate_node(node: dict[str, Any]) -> None:
    ftype = node.get("type")
    if ftype not in ALLOWED_FILTER_TYPES:
        raise ValueError(f"disallowed filter type: {ftype}")
    if ftype in ("and", "or"):
        subs = node.get("filters")
        if not isinstance(subs, list) or not subs:
            raise ValueError("composite filters required")
        for s in subs:
            _validate_node(s)


def _between(val: float | None, lo: float | None, hi: float | None) -> bool:
    if val is None:
        return False
    if lo is not None and val < lo:
        return False
    if hi is not None and val > hi:
        return False
    return True


def _eval_structure_event(f: dict, ctx: dict) -> bool:
    structure = ctx.get("structure")
    if not structure:
        return False
    candles = ctx["candles"]
    since = int(f.get("since_bars") or 20)
    cutoff = candles[max(0, len(candles) - since)]["open_time"]
    for ev in structure.get("events", []):
        if ev.get("type") != f.get("event"):
            continue
        t = ev.get("time")
        if t is not None and t >= cutoff:
            return True
        if ev.get("index", -1) >= len(candles) - since:
            return True
    return False


def _eval_liquidity_sweep(f: dict, ctx: dict) -> bool:
    zones = (ctx.get("liquidity") or {}).get("zones") or ctx.get("liquidity_zones")
    if not zones:
        return False
    candles = ctx["candles"]
    since = int(f.get("since_bars") or 20)
    cutoff = candles[max(0, len(candles) - since)]["open_time"]
    for z in zones:
        if not z.get("mitigated"):
            continue
        st = z.get("swept_at_time")
        if st is not None and st >= cutoff:
            return True
        if z.get("swept_at") is not None and z["swept_at"] >= len(candles) - since:
            return True
    return False


def _eval_near_order_block(f: dict, ctx: dict) -> bool:
    obs = (ctx.get("obfvg") or {}).get("order_blocks") or ctx.get("order_blocks") or []
    close = float(ctx["close"])
    max_dist = float(f.get("max_distance_pct") or 0.5)
    for ob in obs:
        if ob.get("mitigated"):
            continue
        lo, hi = ob["range"]["low"], ob["range"]["high"]
        dist = min(abs(close - lo), abs(close - hi))
        if close > 0 and dist / close * 100.0 <= max_dist:
            return True
    return False


def _eval_above_below_vwap(f: dict, ctx: dict) -> bool:
    vwap = (ctx.get("vwap") or {}).get("current")
    if vwap is None:
        return False
    close = float(ctx["close"])
    if f.get("position") == "above":
        return close > vwap
    return close < vwap


def _eval_volume_change(f: dict, ctx: dict) -> bool:
    pct = ctx.get("volume_change_pct")
    return _between(pct, f.get("min"), f.get("max"))


def _eval_price_change(f: dict, ctx: dict) -> bool:
    pct = ctx.get("price_change_pct")
    return _between(pct, f.get("min"), f.get("max"))


def _eval_funding_rate(f: dict, ctx: dict) -> bool:
    fr = ctx.get("funding_rate")
    if not fr or fr.get("freshness") != "fresh":
        return False
    return _between(fr.get("value"), f.get("min"), f.get("max"))


def _eval_oi_change(f: dict, ctx: dict) -> bool:
    return _between(ctx.get("oi_change_pct"), f.get("min"), f.get("max"))


FILTER_FNS = {
    "volume_change": _eval_volume_change,
    "price_change": _eval_price_change,
    "structure_event": _eval_structure_event,
    "liquidity_sweep_occurred": _eval_liquidity_sweep,
    "near_order_block": _eval_near_order_block,
    "funding_rate": _eval_funding_rate,
    "oi_change": _eval_oi_change,
    "above_below_vwap": _eval_above_below_vwap,
}


def _eval_node(node: dict, ctx: dict) -> bool:
    ftype = node["type"]
    if ftype == "and":
        return all(_eval_node(s, ctx) for s in node["filters"])
    if ftype == "or":
        return any(_eval_node(s, ctx) for s in node["filters"])
    return FILTER_FNS[ftype](node, ctx)


def evaluate_filter_ast(node: dict[str, Any], ctx: dict[str, Any]) -> bool:
    return _eval_node(node, ctx)


def build_screener_context(pa: dict[str, Any], candles: list[dict], extras: dict | None = None) -> dict[str, Any]:
    ctx = {
        "candles": candles,
        "close": float(candles[-1]["close"]) if candles else 0.0,
        "structure": pa.get("structure"),
        "liquidity": pa.get("liquidity"),
        "liquidity_zones": (pa.get("liquidity") or {}).get("zones"),
        "obfvg": pa.get("obfvg"),
        "order_blocks": (pa.get("obfvg") or {}).get("order_blocks"),
        "vwap": pa.get("vwap"),
    }
    if extras:
        ctx.update(extras)
    return ctx
