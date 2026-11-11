"""Liquidity zones (equal highs/lows) + sweep / reclaim markers."""

from __future__ import annotations

from typing import Any

from oi_mornitor.pa.params import (
    EQUAL_LEVEL_TOLERANCE_PCT,
    LIQUIDITY_ALGO_VERSION,
    LIQUIDITY_WEIGHTS,
    SWEEP_EXCEED_PCT,
)


def _cluster_swings(swings: list[dict], pivot_kind: str, tolerance_pct: float) -> list[list[dict]]:
    items = sorted((s for s in swings if s["kind"] == pivot_kind), key=lambda s: s["price"])
    clusters: list[list[dict]] = []
    for s in items:
        placed = False
        for cl in clusters:
            mid = sum(x["price"] for x in cl) / len(cl)
            if abs(s["price"] - mid) <= (mid * tolerance_pct / 100.0):
                cl.append(s)
                placed = True
                break
        if not placed:
            clusters.append([s])
    return [c for c in clusters if len(c) >= 2]


def _make_zone(cluster: list[dict], kind: str) -> dict[str, Any]:
    prices = [s["price"] for s in cluster]
    lo, hi = min(prices), max(prices)
    indices = [s["index"] for s in cluster]
    return {
        "zone_id": f"{kind}:{lo:.8g}:{hi:.8g}",
        "kind": kind,
        "range": {"low": lo, "high": hi},
        "swing_count": len(cluster),
        "formed_at": max(indices),
        "swept_at": None,
        "swept_at_time": None,
        "mitigated": False,
        "tested": False,
        "reclaimed": False,
        "reclaimed_at": None,
    }


def _mark_sweep_and_reclaim(
    zone: dict,
    sweep_dir: str,
    times: list[int],
    highs: list[float],
    lows: list[float],
    closes: list[float],
    n: int,
) -> None:
    formed = int(zone["formed_at"])
    band = zone["range"]
    exceed = 1.0 + SWEEP_EXCEED_PCT / 100.0
    for i in range(formed + 1, n):
        if sweep_dir == "high":
            if zone["swept_at"] is None and highs[i] > band["high"] * exceed:
                zone["swept_at"] = i
                zone["swept_at_time"] = times[i]
                zone["mitigated"] = True
            if highs[i] >= band["low"]:
                zone["tested"] = True
        else:
            if zone["swept_at"] is None and lows[i] < band["low"] * (1.0 / exceed if exceed else 1.0):
                zone["swept_at"] = i
                zone["swept_at_time"] = times[i]
                zone["mitigated"] = True
            if lows[i] <= band["high"]:
                zone["tested"] = True

    swept = zone.get("swept_at")
    if swept is None:
        return
    for j in range(int(swept) + 1, n):
        c = closes[j]
        if sweep_dir == "high" and c < band["low"]:
            zone["reclaimed"] = True
            zone["reclaimed_at"] = j
            return
        if sweep_dir == "low" and c > band["high"]:
            zone["reclaimed"] = True
            zone["reclaimed_at"] = j
            return


def liquidity_score(zones: list[dict], futures: dict[str, Any] | None) -> dict[str, Any]:
    futures = futures or {}
    w = LIQUIDITY_WEIGHTS
    eq_zones = [z for z in zones if z["kind"] in ("equal_highs", "equal_lows")]
    eq_count = len(eq_zones)
    eq_mitigated = sum(1 for z in eq_zones if z.get("mitigated"))
    eq_active = eq_count - eq_mitigated
    components: dict[str, Any] = {
        "equal_levels": {
            "zones": eq_count,
            "active_zones": eq_active,
            "mitigated_zones": eq_mitigated,
            "included": True,
            "points": round(min(eq_active, 10) / 10.0 * w["equal_levels"], 1),
        }
    }
    for key, weight in (("open_interest", w["open_interest"]), ("funding_rate", w["funding_rate"])):
        item = futures.get(key)
        if not item or item.get("freshness") != "fresh":
            components[key] = {"included": False, "points": 0}
            continue
        val = item.get("value")
        pts = weight if val is not None and key == "open_interest" and float(val) > 0 else 0.0
        if key == "funding_rate" and val is not None:
            pts = round(weight * min(abs(float(val)) / 0.001, 1.0), 1)
        components[key] = {"included": True, "value": val, "points": pts}
    return {
        "score": round(sum(c.get("points", 0) for c in components.values()), 1),
        "components": components,
        "algo_version": LIQUIDITY_ALGO_VERSION,
    }


def compute_liquidity_zones(
    candles: list[dict],
    structure: dict,
    futures: dict[str, Any] | None = None,
    algo_version: str = LIQUIDITY_ALGO_VERSION,
    tolerance_pct: float = EQUAL_LEVEL_TOLERANCE_PCT,
) -> dict[str, Any]:
    swings = structure.get("swings", [])
    highs = [c["high"] for c in candles]
    lows = [c["low"] for c in candles]
    closes = [c["close"] for c in candles]
    times = [c["open_time"] for c in candles]
    n = len(candles)

    zones: list[dict[str, Any]] = []
    for kind, pivot_kind, sweep_dir in (
        ("equal_highs", "high", "high"),
        ("equal_lows", "low", "low"),
    ):
        for cluster in _cluster_swings(swings, pivot_kind, tolerance_pct):
            zone = _make_zone(cluster, kind)
            _mark_sweep_and_reclaim(zone, sweep_dir, times, highs, lows, closes, n)
            zones.append(zone)

    score = liquidity_score(zones, futures)
    return {"algo_version": algo_version, "zones": zones, "score": score}
