"""Bridge: stash scan klines on alerts + message badges."""

from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.agent_decision import attach_agent_decision, strip_pa_klines_from_alert
from oi_mornitor.pa.candles import df_to_candles
from oi_mornitor.pa.params import PA_LOOKBACK


def stash_pa_klines_on_alert(alert: dict[str, Any], df: pd.DataFrame | None) -> None:
    if df is None or df.empty:
        return
    alert["pa_klines"] = df_to_candles(df, max_bars=PA_LOOKBACK)


def attach_agent_decision_on_alert(
    alert: dict[str, Any],
    *,
    klines: list | None = None,
    futures: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    return attach_agent_decision(alert, klines=klines, futures=futures)


def format_agent_decision_badge(decision: dict[str, Any] | None) -> str:
    if not decision:
        return ""
    pg = decision.get("primaryGroup")
    if not pg:
        return "决策·—"
    veto = decision.get("shadowVeto") or {}
    v = "·影否决" if veto.get("active") else ""
    return f"决策·{pg}{v}"


def append_agent_decision_to_message(body: str, decision: dict[str, Any] | None) -> str:
    badge = format_agent_decision_badge(decision)
    if not badge:
        return body
    return f"{body.rstrip()}\n🏷 {badge}"
