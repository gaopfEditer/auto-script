"""Order blocks + FVG (3-candle imbalance)."""

from __future__ import annotations

from typing import Any

from oi_mornitor.pa.params import FVG_MIN_GAP_PCT, OB_DEDUP_TOLERANCE_PCT, OBFVG_ALGO_VERSION


def _last_opposite_candle(candles: list[dict], upto_index: int, want_red: bool) -> int | None:
    for i in range(upto_index - 1, -1, -1):
        c = candles[i]
        red = c["close"] < c["open"]
        if red == want_red:
            return i
    return None


def _mark_order_block(zone: dict, candles: list[dict]) -> None:
    n = len(candles)
    direction = zone["direction"]
    start = zone["event_index"] + 1
    for i in range(start, n):
        c = candles[i]
        if direction == "bullish":
            if c["close"] < zone["range"]["low"]:
                zone["zone_type"] = "breaker"
                zone["mitigated"] = True
                return
            if not zone["mitigated"] and c["low"] <= zone["range"]["high"]:
                zone["mitigated"] = True
                zone["zone_type"] = "mitigation_block"
        else:
            if c["close"] > zone["range"]["high"]:
                zone["zone_type"] = "breaker"
                zone["mitigated"] = True
                return
            if not zone["mitigated"] and c["high"] >= zone["range"]["low"]:
                zone["mitigated"] = True
                zone["zone_type"] = "mitigation_block"


def _mark_fvg(zone: dict, candles: list[dict]) -> None:
    n = len(candles)
    direction = zone["direction"]
    for i in range(zone["formed_at"] + 1, n):
        c = candles[i]
        if direction == "bullish":
            if c["low"] <= zone["range"]["high"]:
                zone["mitigated"] = True
                return
        else:
            if c["high"] >= zone["range"]["low"]:
                zone["mitigated"] = True
                return


def _compute_fvgs(candles: list[dict], min_gap_pct: float) -> list[dict]:
    n = len(candles)
    fvgs: list[dict] = []
    for i in range(n - 2):
        a, c = candles[i], candles[i + 2]
        if a["high"] < c["low"]:
            lo, hi, direction = a["high"], c["low"], "bullish"
        elif a["low"] > c["high"]:
            lo, hi, direction = c["high"], a["low"], "bearish"
        else:
            continue
        ref = (a["high"] + a["low"]) / 2.0
        if ref > 0 and (hi - lo) / ref * 100.0 < min_gap_pct:
            continue
        zone: dict[str, Any] = {
            "zone_id": f"fvg:{i}:{i + 2}",
            "zone_type": "fvg",
            "direction": direction,
            "range": {"low": lo, "high": hi},
            "formed_at": i + 2,
            "mitigated": False,
        }
        _mark_fvg(zone, candles)
        fvgs.append(zone)
    return fvgs


def _dedup_order_blocks(order_blocks: list[dict], tolerance_pct: float) -> list[dict]:
    kept: list[dict] = []
    for ob in order_blocks:
        lo, hi = ob["range"]["low"], ob["range"]["high"]
        ref = (lo + hi) / 2.0
        tol = ref * tolerance_pct / 100.0
        dup = False
        for k in kept:
            if k["direction"] != ob["direction"]:
                continue
            klo, khi = k["range"]["low"], k["range"]["high"]
            if not (hi + tol < klo or khi + tol < lo):
                dup = True
                break
        if not dup:
            kept.append(ob)
    return kept


def compute_order_blocks(
    candles: list[dict],
    structure: dict,
    algo_version: str = OBFVG_ALGO_VERSION,
    min_gap_pct: float = FVG_MIN_GAP_PCT,
    dedup_tolerance_pct: float = OB_DEDUP_TOLERANCE_PCT,
) -> dict[str, Any]:
    events = structure.get("events", [])
    order_blocks: list[dict] = []
    for ev in events:
        if ev["type"] in ("bos_bullish", "choch_bullish"):
            direction, want_red = "bullish", True
        else:
            direction, want_red = "bearish", False
        ob_idx = _last_opposite_candle(candles, ev["index"], want_red=want_red)
        if ob_idx is None:
            continue
        c = candles[ob_idx]
        zone: dict[str, Any] = {
            "zone_id": f"ob:{ev['index']}:{ob_idx}",
            "zone_type": "order_block",
            "direction": direction,
            "range": {"low": c["low"], "high": c["high"]},
            "event_index": ev["index"],
            "candle_index": ob_idx,
            "formed_at": ob_idx,
            "mitigated": False,
        }
        _mark_order_block(zone, candles)
        order_blocks.append(zone)

    order_blocks = _dedup_order_blocks(order_blocks, dedup_tolerance_pct)
    return {
        "algo_version": algo_version,
        "order_blocks": order_blocks,
        "fvgs": _compute_fvgs(candles, min_gap_pct),
    }
