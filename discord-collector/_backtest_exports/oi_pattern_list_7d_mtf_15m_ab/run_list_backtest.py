#!/usr/bin/env python3
"""Read-only 形态信号列表 backtest: last 7d, 15m, MTF resonance only, confluence A/B.

Does not write pattern_alert_stats.json or restart any service.
Uses stored list settlements (does not re-walk klines).
"""
from __future__ import annotations

import csv
import json
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path("/Users/maotouying/frontend/code/1.operations/auto-script/discord-collector")
sys.path.insert(0, str(ROOT))

from oi_mornitor.equity_mcap import classify_equity, company_market_cap_usd
from oi_mornitor.mcap_market_quote import market_cap_usd_sync
from oi_mornitor.mcap_tier import (
    ALL_TIER_ORDER,
    attach_mcap_tier,
    mcap_tier_label,
    mcap_thresholds_usd,
    resolve_mcap_tier,
)
from oi_mornitor.pattern_alert_stats import (
    _apply_tier_filters,
    _rec_pnl_pct,
    filter_alert_stats,
    is_headline_win_rate_excluded,
    list_alert_stats,
    summarize,
)
from oi_mornitor.pattern_mtf_resonance import (
    MTF_RESONANCE_WINDOW_MS,
    attach_mtf_resonance,
    compute_mtf_resonance_by_key,
    has_mtf_resonance,
)
from oi_mornitor.pattern_settle import settle_rules_summary
from oi_mornitor.pattern_settle_profile import is_observation_record
from oi_mornitor.signal_confluence import attach_signal_confluence, filter_items_by_confluence
from oi_mornitor.trade_leverage import audit_assumptions, leverage_for_symbol

TZ = timezone(timedelta(hours=8))
OUT = Path("/tmp/oi_pattern_list_7d_ab_20261113")
OUT.mkdir(parents=True, exist_ok=True)

CRYPTO_TIERS = ("t1", "t2", "t3")
EQ_STOCK_TIERS = ("eq-t1", "eq-t2", "eq-t3")
EQ_BASKETS = ("eq-index", "eq-lev", "eq-macro", "eq-other")


def ms_to_cst(ms: int) -> str:
    if not ms:
        return ""
    return datetime.fromtimestamp(ms / 1000.0, TZ).strftime("%Y-%m-%d %H:%M:%S")


def outcome_of(rec: dict[str, Any]) -> str:
    return str(rec.get("outcome") or "pending").strip().lower() or "pending"


def conf_tier(rec: dict[str, Any]) -> str:
    c = rec.get("confluence")
    if isinstance(c, dict):
        return str(c.get("tier") or "C").strip().upper() or "C"
    return "C"


def conf_score(rec: dict[str, Any]) -> Any:
    c = rec.get("confluence")
    if isinstance(c, dict):
        return c.get("score")
    return None


def bucket_counts(rows: list[dict[str, Any]], *, exclude_observation_from_headline: bool = True) -> dict[str, Any]:
    total = len(rows)
    obs = 0
    pending = wins = losses = flats = errors = other = 0
    missing_outcome = 0
    pnl_sum = 0.0
    pnl_n = 0
    headline_excluded_obs = 0
    for r in rows:
        if is_observation_record(r) or is_headline_win_rate_excluded(r):
            obs += 1
        oc = outcome_of(r)
        if not rec_has_outcome_field(r):
            missing_outcome += 1
        if oc == "pending":
            pending += 1
        elif oc == "take_profit":
            wins += 1
        elif oc == "stop_loss":
            losses += 1
        elif oc == "flat":
            flats += 1
        elif oc == "error":
            errors += 1
        else:
            other += 1
        if exclude_observation_from_headline and is_headline_win_rate_excluded(r):
            headline_excluded_obs += 1
        pnl = _rec_pnl_pct(r)
        if pnl is not None and not (
            exclude_observation_from_headline and is_headline_win_rate_excluded(r)
        ):
            # still record raw pnl on row; headline pnl computed separately
            pass

    # Headline (list summarize): drop observation, drop flat/error from headline rows;
    # winRate = wins / (wins+losses) among non-obs, non-flat, non-error.
    headline_rows = []
    for r in rows:
        if exclude_observation_from_headline and is_headline_win_rate_excluded(r):
            continue
        oc = outcome_of(r)
        if oc in ("flat", "error"):
            continue
        headline_rows.append(r)
    h_pending = h_wins = h_losses = 0
    h_pnl = 0.0
    h_pnl_n = 0
    for r in headline_rows:
        oc = outcome_of(r)
        if oc == "pending":
            h_pending += 1
        elif oc == "take_profit":
            h_wins += 1
        elif oc == "stop_loss":
            h_losses += 1
        pnl = _rec_pnl_pct(r)
        if pnl is not None:
            h_pnl += pnl
            h_pnl_n += 1
    settled = h_wins + h_losses
    # raw pnl including obs
    raw_pnl = 0.0
    raw_pnl_n = 0
    for r in rows:
        pnl = _rec_pnl_pct(r)
        if pnl is not None:
            raw_pnl += pnl
            raw_pnl_n += 1
    return {
        "total": total,
        "observation": obs,
        "headlineExcludedObservation": headline_excluded_obs,
        "pending": pending,
        "wins": wins,
        "losses": losses,
        "flats": flats,
        "errors": errors,
        "otherOutcome": other,
        "missingOutcomeField": missing_outcome,
        "settledForWinRate": settled,
        "headlinePending": h_pending,
        "headlineWins": h_wins,
        "headlineLosses": h_losses,
        "winRate": (h_wins / settled) if settled else None,
        "winRatePct": round(100.0 * h_wins / settled, 2) if settled else None,
        "winRateDefinition": "wins / (wins + losses); 仅 take_profit/stop_loss；观察档、pending、flat、error、缺失不进分母",
        "headlineTotalPnlPct": round(h_pnl, 2) if h_pnl_n else None,
        "rawTotalPnlPct": round(raw_pnl, 2) if raw_pnl_n else None,
    }


def rec_has_outcome_field(r: dict[str, Any]) -> bool:
    return "outcome" in r and r.get("outcome") is not None and str(r.get("outcome")).strip() != ""


def future_peer_info(rec: dict[str, Any], by_key_mtf: dict[str, dict[str, Any]], peer_pool: list[dict[str, Any]]) -> dict[str, Any]:
    """Whether list MTF (±4h, includes later signals) used any peer after this signal."""
    m = rec.get("mtfResonance") if isinstance(rec.get("mtfResonance"), dict) else by_key_mtf.get(str(rec.get("key") or ""))
    sat = int(rec.get("signalAt") or 0)
    if not m or sat <= 0:
        return {"hasFuturePeer": False, "futurePeerCount": 0, "causalStillResonates": False}
    # Recompute causal vs two-sided from eligible peers in window
    from oi_mornitor.pattern_mtf_resonance import (
        MTF_RESONANCE_INTERVALS,
        _side_key,
        _symbol_key,
        mtf_resonance_family,
    )

    sym = _symbol_key(rec)
    side = _side_key(rec)
    fam = mtf_resonance_family(str(rec.get("typeLabel") or ""), side)
    lo, hi = sat - MTF_RESONANCE_WINDOW_MS, sat + MTF_RESONANCE_WINDOW_MS
    ivs_all: set[str] = set()
    ivs_causal: set[str] = set()
    future_n = 0
    if fam and side and sym:
        for p in peer_pool:
            if not isinstance(p, dict):
                continue
            psat = int(p.get("signalAt") or 0)
            if psat <= 0 or psat < lo or psat > hi:
                continue
            if _symbol_key(p) != sym or _side_key(p) != side:
                continue
            pf = mtf_resonance_family(str(p.get("typeLabel") or ""), _side_key(p))
            if pf != fam:
                continue
            iv = str(p.get("interval") or "").strip()
            if iv not in MTF_RESONANCE_INTERVALS:
                continue
            ivs_all.add(iv)
            if psat <= sat:
                ivs_causal.add(iv)
            if psat > sat:
                future_n += 1
        # include self interval
        self_iv = str(rec.get("interval") or "").strip()
        if self_iv in MTF_RESONANCE_INTERVALS:
            ivs_all.add(self_iv)
            ivs_causal.add(self_iv)
    return {
        "hasFuturePeer": future_n > 0,
        "futurePeerCount": future_n,
        "causalStillResonates": len(ivs_causal) >= 2,
        "causalIntervals": sorted(ivs_causal),
        "twoSidedIntervals": sorted(ivs_all),
    }


def main() -> None:
    started = time.time()
    now_ms = int(time.time() * 1000)
    cutoff_cst = datetime.fromtimestamp(now_ms / 1000.0, TZ)
    window_ms = 7 * 24 * 60 * 60 * 1000
    start_ms = now_ms - window_ms
    start_cst = datetime.fromtimestamp(start_ms / 1000.0, TZ)

    assumptions = audit_assumptions()
    t1_usd, t2_usd = mcap_thresholds_usd()

    all_items = list_alert_stats()
    funnel = {
        "allLoaded": len(all_items),
    }
    rows_7d = filter_alert_stats(all_items, time_filter="7d", now_ms=now_ms)
    funnel["afterTime7d"] = len(rows_7d)
    rows_7d_15m = filter_alert_stats(rows_7d, interval="15m", now_ms=now_ms)
    funnel["afterInterval15m"] = len(rows_7d_15m)

    # Same peer pool as list_alert_stats_page: no time/interval/type/session filter
    peer_pool = filter_alert_stats(
        all_items,
        time_filter=None,
        session_filter=None,
        daytype_filter=None,
        type_label=None,
        interval=None,
    )
    funnel["mtfPeerPoolSize"] = len(peer_pool)

    # MTF only (before confluence)
    mtf_only = _apply_tier_filters(
        list(rows_7d_15m),
        confluence_min_tier="all",
        mtf_resonance_only=True,
        mcap_tier_filter="all",
        mtf_peer_rows=peer_pool,
        confluence_exact=False,
    )
    funnel["afterMtfResonanceOnly"] = len(mtf_only)

    exact_a = _apply_tier_filters(
        list(rows_7d_15m),
        confluence_min_tier="A",
        mtf_resonance_only=True,
        mcap_tier_filter="all",
        mtf_peer_rows=peer_pool,
        confluence_exact=True,
    )
    exact_b = _apply_tier_filters(
        list(rows_7d_15m),
        confluence_min_tier="B",
        mtf_resonance_only=True,
        mcap_tier_filter="all",
        mtf_peer_rows=peer_pool,
        confluence_exact=True,
    )
    min_b = _apply_tier_filters(
        list(rows_7d_15m),
        confluence_min_tier="B",
        mtf_resonance_only=True,
        mcap_tier_filter="all",
        mtf_peer_rows=peer_pool,
        confluence_exact=False,
    )
    keys_a = {str(r.get("key")) for r in exact_a}
    keys_b = {str(r.get("key")) for r in exact_b}
    keys_minb = {str(r.get("key")) for r in min_b}
    keys_union = keys_a | keys_b
    funnel["exactA"] = len(exact_a)
    funnel["exactB"] = len(exact_b)
    funnel["unionExactAB"] = len(keys_union)
    funnel["minTierB"] = len(min_b)
    funnel["unionEqualsMinB"] = keys_union == keys_minb

    # Official filter for this task: union of exact A and exact B (== min B if equal)
    by_key_row = {str(r.get("key")): r for r in min_b}
    # Prefer union composition to match "评分为 A,B"
    filtered = [by_key_row[k] for k in keys_union if k in by_key_row]
    # If somehow missing, fall back to min_b
    if len(filtered) != len(keys_union):
        filtered = list(min_b)
    filtered.sort(key=lambda r: int(r.get("signalAt") or 0), reverse=True)
    funnel["finalFiltered"] = len(filtered)

    # Attach already done inside _apply_tier_filters; refresh mcap snapshot
    attach_mcap_tier(filtered)

    mtf_map = compute_mtf_resonance_by_key(peer_pool)

    # Confluence distribution on mtf_only
    conf_dist = Counter(conf_tier(r) for r in mtf_only)

    rows_out: list[dict[str, Any]] = []
    asset_counts = Counter()
    tier_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    cap_missing = 0
    cap_excluded = 0
    future_n = 0
    causal_drop_n = 0
    settle_ver = Counter()
    fee_vals = Counter()
    settle_profiles = Counter()

    for r in filtered:
        sym = str(r.get("tradeSymbol") or r.get("symbol") or "")
        ac = str(r.get("assetClass") or "crypto").lower()
        eq = classify_equity(sym)
        tid = str(r.get("mcapTier") or resolve_mcap_tier(sym) or "t3")
        cap = r.get("marketCapUsd")
        cap_source = "none"
        if eq:
            kind, base = eq
            if kind == "stock":
                cap = company_market_cap_usd(base, refresh=False) if cap is None else cap
                cap_source = "company_market_cap" if cap is not None else "equity_stock_no_cap"
            else:
                cap_source = "equity_basket"
        else:
            if cap is None:
                cap = market_cap_usd_sync(sym, refresh=False)
            cap_source = "coingecko_current" if cap is not None else "missing_to_t3"
            if cap is None:
                cap_missing += 1
        if tid == "t3" and cap_source == "missing_to_t3":
            pass
        fut = future_peer_info(r, mtf_map, peer_pool)
        if fut["hasFuturePeer"]:
            future_n += 1
        if has_mtf_resonance(r) and not fut["causalStillResonates"]:
            causal_drop_n += 1
        lev = leverage_for_symbol(sym, ac)
        oc = outcome_of(r)
        fee = r.get("feePctPerSide")
        fee_vals[str(fee)] += 1
        sv = f"rules={r.get('settleRulesVersion')}|walk={r.get('settleVersion')}"
        settle_ver[sv] += 1
        if r.get("settleProfileId"):
            settle_profiles[str(r.get("settleProfileId"))] += 1
        mtf = r.get("mtfResonance") if isinstance(r.get("mtfResonance"), dict) else {}
        asset_counts[ac] += 1
        tier_groups[tid].append(r)
        rows_out.append(
            {
                "key": r.get("key"),
                "symbol": r.get("symbol"),
                "tradeSymbol": r.get("tradeSymbol") or r.get("symbol"),
                "assetClass": ac,
                "equityKind": eq[0] if eq else "",
                "side": r.get("side"),
                "dir": r.get("dir"),
                "typeLabel": r.get("typeLabel"),
                "interval": r.get("interval"),
                "signalAtMs": r.get("signalAt"),
                "signalAtCst": ms_to_cst(int(r.get("signalAt") or 0)),
                "entry": r.get("entry"),
                "outcome": oc,
                "pnlPct": _rec_pnl_pct(r),
                "movePct": r.get("movePct"),
                "exitPrice": r.get("exitPrice"),
                "exitReason": r.get("exitReason") or r.get("reason"),
                "confluenceTier": conf_tier(r),
                "confluenceScore": conf_score(r),
                "mtfTiers": (mtf or {}).get("tiers"),
                "mtfIntervals": "+".join((mtf or {}).get("intervals") or []),
                "mtfFamily": (mtf or {}).get("family"),
                "mtfFamilyLabel": (mtf or {}).get("familyLabel"),
                "mcapTier": tid,
                "mcapTierLabel": mcap_tier_label(tid),
                "marketCapUsd": cap,
                "marketCapSource": cap_source,
                "leverage": lev,
                "settleRulesVersion": r.get("settleRulesVersion"),
                "settleVersion": r.get("settleVersion"),
                "settleProfileId": r.get("settleProfileId"),
                "feePctPerSide": fee,
                "slippagePctPerSide": r.get("slippagePctPerSide"),
                "observation": bool(is_observation_record(r) or is_headline_win_rate_excluded(r)),
                "hasFutureMtfPeer": fut["hasFuturePeer"],
                "futureMtfPeerCount": fut["futurePeerCount"],
                "causalStillResonates": fut["causalStillResonates"],
                "source": r.get("source"),
            }
        )

    # Summaries
    overall = bucket_counts(filtered)
    crypto_rows = [r for r in filtered if str(r.get("mcapTier") or "").startswith("t") and not str(r.get("mcapTier") or "").startswith("eq")]
    # Safer: crypto if mcapTier in t1/t2/t3 and assetClass != equity
    crypto_rows = [
        r
        for r in filtered
        if str(r.get("mcapTier") or "") in CRYPTO_TIERS
        and str(r.get("assetClass") or "crypto").lower() != "equity"
    ]
    equity_rows = [
        r
        for r in filtered
        if str(r.get("assetClass") or "").lower() == "equity"
        or str(r.get("mcapTier") or "").startswith("eq")
    ]
    # If a row is both, prefer classify_equity
    crypto_rows, equity_rows = [], []
    unknown_rows = []
    for r in filtered:
        sym = str(r.get("tradeSymbol") or r.get("symbol") or "")
        tid = str(r.get("mcapTier") or "")
        eq = classify_equity(sym)
        if eq or tid.startswith("eq") or str(r.get("assetClass") or "").lower() == "equity":
            equity_rows.append(r)
        elif tid in CRYPTO_TIERS or str(r.get("assetClass") or "crypto").lower() == "crypto":
            crypto_rows.append(r)
        else:
            unknown_rows.append(r)

    crypto_by_tier = {}
    for tid in CRYPTO_TIERS:
        grp = [r for r in crypto_rows if str(r.get("mcapTier") or "") == tid]
        crypto_by_tier[tid] = {
            "tier": tid,
            "label": mcap_tier_label(tid),
            **bucket_counts(grp),
        }

    equity_by_tier = {}
    for tid in EQ_STOCK_TIERS + EQ_BASKETS:
        grp = [r for r in equity_rows if str(r.get("mcapTier") or "") == tid]
        if grp or tid in EQ_STOCK_TIERS:
            equity_by_tier[tid] = {
                "tier": tid,
                "label": mcap_tier_label(tid),
                **bucket_counts(grp),
            }

    # Causal-only subset (do not use as the official list filter result)
    causal_keep = []
    for rec, row in zip(filtered, rows_out):
        if row.get("causalStillResonates"):
            causal_keep.append(rec)

    list_summary = summarize(filtered)

    params = {
        "task": "形态信号列表 最近七天 / 仅多周期共振 / 15分钟 / 综合评分 A,B / 三梯队胜率",
        "computedAtCst": cutoff_cst.strftime("%Y-%m-%d %H:%M:%S"),
        "timezone": "Asia/Shanghai (UTC+8)",
        "cutoffMs": now_ms,
        "cutoffCst": cutoff_cst.strftime("%Y-%m-%d %H:%M:%S"),
        "window": "7d",
        "windowMs": window_ms,
        "windowStartMs": start_ms,
        "windowStartCst": start_cst.strftime("%Y-%m-%d %H:%M:%S"),
        "windowEndCst": cutoff_cst.strftime("%Y-%m-%d %H:%M:%S"),
        "filters": {
            "source": "形态信号列表 /api/pattern-alert-stats 与 list_alert_stats_page 同口径",
            "time_filter": "7d",
            "interval": "15m",
            "mtfResonanceOnly": True,
            "confluence": "union of exact A and exact B (equivalent to min_tier=B, confluenceExact=0)",
            "confluenceNote": "列表 UI 综合评分默认精确单档（confluenceExact=1）；本次按用户要求取 A 与 B 的并集，不是 C/D。评分字段为 confluence.tier（V2 百分位：A≥80，B≥60，其余 C）。",
            "mcapTierFilter": "all（筛选不按梯队切，事后用当前市值分桶）",
            "decisionGroup": "all（未使用 agentDecision 分组）",
        },
        "mtfResonanceDefinition": {
            "intervals": ["15m", "1h", "4h"],
            "window": "±4 hours (MTF_RESONANCE_WINDOW_MS=14400000)",
            "rule": "同币、同向、同形态族，时间窗内覆盖 ≥2 个周期",
            "peerPool": "不按时间/周期/形态收窄的全库（与 list_alert_stats_page 一致）；仍会按 asset/symbol 若调用方传入，本次未限制 symbol/assetClass",
            "futureInformation": True,
            "futureInformationNote": "窗为信号时刻前后各 4 小时，会用到信号之后才出现的同行周期，因此列表「仅多周期共振」统计 ≠ 可交易的因果回测。本次未改用户所指的列表筛选。",
        },
        "settlement": {
            "source": "形态信号列表已落盘 outcome（pattern_alert_stats），本次未重跑 K 线、未写入生产库",
            "rulesSummary": settle_rules_summary(),
            "verifyWindow15mHours": 6.0,
            "leverage": "BTC/ETH/SOL 100x，其他加密 20x；与市值梯队独立",
            "winRateDefinition": "列表 summarize：观察档默认排除；flat/error 不进头条分母；winRate = take_profit / (take_profit + stop_loss)；pending 不计分母；缺失不当中性",
            "feesInStoredListSettlements": "live/recalculate-v2 调用 settle_signal_batch 时未传入 fee/slippage，默认 0.0。文档/结构回测默认 OI_BT_FEE_PCT=0.06%/边、OI_BT_SLIPPAGE_PCT=0.03%/边，与列表落盘不一致。本次胜率按列表落盘 outcome，不暗改费用。",
            "auditAssumptions": {
                "leverageMajor": assumptions.get("leverageMajor"),
                "leverageAlt": assumptions.get("leverageAlt"),
                "leverageMajorAssets": assumptions.get("leverageMajorAssets"),
                "feePctPerSideDefaultDocumented": assumptions.get("feePctPerSideDefault"),
                "slippagePctPerSideDefaultDocumented": assumptions.get("slippagePctPerSideDefault"),
            },
        },
        "mcapTiers": {
            "cryptoThresholdsUsd": {"t1_gt": t1_usd, "t2_gt": t2_usd},
            "cryptoRule": "当前 CoinGecko 美元流通市值严格大于 500 亿为 t1，大于 80 亿为 t2，其余 t3；稳定币/Figure Heloc 等排除项与缺失市值记 t3",
            "lookAhead": "用当前市值划分历史样本，存在轻微前视/事后偏差",
            "equity": "美股公司市值三档与加密分开，不可合并；QQQ/SPY/IWM 指数、SOXL 杠杆、XAU/TLT/PAXG 宏观集合单列无三档；MSTR/COIN/HOOD/MARA/CRCL/SMCI 为 eq-other",
        },
        "funnel": funnel,
        "mtfOnlyConfluenceDistribution": dict(conf_dist),
        "futureMtf": {
            "signalsWithFuturePeer": future_n,
            "signalsThatWouldDropIfCausalOnly": causal_drop_n,
            "causalOnlyCount": len(causal_keep),
        },
        "settleVersions": dict(settle_ver),
        "storedFeePctPerSideValues": dict(fee_vals),
        "settleProfiles": dict(settle_profiles),
        "elapsedSec": None,
    }

    result = {
        "params": params,
        "overall": overall,
        "listSummarize": list_summary,
        "assetClassCounts": dict(asset_counts),
        "crypto": {
            "total": len(crypto_rows),
            "summary": bucket_counts(crypto_rows),
            "byTier": crypto_by_tier,
        },
        "equity": {
            "total": len(equity_rows),
            "present": len(equity_rows) > 0,
            "summary": bucket_counts(equity_rows) if equity_rows else None,
            "byTier": equity_by_tier if equity_rows else {},
            "note": None if equity_rows else "本次筛选样本中无美股，不编造数据",
        },
        "unknownAsset": {"total": len(unknown_rows)},
        "causalOnlySubsetNotOfficial": {
            "note": "若只允许信号当时及之前的 peer，部分列表共振样本会落选；此子集仅对照，不是用户要求的列表筛选结果",
            "count": len(causal_keep),
            "summary": bucket_counts(causal_keep),
            "cryptoByTier": {
                tid: bucket_counts([r for r in causal_keep if str(r.get("mcapTier") or "") == tid])
                for tid in CRYPTO_TIERS
            },
        },
    }
    params["elapsedSec"] = round(time.time() - started, 3)

    csv_path = OUT / "signals.csv"
    fieldnames = list(rows_out[0].keys()) if rows_out else [
        "key", "symbol", "outcome", "mcapTier", "confluenceTier"
    ]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for row in rows_out:
            w.writerow(row)

    # compact trades csv (settled only for convenience, plus all in signals.csv)
    trades_path = OUT / "trades_settled.csv"
    settled_rows = [row for row in rows_out if row["outcome"] in ("take_profit", "stop_loss", "flat")]
    with trades_path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for row in settled_rows:
            w.writerow(row)

    params_path = OUT / "params.json"
    results_path = OUT / "results.json"
    params_path.write_text(json.dumps(params, ensure_ascii=False, indent=2), encoding="utf-8")
    results_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    # human summary
    def fmt_wr(b):
        wr = b.get("winRate")
        wrp = b.get("winRatePct")
        return "n/a" if wr is None else f"{wrp:.2f}% ({b['headlineWins']}/{b['settledForWinRate']})"

    lines = []
    lines.append(f"cutoff: {params['cutoffCst']} Asia/Shanghai")
    lines.append(f"window: {params['windowStartCst']} -> {params['windowEndCst']} Asia/Shanghai")
    lines.append(f"funnel: {json.dumps(funnel, ensure_ascii=False)}")
    lines.append(f"overall: total={overall['total']} settled={overall['settledForWinRate']} W/L/F={overall['wins']}/{overall['losses']}/{overall['flats']} pending={overall['pending']} errors={overall['errors']} obs={overall['observation']} wr={fmt_wr(overall)}")
    lines.append("crypto tiers:")
    for tid in CRYPTO_TIERS:
        b = crypto_by_tier[tid]
        lines.append(
            f"  {tid} {b['label']}: total={b['total']} settled={b['settledForWinRate']} W/L/F={b['wins']}/{b['losses']}/{b['flats']} pending={b['pending']} errors={b['errors']} obs={b['observation']} wr={fmt_wr(b)} pnl={b['headlineTotalPnlPct']}"
        )
    if not equity_rows:
        lines.append("equity: none in filtered sample")
    else:
        lines.append(f"equity total={len(equity_rows)}")
        for tid, b in equity_by_tier.items():
            lines.append(
                f"  {tid} {b['label']}: total={b['total']} settled={b['settledForWinRate']} wr={fmt_wr(b)}"
            )
    lines.append(f"future peers: {future_n}; would drop if causal-only: {causal_drop_n}")
    lines.append(f"files: {csv_path}, {trades_path}, {params_path}, {results_path}")
    summary_path = OUT / "summary.txt"
    text = "\n".join(lines) + "\n"
    summary_path.write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
