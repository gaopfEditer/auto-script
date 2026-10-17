"""回测：为形态信号批量计算 capitalFlow 并输出特征边际统计。"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import aiohttp

from oi_mornitor.backtest_metrics import summarize_backtest_extended
from oi_mornitor.capital_flow_attach import enrich_alert_capital_flow
from oi_mornitor.capital_flow_features import capital_flow_aligns_side, confluence_feature_keys
from oi_mornitor.confluence_calibrate import compute_r_multiple
from oi_mornitor.mcap_tier import attach_mcap_tier

logger = logging.getLogger(__name__)

_FEATURE_KEYS = (
    "feat:cf_oi_flush_align",
    "feat:cf_funding_align",
    "feat:cf_funding_against",
    "feat:cf_whale_align",
    "feat:cf_quiet_accum",
    "feat:cf_distribution",
    "feat:cf_distribution_against",
    "feat:cf_liq_reclaim",
    "feat:cf_oi_rebuild_align",
    "feat:cf_oi_rebuild_penalty",
)


def _side_label(it: dict[str, Any]) -> str:
    s = str(it.get("side") or "").lower()
    if s in ("long", "bull"):
        return "long"
    if s in ("short", "bear"):
        return "short"
    return ""


def _stub_from_backtest_item(it: dict[str, Any]) -> dict[str, Any]:
    side = _side_label(it)
    return {
        "symbol": it.get("symbol"),
        "interval": it.get("interval"),
        "side": side,
        "signalAt": it.get("signalAt"),
        "capitalFlow": it.get("capitalFlow"),
    }


def feature_table_for_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按特征 × interval × mcapTier × side 统计 n / 胜率 / expR。"""
    attach_mcap_tier(items)
    buckets: dict[tuple[str, str, str, str], list[tuple[float | None, bool]]] = {}
    for it in items:
        if str(it.get("outcome") or "") not in ("take_profit", "stop_loss"):
            continue
        r = compute_r_multiple(
            {
                "outcome": it.get("outcome"),
                "entry": it.get("entry"),
                "slPrice": it.get("slPrice"),
                "movePct": it.get("movePct"),
                "side": it.get("side"),
            }
        )
        cf = it.get("capitalFlow")
        if not isinstance(cf, dict):
            continue
        side = _side_label(it)
        feats = confluence_feature_keys(cf, side)
        iv = str(it.get("interval") or "—")
        tier = str(it.get("mcapTier") or "t3")
        for fk in _FEATURE_KEYS:
            on = fk in feats
            buckets.setdefault((fk, iv, tier, side), []).append((r, on))
    rows: list[dict[str, Any]] = []
    for (fk, iv, tier, side), pairs in sorted(buckets.items(), key=lambda x: (-len(x[1]), x[0])):
        with_f = [r for r, on in pairs if on and r is not None]
        without_f = [r for r, on in pairs if not on and r is not None]
        if not with_f and not without_f:
            continue
        def _stats(rs: list[float]) -> dict[str, Any]:
            if not rs:
                return {"n": 0, "winRate": None, "expR": None}
            wins = sum(1 for x in rs if x > 0)
            return {
                "n": len(rs),
                "winRate": round(wins / len(rs), 4),
                "expR": round(sum(rs) / len(rs), 4),
            }

        rows.append(
            {
                "feature": fk,
                "interval": iv,
                "mcapTier": tier,
                "side": side,
                "with": _stats(with_f),
                "without": _stats(without_f),
            }
        )
    return rows


def coverage_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    with_cf = [it for it in items if isinstance(it.get("capitalFlow"), dict)]
    days: list[float] = []
    for it in with_cf:
        cov = (it.get("capitalFlow") or {}).get("coverage") or {}
        d = cov.get("oiDays")
        if isinstance(d, (int, float)):
            days.append(float(d))
    return {
        "signalsTotal": len(items),
        "withCapitalFlow": len(with_cf),
        "oiCoverageDaysMedian": round(sorted(days)[len(days) // 2], 2) if days else None,
        "oiCoverageNote": "Binance openInterestHist / ratio 约 30 天；回测仅覆盖可用窗口",
    }


async def attach_capital_flow_to_backtest_items(
    items: list[dict[str, Any]],
    *,
    session: aiohttp.ClientSession,
    base_url: str,
    concurrency: int = 6,
) -> None:
    sem = asyncio.Semaphore(concurrency)

    async def _one(it: dict[str, Any]) -> None:
        if not isinstance(it, dict):
            return
        async with sem:
            stub = {
                "symbol": it.get("symbol"),
                "interval": it.get("interval"),
                "side": it.get("side"),
                "signalAt": it.get("signalAt"),
            }
            await enrich_alert_capital_flow(session, stub, base_url=base_url)
            if stub.get("capitalFlow"):
                it["capitalFlow"] = stub["capitalFlow"]

    await asyncio.gather(*[_one(it) for it in items])
