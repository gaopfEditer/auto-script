"""潜力扫描 · 合并多模型 + 导出过滤。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from oi_mornitor.potential_features import ms_to_utc8_str
from oi_mornitor.potential_model_eval import ModelResult
from oi_mornitor.potential_models_config import load_potential_config
from oi_mornitor.potential_score_explain import composite_score_breakdown

STAGE_ORDER = {"exiting": 0, "triggered": 1, "primed": 2, "watch": 3}
TZ_CN = timezone(timedelta(hours=8))


def now_utc8_str() -> str:
    return datetime.now(TZ_CN).strftime("%Y-%m-%d %H:%M")


def aggregate_candidate(
    symbol: str,
    results: list[ModelResult],
    *,
    mcap_usd: float | None,
    mcap_tier: str,
    notes: str = "",
) -> dict[str, Any] | None:
    cfg = load_potential_config()
    from oi_mornitor.potential_discovery_config import POTENTIAL_SOFT_EXPORT_MIN

    soft_min = float(POTENTIAL_SOFT_EXPORT_MIN or 0)
    valid = [
        r
        for r in results
        if not r.hard_fail
        and (r.hit or (soft_min > 0 and float(r.score) >= soft_min))
    ]
    if not valid:
        return None

    models = [r.model_id for r in valid]
    scores = [r.score for r in valid]
    max_s = max(scores)
    score = min(100.0, max_s + 5.0 * (len(models) - 1))
    stage = min((r.stage for r in valid), key=lambda s: STAGE_ORDER.get(s, 99))
    best = max(valid, key=lambda r: r.score)
    entry = best.entry
    if len(models) > 1:
        tags = "+".join(m.replace("_", "")[:4] for m in models if m != best.model_id)
        if tags:
            entry = f"{entry}（兼{tags}）"[:120]

    exits = [r.exit for r in valid if r.exit and r.stage == "exiting"]
    exit_txt = "；".join(dict.fromkeys(exits))[:160]

    metrics: dict[str, Any] = {"mcap_usd": mcap_usd}
    for r in valid:
        prefix = r.model_id.split("_")[0][:2]
        for k, v in (r.metrics or {}).items():
            key = k if k not in metrics else f"{prefix}_{k}"
            metrics[key] = v

    model_hits = [r.to_hit_dict() for r in valid]
    explain = composite_score_breakdown(valid, score)

    return {
        "symbol": symbol.upper(),
        "mcap_usd": mcap_usd,
        "mcap_tier": mcap_tier,
        "models": models,
        "model_hits": model_hits,
        "score": int(round(score)),
        "stage": stage,
        "entry": entry,
        "exit": exit_txt,
        "metrics": metrics,
        "tf": best.tf,
        "signal_tf": best.tf,
        "signal_time_ms": best.signal_time_ms,
        "signal_time_utc8": ms_to_utc8_str(best.signal_time_ms),
        "direction": explain.get("direction"),
        "direction_label": explain.get("direction_label"),
        "score_summary": explain.get("score_summary"),
        "score_reasons": explain.get("score_reasons"),
        "max_model_score": explain.get("max_model_score"),
        "resonance_bonus": explain.get("resonance_bonus"),
        "model_count": explain.get("model_count"),
        "ts_utc8": now_utc8_str(),
        "scan_at_utc8": now_utc8_str(),
        "notes": notes,
        "top_model": best.model_id,
    }


def should_export(cand: dict[str, Any]) -> bool:
    """形态页列表：score ≥ score_list_min；GitHub 推送仍可用更高 score_push。"""
    cfg = load_potential_config()["export"]
    list_min = float(cfg.get("score_list_min", 55))
    score = float(cand.get("score") or 0)
    return score >= list_min


def build_export_payload(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    cfg = load_potential_config()
    exp = cfg["export"]
    sorted_c = sorted(
        candidates,
        key=lambda x: (STAGE_ORDER.get(str(x.get("stage")), 9), -int(x.get("score") or 0)),
    )
    max_n = int(exp["max_candidates"])
    return {
        "updated_utc8": now_utc8_str(),
        "refresh_hours": int(exp["refresh_hours"]),
        "source_note": "local filtered candidates only",
        "risk_hint": str(exp["risk_hint"]),
        "candidates": sorted_c[:max_n],
    }
