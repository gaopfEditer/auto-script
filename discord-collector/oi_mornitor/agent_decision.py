"""Read-only agent decision layer: parallel groups A / B / C + shadow veto + expectancy hooks."""

from __future__ import annotations

import logging
from typing import Any

from oi_mornitor.confluence_features import extract_confluence_features, normalize_type_label
from oi_mornitor.env_parse import env_bool, env_float, env_int
from oi_mornitor.expectancy_combo import build_expectancy_key, evidence_sufficient
from oi_mornitor.pa.analysis import compute_pa_snapshot
from oi_mornitor.pa.candles import df_to_candles, drop_forming_bar, klines_rows_to_candles
from oi_mornitor.pa_storage import append_pa_record

logger = logging.getLogger(__name__)

AGENT_DECISION_VERSION = "agent-decision-v1"
_MIN_B_TAGS = env_int("OI_AGENT_DECISION_MIN_B_TAGS", 1, min_val=1, max_val=10)
_NEAR_OB_PCT = env_float("OI_AGENT_DECISION_NEAR_OB_PCT", 0.5)  # % distance to OB/FVG band


def agent_decision_enabled() -> bool:
    return env_bool("OI_AGENT_DECISION_ENABLED", False)


def agent_decision_persist_pa() -> bool:
    return agent_decision_enabled() and env_bool("OI_AGENT_DECISION_PERSIST_PA", False)


_STRUCTURE_LONG = frozenset({"bos_bullish", "choch_bullish"})
_STRUCTURE_SHORT = frozenset({"bos_bearish", "choch_bearish"})


def _alert_side(alert: dict[str, Any]) -> str:
    s = str(alert.get("side") or "").lower()
    if s in ("long", "bull"):
        return "long"
    if s in ("short", "bear"):
        return "short"
    d = str(alert.get("dir") or "")
    if d == "多":
        return "long"
    if d == "空":
        return "short"
    return ""


def resolve_pa_candles(alert: dict[str, Any], klines: list | None = None) -> list[dict[str, Any]]:
    raw = klines
    if raw is None:
        raw = alert.get("pa_klines") or alert.get("klines")
    if raw is None and alert.get("_pa_df") is not None:
        return df_to_candles(alert["_pa_df"])
    if raw is None:
        return []
    candles = klines_rows_to_candles(raw)
    iv = str(alert.get("interval") or "15m")
    return drop_forming_bar(candles, iv)


def classify_group_a(alert: dict[str, Any]) -> dict[str, Any]:
    """Existing morphology / VP / MA / Vegas / MACD / TD9 style signals."""
    tags: list[str] = []
    label = normalize_type_label(
        str(alert.get("type_label") or alert.get("typeLabel") or alert.get("kind") or "")
    )
    if label:
        tags.append(f"type:{label}")
    kind = str(alert.get("kind") or alert.get("signal_kind") or "")
    if kind:
        tags.append(f"kind:{kind}")
    if alert.get("oi_anomaly"):
        tags.append("oi_anomaly")
    if alert.get("tdSetup") is not None:
        tags.append("td9")
    if alert.get("revVolSignal"):
        tags.append("rev_vol")
    if alert.get("vp_formal") or "量价" in label:
        tags.append("volume_price")
    if "vegas" in label.lower() or alert.get("vegas_channel"):
        tags.append("vegas")
    if "sweep" in kind.lower() or "流动性" in label:
        tags.append("liquidity_sweep_legacy")
    try:
        feats = extract_confluence_features({**alert, "typeLabel": label or alert.get("typeLabel")})
        for k in sorted(feats.keys()):
            if k.startswith(("combo:", "feat:", "family:")):
                tags.append(k)
    except Exception:  # noqa: BLE001
        pass
    tags = list(dict.fromkeys(tags))
    active = bool(tags) or str(alert.get("type") or "").endswith("_card")
    return {"active": active, "tags": tags, "reasons": tags[:8]}


def classify_group_b(pa: dict[str, Any], side: str, *, since_bars: int = 12) -> dict[str, Any]:
    tags: list[str] = []
    reasons: list[str] = []
    if pa.get("empty"):
        return {"active": False, "tags": [], "reasons": ["pa_empty"], "paSummary": {}}

    structure = pa.get("structure") or {}
    trend = structure.get("trend")
    events = structure.get("events") or []
    recent = [e for e in events if e.get("index", 0) >= max(0, len(events) - since_bars)]

    if side == "long":
        if trend == "up":
            tags.append("structure_up")
        for e in recent:
            if e.get("type") in _STRUCTURE_LONG:
                tags.append(f"event:{e['type']}")
    elif side == "short":
        if trend == "down":
            tags.append("structure_down")
        for e in recent:
            if e.get("type") in _STRUCTURE_SHORT:
                tags.append(f"event:{e['type']}")

    zones = (pa.get("liquidity") or {}).get("zones") or []
    for z in zones[-6:]:
        if z.get("mitigated"):
            tags.append(f"liq_sweep:{z.get('kind')}")
            if z.get("reclaimed"):
                tags.append("liq_sweep_reclaim")

    close = float(pa.get("close") or 0)
    obs = (pa.get("obfvg") or {}).get("order_blocks") or []
    for ob in obs:
        if ob.get("mitigated"):
            continue
        lo, hi = ob["range"]["low"], ob["range"]["high"]
        if close > 0 and min(abs(close - lo), abs(close - hi)) / close <= _NEAR_OB_PCT / 100.0:
            tags.append(f"near_ob:{ob.get('direction')}")

    fvgs = (pa.get("obfvg") or {}).get("fvgs") or []
    for fvg in fvgs[-5:]:
        if fvg.get("mitigated"):
            continue
        lo, hi = fvg["range"]["low"], fvg["range"]["high"]
        if lo <= close <= hi:
            tags.append(f"in_fvg:{fvg.get('direction')}")

    vwap = pa.get("vwap") or {}
    pos = vwap.get("position")
    if pos:
        tags.append(f"vwap_{pos}")
    reclaim = vwap.get("reclaim")
    if reclaim:
        tags.append(f"vwap_{reclaim}")

    tags = list(dict.fromkeys(tags))
    active = len(tags) >= _MIN_B_TAGS
    reasons = tags[:10]
    summary = {
        "trend": trend,
        "lastEvent": events[-1]["type"] if events else None,
        "vwapPosition": pos,
        "liquiditySweeps": sum(1 for z in zones if z.get("mitigated")),
    }
    return {"active": active, "tags": tags, "reasons": reasons, "paSummary": summary}


def classify_group_c(group_a: dict, group_b: dict) -> dict[str, Any]:
    active = bool(group_a.get("active")) and bool(group_b.get("active"))
    return {
        "active": active,
        "resonance": active,
        "reasons": ["A∩B"] if active else [],
    }


def compute_shadow_veto(alert: dict[str, Any], pa: dict[str, Any], side: str) -> dict[str, Any]:
    """Record-only veto (does not block live orders)."""
    reasons: list[str] = []
    trend = (pa.get("structure") or {}).get("trend")
    if side == "long" and trend == "down":
        reasons.append("structure_trend_against_long")
    if side == "short" and trend == "up":
        reasons.append("structure_trend_against_short")
    fr = alert.get("capitalFlow") if isinstance(alert.get("capitalFlow"), dict) else None
    if fr and side == "long" and str(fr.get("bias") or "").lower() == "distribution":
        reasons.append("cf_distribution_vs_long")
    return {"active": bool(reasons), "shadow": True, "reasons": reasons}


def attach_agent_decision(
    alert: dict[str, Any],
    *,
    klines: list | None = None,
    futures: dict[str, Any] | None = None,
    persist_pa: bool | None = None,
) -> dict[str, Any] | None:
    if not agent_decision_enabled():
        return None
    side = _alert_side(alert)
    group_a = classify_group_a(alert)
    candles = resolve_pa_candles(alert, klines=klines)
    pa: dict[str, Any] = {}
    if candles:
        try:
            pa = compute_pa_snapshot(candles, futures=futures)
        except Exception as exc:  # noqa: BLE001
            logger.debug("PA snapshot failed: %s", exc)
            pa = {"empty": True, "error": str(exc)}
    else:
        pa = {"empty": True, "reason": "klines_unavailable"}

    group_b = classify_group_b(pa, side)
    group_c = classify_group_c(group_a, group_b)
    veto = compute_shadow_veto(alert, pa, side)

    primary = None
    if group_c.get("active"):
        primary = "C"
    elif group_b.get("active"):
        primary = "B"
    elif group_a.get("active"):
        primary = "A"

    decision: dict[str, Any] = {
        "version": AGENT_DECISION_VERSION,
        "readOnly": True,
        "groups": {"A": group_a, "B": group_b, "C": group_c},
        "primaryGroup": primary,
        "shadowVeto": veto,
    }
    decision["expectancyKey"] = build_expectancy_key(decision, alert)
    decision["evidenceSufficient"] = False  # filled when expectancy table has n>=min
    alert["agentDecision"] = decision

    if persist_pa if persist_pa is not None else agent_decision_persist_pa():
        if candles and not pa.get("empty"):
            try:
                append_pa_record(
                    str(alert.get("symbol") or ""),
                    str(alert.get("interval") or "15m"),
                    {
                        "effective_from": pa.get("effective_from"),
                        "algo_version": pa.get("algo_version"),
                        "agentDecision": {
                            "primaryGroup": primary,
                            "expectancyKey": decision["expectancyKey"],
                        },
                        "pa": {
                            "structure_trend": (pa.get("structure") or {}).get("trend"),
                            "vwap_position": (pa.get("vwap") or {}).get("position"),
                        },
                    },
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("PA persist skip: %s", exc)
    return decision


def strip_pa_klines_from_alert(alert: dict[str, Any]) -> None:
    """Remove bulky klines before persistence to stats DB."""
    alert.pop("pa_klines", None)
    alert.pop("klines", None)
    alert.pop("_pa_df", None)
