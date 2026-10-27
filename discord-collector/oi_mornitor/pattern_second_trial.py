"""方案1：规则因子候选 → 硬门禁 + LLM 第二审判 → 正式行 / 观察档。"""
from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass
from typing import Any

from oi_mornitor.ai_judge_bridge import (
    AdapterJudgeResult,
    build_ezcoin_snapshot,
    call_adapter_judge,
)
from oi_mornitor.config import (
    OI_SECOND_TRIAL_BYPASS,
    OI_SECOND_TRIAL_DEDUPE_TTL_SEC,
    OI_SECOND_TRIAL_ENABLED,
    OI_SECOND_TRIAL_FORMAL_ACTIONS,
    OI_SECOND_TRIAL_LLM_MAX_TIER,
    OI_SECOND_TRIAL_T3_LLM_SAMPLE_PCT,
)
from oi_mornitor.mcap_tier import MCAP_TIER_ORDER, resolve_mcap_tier
from oi_mornitor.pattern_alert_stats import alert_stats_key

logger = logging.getLogger(__name__)

_TIER_RANK = {t: i for i, t in enumerate(MCAP_TIER_ORDER, start=1)}

_DEDUPE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}


@dataclass
class SecondTrialVerdict:
    enabled: bool
    formal: bool
    gate_result: str = "skipped"
    action: str = ""
    llm_called: bool = False
    llm_skipped_reason: str = ""
    reason: str = ""
    adapter_error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "formal": self.formal,
            "gate_result": self.gate_result,
            "action": self.action,
            "llm_called": self.llm_called,
            "llm_skipped_reason": self.llm_skipped_reason,
            "reason": self.reason,
            "adapter_error": self.adapter_error,
        }


def _tier_rank(tier: str) -> int:
    return _TIER_RANK.get(str(tier or "t3").lower(), 3)


def _should_call_llm(symbol: str) -> tuple[bool, str]:
    tier = resolve_mcap_tier(symbol)
    max_tier = str(OI_SECOND_TRIAL_LLM_MAX_TIER or "t2").lower()
    if _tier_rank(tier) <= _tier_rank(max_tier):
        return True, ""
    pct = float(OI_SECOND_TRIAL_T3_LLM_SAMPLE_PCT)
    if pct > 0 and random.random() * 100.0 < pct:
        return True, "t3_sample"
    return False, "t3_llm_not_scheduled"


def _dedupe_key(alert: dict[str, Any]) -> str:
    return alert_stats_key(alert)


def _cache_get(key: str) -> dict[str, Any] | None:
    ttl = max(0, int(OI_SECOND_TRIAL_DEDUPE_TTL_SEC))
    if ttl <= 0:
        return None
    row = _DEDUPE_CACHE.get(key)
    if not row:
        return None
    ts, verdict = row
    if time.time() - ts > ttl:
        _DEDUPE_CACHE.pop(key, None)
        return None
    return verdict


def _cache_put(key: str, verdict: dict[str, Any]) -> None:
    ttl = max(0, int(OI_SECOND_TRIAL_DEDUPE_TTL_SEC))
    if ttl <= 0:
        return
    _DEDUPE_CACHE[key] = (time.time(), verdict)


def evaluate_second_trial(
    alert: dict[str, Any],
    *,
    radar_snapshot: dict[str, Any] | None = None,
    confluence_formal: bool,
) -> SecondTrialVerdict:
    """
    返回是否可记为正式行（计入头条胜率）。
    confluence_formal=False（C 档等）时跳过 adapter，直接非正式。
    """
    if not confluence_formal:
        return SecondTrialVerdict(
            enabled=bool(OI_SECOND_TRIAL_ENABLED),
            formal=False,
            reason="confluence_not_formal",
        )
    if not OI_SECOND_TRIAL_ENABLED:
        return SecondTrialVerdict(enabled=False, formal=True, reason="second_trial_disabled")

    if OI_SECOND_TRIAL_BYPASS:
        return SecondTrialVerdict(
            enabled=True,
            formal=True,
            gate_result="bypass",
            reason="dev_bypass",
        )

    dedupe = _dedupe_key(alert)
    cached = _cache_get(dedupe)
    if cached:
        return SecondTrialVerdict(
            enabled=True,
            formal=bool(cached.get("formal")),
            gate_result=str(cached.get("gate_result") or "cached"),
            action=str(cached.get("action") or ""),
            llm_called=bool(cached.get("llm_called")),
            llm_skipped_reason=str(cached.get("llm_skipped_reason") or ""),
            reason="dedupe_cache",
            adapter_error=str(cached.get("adapter_error") or ""),
        )

    sym = str(alert.get("symbol") or "")
    llm_call, skip_reason = _should_call_llm(sym)
    snapshot = build_ezcoin_snapshot(alert, radar_snapshot=radar_snapshot)
    judge: AdapterJudgeResult = call_adapter_judge(snapshot)

    gate = judge.gate_result or "unavailable"
    action = (judge.action or "").upper()
    formal_actions = {a.strip().upper() for a in OI_SECOND_TRIAL_FORMAL_ACTIONS if a.strip()}

    verdict = SecondTrialVerdict(
        enabled=True,
        formal=False,
        gate_result=gate,
        action=action,
        llm_called=llm_call,
        llm_skipped_reason=skip_reason,
        adapter_error=judge.error,
    )

    if gate == "unavailable":
        verdict.reason = "adapter_unreachable"
        _cache_put(dedupe, verdict.to_dict())
        return verdict

    if gate != "pass":
        verdict.reason = "gate_reject"
        _cache_put(dedupe, verdict.to_dict())
        return verdict

    if not llm_call:
        verdict.reason = skip_reason or "llm_not_called"
        _cache_put(dedupe, verdict.to_dict())
        return verdict

    if action in formal_actions:
        verdict.formal = True
        verdict.reason = "gate_pass_llm_action"
    else:
        verdict.reason = "llm_not_trade" if action else "llm_empty_action"

    _cache_put(dedupe, verdict.to_dict())
    return verdict
