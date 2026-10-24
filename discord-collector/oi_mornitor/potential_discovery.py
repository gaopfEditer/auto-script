"""潜力发现门面：目录 + 单币评估（spec v0.2）。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.potential_aggregate import aggregate_candidate, should_export
from oi_mornitor.potential_features import SymbolFeed
from oi_mornitor.potential_model_eval import (
    END_SIGNALS,
    MODEL_LABELS,
    ModelResult,
    evaluate_all_models,
    evaluate_models,
)
from oi_mornitor.potential_model_playbook import enrich_catalog_entry
from oi_mornitor.potential_models_config import load_potential_config

MODEL_CATALOG: list[dict[str, Any]] = [
    enrich_catalog_entry(
        {
            "id": mid,
            "label": MODEL_LABELS[mid],
            "summary": _s,
            "end_signals": END_SIGNALS[mid],
        }
    )
    for mid, _s in [
        ("quiet_oi_breakout", "长期缩量沉寂 · 突发放量 · 多根量能延续（主路径）"),
        ("short_squeeze", "OI 增 + 价抗跌突破（费率仅诊断，默认关闭）"),
        ("relative_strength", "BTC 弱时抗跌 · 企稳后率先突破"),
        ("wyckoff_spring", "箱体震荡 · Spring 假破收回 · 缩量测试"),
        ("liquidity_sweep", "EH/EL 流动性池 · SFP 插针收回"),
    ]
]


def catalog_payload() -> list[dict[str, Any]]:
    enabled = set(load_potential_config().get("models_enabled") or [])
    return [m for m in MODEL_CATALOG if m["id"] in enabled]


def evaluate_symbol_potential(
    feed: SymbolFeed,
    *,
    mcap_tier: str = "t3",
    model_ids: list[str] | None = None,
) -> tuple[list[ModelResult], dict[str, Any] | None]:
    """单币：跑指定模型 → 聚合候选（供 merge 或直出）。"""
    results = evaluate_models(feed, model_ids)
    cand = aggregate_candidate(
        feed.symbol,
        [r for r in results if r.hit and not r.hard_fail],
        mcap_usd=feed.mcap_usd,
        mcap_tier=mcap_tier,
        notes=feed.notes,
    )
    if not cand or not should_export(cand):
        return results, None
    return results, cand
