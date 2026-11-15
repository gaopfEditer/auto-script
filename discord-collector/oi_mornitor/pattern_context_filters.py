"""形态信号列表：OI 异动 / 清算触发 上下文筛选（与 capital_flow、强平库同口径）。"""
from __future__ import annotations

import logging
from typing import Any

from oi_mornitor.capital_flow_store import liquidations_in_window
from oi_mornitor.symbol_aliases import normalize_usdt_symbol

logger = logging.getLogger(__name__)

# 与研究/run-log 默认一致
POST_LIQ_LOOKBACK_MS = 3 * 3_600_000
POST_LIQ_FOLLOW_MS = 4 * 3_600_000
POST_LIQ_CLUSTER_MIN = 3
POST_LIQ_MIN_AFTER_MS = 15 * 60_000

CONTEXT_FILTER_ALL = "all"
CONTEXT_FILTER_OI_ANOMALY = "oi_anomaly"
CONTEXT_FILTER_POST_LIQ = "post_liq"

CONTEXT_FILTER_LABELS: dict[str, str] = {
    CONTEXT_FILTER_ALL: "全部",
    CONTEXT_FILTER_OI_ANOMALY: "OI异动",
    CONTEXT_FILTER_POST_LIQ: "清算触发",
}

_liq_post_cache: dict[tuple[str, int, int], bool] = {}


def _cf(rec: dict[str, Any]) -> dict[str, Any]:
    cf = rec.get("capitalFlow")
    return cf if isinstance(cf, dict) else {}


def _flags(rec: dict[str, Any]) -> dict[str, Any]:
    fl = _cf(rec).get("flags")
    return fl if isinstance(fl, dict) else {}


def _confluence_factor_keys(rec: dict[str, Any]) -> set[str]:
    conf = rec.get("confluence")
    if not isinstance(conf, dict):
        return set()
    keys: set[str] = set()
    for f in conf.get("topFactors") or []:
        if isinstance(f, dict):
            k = str(f.get("key") or f.get("id") or "").strip()
            if k:
                keys.add(k)
        elif isinstance(f, str) and f.strip():
            keys.add(f.strip())
    return keys


def is_oi_anomaly_context(rec: dict[str, Any]) -> bool:
    """信号时刻处于 OI 骤降等同境（资金流 flags 或共振特征）。"""
    if _flags(rec).get("oi_flush"):
        return True
    if "feat:cf_oi_flush_align" in _confluence_factor_keys(rec):
        return True
    dec = rec.get("agentDecision")
    if isinstance(dec, dict):
        tags = dec.get("tags") or []
        if isinstance(tags, list) and "oi_anomaly" in tags:
            return True
    key = str(rec.get("key") or "")
    if key.startswith("oi_anomaly:") or key.startswith("candle_pattern_oi:"):
        return True
    lab = str(rec.get("typeLabel") or "")
    if "(oi异动)" in lab or "oi异动" in lab:
        return True
    return False


def _post_liq_from_liquidations(rec: dict[str, Any]) -> bool:
    sym = normalize_usdt_symbol(
        str(rec.get("tradeSymbol") or rec.get("symbol") or "").strip()
    )
    sat = int(rec.get("signalAt") or 0)
    if not sym or sat <= 0:
        return False
    bucket = sat // (15 * 60_000)
    cache_key = (sym, bucket, POST_LIQ_LOOKBACK_MS)
    if cache_key in _liq_post_cache:
        return _liq_post_cache[cache_key]
    start = sat - POST_LIQ_LOOKBACK_MS
    evs = liquidations_in_window(sym, start_ms=start, end_ms=sat, limit=500)
    ok = False
    if len(evs) >= POST_LIQ_CLUSTER_MIN:
        times = []
        for e in evs:
            t = int(e.get("eventTimeMs") or e.get("event_time_ms") or 0)
            if t > 0:
                times.append(t)
        if times:
            t0 = max(times)
            if t0 + POST_LIQ_MIN_AFTER_MS < sat <= t0 + POST_LIQ_FOLLOW_MS:
                ok = True
    _liq_post_cache[cache_key] = ok
    return ok


def is_post_liquidation_context(rec: dict[str, Any]) -> bool:
    """清算簇已触发且形态信号落在其后窗口（含清算回收 / 强平库簇）。"""
    if _flags(rec).get("liquidation_reclaim"):
        return True
    if "feat:cf_liq_reclaim" in _confluence_factor_keys(rec):
        return True
    raw = _cf(rec).get("raw")
    if isinstance(raw, dict) and raw.get("liqReclaimSource"):
        return True
    return _post_liq_from_liquidations(rec)


def context_flags_for(rec: dict[str, Any]) -> dict[str, bool]:
    return {
        "oiAnomaly": is_oi_anomaly_context(rec),
        "postLiq": is_post_liquidation_context(rec),
    }


def apply_context_filter(
    rows: list[dict[str, Any]],
    context_filter: str | None,
) -> list[dict[str, Any]]:
    cf = str(context_filter or CONTEXT_FILTER_ALL).strip().lower() or CONTEXT_FILTER_ALL
    if cf in ("", CONTEXT_FILTER_ALL, "any"):
        return rows
    if cf == CONTEXT_FILTER_OI_ANOMALY:
        return [r for r in rows if is_oi_anomaly_context(r)]
    if cf == CONTEXT_FILTER_POST_LIQ:
        return [r for r in rows if is_post_liquidation_context(r)]
    logger.debug("未知 context_filter=%s，忽略", cf)
    return rows


def list_context_filter_options(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """下拉：各上下文状态条数 / 胜率（与列表其它 facet 同 summarize 口径）。"""
    from oi_mornitor.pattern_alert_stats import _facet_option_stats

    out: list[dict[str, Any]] = [
        {
            "id": CONTEXT_FILTER_ALL,
            "label": CONTEXT_FILTER_LABELS[CONTEXT_FILTER_ALL],
            **_facet_option_stats(rows),
        }
    ]
    for fid in (CONTEXT_FILTER_OI_ANOMALY, CONTEXT_FILTER_POST_LIQ):
        bucket = apply_context_filter(rows, fid)
        out.append(
            {
                "id": fid,
                "label": CONTEXT_FILTER_LABELS[fid],
                **_facet_option_stats(bucket),
            }
        )
    return out