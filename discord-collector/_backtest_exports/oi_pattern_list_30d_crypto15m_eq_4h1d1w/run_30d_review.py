#!/usr/bin/env python3
"""30-day existing-settlement review: crypto 15m + equity 4h/1d/1w.

Read-only. Does not change production, resonance, or settlement, and does not rerun klines.
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

from oi_mornitor.equity_mcap import (  # noqa: E402
    classify_equity,
    company_market_cap_usd,
)
from oi_mornitor.mcap_market_quote import (  # noqa: E402
    ensure_market_cap_map,
    market_cap_usd_sync,
)
from oi_mornitor.mcap_tier import (  # noqa: E402
    mcap_tier_label,
    mcap_thresholds_usd,
    tier_from_market_cap_usd,
)
from oi_mornitor.pattern_alert_stats import (  # noqa: E402
    _apply_tier_filters,
    _rec_pnl_pct,
    filter_alert_stats,
    is_headline_win_rate_excluded,
    list_alert_stats,
)
from oi_mornitor.pattern_mtf_resonance import (  # noqa: E402
    MTF_RESONANCE_INTERVALS,
    MTF_RESONANCE_WINDOW_MS,
    _side_key,
    _symbol_key,
    compute_mtf_resonance_by_key,
    has_mtf_resonance,
    mtf_resonance_family,
)
from oi_mornitor.pattern_settle import settle_rules_summary  # noqa: E402
from oi_mornitor.pattern_settle_profile import is_observation_record  # noqa: E402
from oi_mornitor.trade_leverage import audit_assumptions, leverage_for_symbol  # noqa: E402

TZ = timezone(timedelta(hours=8))
OUT = Path("/tmp/oi_pattern_list_30d_20261113")
EXPORT = ROOT / "_backtest_exports" / "oi_pattern_list_30d_crypto15m_eq_4h1d1w"
WINDOW_MS = 30 * 24 * 60 * 60 * 1000
MAJOR_TECH = frozenset({
    "AAPL", "NVDA", "MSFT", "GOOG", "GOOGL", "AMZN", "TSM", "AVGO", "META", "TSLA", "PLTR", "ORCL"
})
STABLE_OR_HELOC = frozenset({
    "USDT", "USDC", "USDS", "USDE", "DAI", "USD1", "PYUSD", "USDG", "RLUSD", "USDD",
    "BFUSD", "USDY", "USYC", "USDF", "OUSD", "GHO", "EURC", "USD0", "USDGO", "EURSAFO",
    "USTB", "BUIDL", "USD", "FIGR", "FIGR_HELOC",
})
# Confirmed crypto even if local CoinGecko cache misses the key.
CONFIRMED_CRYPTO_NO_CACHE = frozenset({"KGEN", "OPG"})
# Report-layer overrides applied before CoinGecko-as-crypto.
CATALOG: dict[str, dict[str, str]] = {
    # US major tech handled via classify_equity + company cap
    "MU": {"cls": "us_stock_other", "underlying": "Micron Technology (NASDAQ: MU)", "evidence": "美国上市公司，不在批准主要科技股名单，列美股其他，不进三档"},
    "SKHY": {"cls": "us_stock_other", "underlying": "SK hynix ADR (NASDAQ: SKHY)", "evidence": "韩国公司纳斯达克 ADR，不在批准主要科技股名单，列美股其他"},
    "NBIS": {"cls": "us_stock_other", "underlying": "Nebius Group (NASDAQ: NBIS)", "evidence": "Binance TradFi 永续公告确认跟踪纳斯达克 NBIS，不在批准主要科技股名单，列美股其他"},
    "SKHYNIX": {"cls": "non_us_equity", "underlying": "SK hynix 韩国交易所本股 (KRX: 000660)", "evidence": "跟踪韩国 KRX 本股，不进美股三档/美股其他，也不进加密"},
    "TQQQ": {"cls": "us_lev", "underlying": "ProShares UltraPro QQQ (NASDAQ: TQQQ)", "evidence": "纳斯达克100三倍做多 ETF，杠杆集合"},
    "SNXX": {"cls": "us_lev", "underlying": "Tradr 2X Long SNDK Daily ETF (SNXX)", "evidence": "2倍做多 SanDisk 的美股杠杆 ETF，杠杆集合"},
    "KORU": {"cls": "us_lev", "underlying": "Direxion Daily MSCI South Korea Bull 3X (NYSEARCA: KORU)", "evidence": "美股上市的韩国 3 倍做多 ETF，杠杆集合，不进加密"},
    "XAG": {"cls": "macro", "underlying": "白银 (XAG)", "evidence": "贵金属商品合约，宏观集合"},
    "CL": {"cls": "macro", "underlying": "WTI 原油 (CL)", "evidence": "能源商品合约，宏观集合"},
    "BZ": {"cls": "macro", "underlying": "布伦特原油 (BZ)", "evidence": "Binance 商品永续公告确认跟踪 Brent Crude，宏观集合"},
    "XAUT": {"cls": "macro", "underlying": "Tether Gold (XAUT)", "evidence": "黄金代币，与 XAU/PAXG 同类宏观，不进加密三档"},
}

BUCKET_LABEL = {
    "t1": "加密第一梯队",
    "t2": "加密第二梯队",
    "t3": "加密第三梯队",
    "eq-t1": "美股个股·第一梯队",
    "eq-t2": "美股个股·第二梯队",
    "eq-t3": "美股个股·第三梯队",
    "eq-other": "美股其他",
    "eq-index": "美股集合·指数",
    "eq-lev": "美股集合·杠杆",
    "eq-macro": "美股集合·宏观",
    "non_us_equity": "非美股权益",
    "unknown": "未知待核验",
    "excluded": "排除（稳定币/Figure Heloc）",
}
CLS_LABEL = {
    "crypto": "加密",
    "us_stock_major": "美股个股（批准主要科技股）",
    "us_stock_other": "美股其他",
    "us_index": "美股集合·指数",
    "us_lev": "美股集合·杠杆",
    "macro": "美股集合·宏观",
    "non_us_equity": "非美股权益",
    "unknown": "未知待核验",
    "excluded_stable_or_heloc": "排除（稳定币/Figure Heloc）",
}


def cst(ms: int) -> str:
    if not ms:
        return ""
    return datetime.fromtimestamp(ms / 1000.0, TZ).strftime("%Y-%m-%d %H:%M:%S")


def base_of(symbol: str) -> str:
    s = str(symbol or "").strip().upper()
    if s.endswith("USDT"):
        s = s[: -len("USDT")]
    return s


def outcome_of(rec: dict[str, Any]) -> str:
    return str(rec.get("outcome") or "pending").strip().lower() or "pending"


def is_obs(rec: dict[str, Any]) -> bool:
    return bool(is_observation_record(rec) or is_headline_win_rate_excluded(rec))


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


def bucket_counts(rows: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(rows)
    obs = pending = wins = losses = flats = errors = other = 0
    raw_pnl = 0.0
    raw_n = 0
    h_wins = h_losses = h_pending = 0
    h_pnl = 0.0
    h_n = 0
    for r in rows:
        if is_obs(r):
            obs += 1
        oc = outcome_of(r)
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
        pnl = _rec_pnl_pct(r)
        if pnl is not None:
            raw_pnl += pnl
            raw_n += 1
        if is_obs(r) or oc in ("flat", "error"):
            continue
        if oc == "pending":
            h_pending += 1
        elif oc == "take_profit":
            h_wins += 1
        elif oc == "stop_loss":
            h_losses += 1
        if pnl is not None and oc in ("take_profit", "stop_loss"):
            h_pnl += pnl
            h_n += 1
    settled = h_wins + h_losses
    return {
        "total": total,
        "observation": obs,
        "pending": pending,
        "wins": wins,
        "losses": losses,
        "flats": flats,
        "errors": errors,
        "otherOutcome": other,
        "settledForWinRate": settled,
        "headlineWins": h_wins,
        "headlineLosses": h_losses,
        "headlinePending": h_pending,
        "winRate": (h_wins / settled) if settled else None,
        "winRatePct": round(100.0 * h_wins / settled, 2) if settled else None,
        "winRateDefinition": "wins / (wins + losses)；仅 take_profit/stop_loss；观察档、pending、flat、error、缺失不进分母；缺失不当中性",
        "headlineTotalPnlPct": round(h_pnl, 2) if h_n else None,
        "rawTotalPnlPct": round(raw_pnl, 2) if raw_n else None,
        "symbols": dict(Counter(str(r.get("tradeSymbol") or r.get("symbol") or "") for r in rows)),
    }


def wr_text(b: dict[str, Any]) -> str:
    if b.get("winRate") is None:
        return "n/a（无已结算胜负，不记 0%）" if b.get("total", 0) else "n/a（无样本，不记 0%）"
    return f"{b['winRatePct']:.2f}%（{b['headlineWins']}/{b['settledForWinRate']}）"


def future_peer_info(rec: dict[str, Any], peer_pool: list[dict[str, Any]]) -> dict[str, Any]:
    sat = int(rec.get("signalAt") or 0)
    if sat <= 0:
        return {"hasFuturePeer": False, "futurePeerCount": 0, "causalStillResonates": False}
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
        self_iv = str(rec.get("interval") or "").strip()
        if self_iv in MTF_RESONANCE_INTERVALS:
            ivs_all.add(self_iv)
            ivs_causal.add(self_iv)
    return {
        "hasFuturePeer": future_n > 0,
        "futurePeerCount": future_n,
        "causalStillResonates": len(ivs_causal) >= 2,
    }


def mapped_cg_cap(symbol: str) -> tuple[float | None, str]:
    cap = market_cap_usd_sync(symbol, refresh=False)
    if cap is not None:
        return float(cap), "coingecko_current"
    base = base_of(symbol)
    if base.startswith("1000") and len(base) > 4:
        cap2 = market_cap_usd_sync(base[4:] + "USDT", refresh=False)
        if cap2 is not None:
            return float(cap2), "coingecko_mapped_1000_prefix"
    return None, "missing"


def classify_report(symbol: str) -> dict[str, Any]:
    sym = str(symbol or "").strip().upper()
    base = base_of(sym)
    if base in STABLE_OR_HELOC:
        return {
            "reportAssetClass": "excluded_stable_or_heloc",
            "reportBucket": "excluded",
            "reportUnderlying": base,
            "reportEvidence": "稳定币或 FIGR_HELOC，排除而非记入 t3",
            "reportCapUsd": None,
            "reportCapNote": "",
        }
    if base in CATALOG:
        meta = CATALOG[base]
        bucket = {
            "us_stock_other": "eq-other",
            "non_us_equity": "non_us_equity",
            "us_lev": "eq-lev",
            "macro": "eq-macro",
            "us_index": "eq-index",
        }[meta["cls"]]
        return {
            "reportAssetClass": meta["cls"],
            "reportBucket": bucket,
            "reportUnderlying": meta["underlying"],
            "reportEvidence": meta["evidence"],
            "reportCapUsd": None,
            "reportCapNote": "",
        }
    eq = classify_equity(sym)
    if eq:
        kind, eq_base = eq
        if kind == "index":
            return {"reportAssetClass": "us_index", "reportBucket": "eq-index", "reportUnderlying": eq_base, "reportEvidence": "批准指数集合，不套市值三档", "reportCapUsd": None, "reportCapNote": ""}
        if kind == "leveraged":
            return {"reportAssetClass": "us_lev", "reportBucket": "eq-lev", "reportUnderlying": eq_base, "reportEvidence": "批准杠杆集合，不套市值三档", "reportCapUsd": None, "reportCapNote": ""}
        if kind == "macro":
            return {"reportAssetClass": "macro", "reportBucket": "eq-macro", "reportUnderlying": eq_base, "reportEvidence": "批准宏观集合，不套市值三档", "reportCapUsd": None, "reportCapNote": ""}
        if kind == "stock":
            cap = company_market_cap_usd(eq_base, refresh=False)
            t1, t2 = mcap_thresholds_usd()
            if cap is None:
                bucket = "eq-t3"
                note = "批准主要科技股但公司市值缺失，按门槛规则记 eq-t3"
            else:
                raw = tier_from_market_cap_usd(cap)
                bucket = {"t1": "eq-t1", "t2": "eq-t2", "t3": "eq-t3"}[raw]
                note = f"批准主要科技股，公司市值 {cap:.0f} 美元，门槛 >{t1:.0f} / >{t2:.0f}"
            return {
                "reportAssetClass": "us_stock_major",
                "reportBucket": bucket,
                "reportUnderlying": f"{eq_base}（批准主要科技股）",
                "reportEvidence": note,
                "reportCapUsd": cap,
                "reportCapNote": "公司市值，同日种子/磁盘缓存（实时刷新失败则沿用）",
            }
        # other
        return {
            "reportAssetClass": "us_stock_other",
            "reportBucket": "eq-other",
            "reportUnderlying": eq_base,
            "reportEvidence": "白名单内但非批准主要科技股，列美股其他，不进三档",
            "reportCapUsd": None,
            "reportCapNote": "",
        }
    cap, cap_src = mapped_cg_cap(sym)
    if cap is not None:
        tid = tier_from_market_cap_usd(cap)
        return {
            "reportAssetClass": "crypto",
            "reportBucket": tid,
            "reportUnderlying": base,
            "reportEvidence": f"CoinGecko 流通市值 {cap:.0f} 美元（{cap_src}）",
            "reportCapUsd": cap,
            "reportCapNote": cap_src,
        }
    if base in CONFIRMED_CRYPTO_NO_CACHE:
        return {
            "reportAssetClass": "crypto",
            "reportBucket": "t3",
            "reportUnderlying": base,
            "reportEvidence": "已确认为加密代币，但本地 CoinGecko 缓存缺失，按规则记 t3",
            "reportCapUsd": None,
            "reportCapNote": "missing_to_t3_confirmed_crypto",
        }
    return {
        "reportAssetClass": "unknown",
        "reportBucket": "unknown",
        "reportUnderlying": base,
        "reportEvidence": "未能确认是加密还是股票/ETF/商品，单列，不进加密胜率",
        "reportCapUsd": None,
        "reportCapNote": "unidentified",
    }


def apply_filter(rows: list[dict[str, Any]], *, interval: str | None, peer, mtf: bool, min_tier: str = "B", exact: bool = False) -> list[dict[str, Any]]:
    scoped = filter_alert_stats(rows, interval=interval) if interval else list(rows)
    return _apply_tier_filters(
        list(scoped),
        confluence_min_tier=min_tier,
        mtf_resonance_only=mtf,
        mcap_tier_filter="all",
        mtf_peer_rows=peer,
        confluence_exact=exact,
    )


def attach_report(rows: list[dict[str, Any]], *, sample_set: str, official: bool, peer) -> list[dict[str, Any]]:
    out = []
    for r in rows:
        rec = dict(r)
        sym = str(rec.get("tradeSymbol") or rec.get("symbol") or "")
        meta = classify_report(sym)
        fut = future_peer_info(rec, peer)
        ac = str(rec.get("assetClass") or "")
        lev = leverage_for_symbol(sym, ac or "crypto")
        mtf = rec.get("mtfResonance") if isinstance(rec.get("mtfResonance"), dict) else {}
        prod_tier = str(rec.get("mcapTier") or "")
        report_bucket = meta["reportBucket"]
        rec_out = {
            "sampleSet": sample_set,
            "inOfficialFilter": "true" if official else "false",
            "key": rec.get("key"),
            "symbol": rec.get("symbol"),
            "tradeSymbol": rec.get("tradeSymbol") or rec.get("symbol"),
            "interval": rec.get("interval"),
            "assetClass": rec.get("assetClass"),
            "mcapTier": rec.get("mcapTier"),
            "mcapTierLabel": rec.get("mcapTierLabel") or (mcap_tier_label(prod_tier) if prod_tier else ""),
            "marketCapUsd": rec.get("marketCapUsd"),
            "marketCapSource": rec.get("marketCapSource"),
            "side": rec.get("side"),
            "dir": rec.get("dir"),
            "typeLabel": rec.get("typeLabel"),
            "signalAtMs": rec.get("signalAt"),
            "signalAtCst": cst(int(rec.get("signalAt") or 0)),
            "entry": rec.get("entry"),
            "outcome": outcome_of(rec),
            "pnlPct": _rec_pnl_pct(rec),
            "movePct": rec.get("movePct"),
            "exitPrice": rec.get("exitPrice"),
            "exitReason": rec.get("exitReason") or rec.get("reason"),
            "confluenceTier": conf_tier(rec),
            "confluenceScore": conf_score(rec),
            "mtfTiers": (mtf or {}).get("tiers"),
            "mtfIntervals": "+".join((mtf or {}).get("intervals") or []),
            "mtfFamily": (mtf or {}).get("family"),
            "mtfFamilyLabel": (mtf or {}).get("familyLabel"),
            "hasMtfResonance": has_mtf_resonance(rec),
            "observation": is_obs(rec),
            "leverage": lev,
            "settleRulesVersion": rec.get("settleRulesVersion"),
            "settleVersion": rec.get("settleVersion"),
            "settleProfileId": rec.get("settleProfileId"),
            "feePctPerSide": rec.get("feePctPerSide"),
            "slippagePctPerSide": rec.get("slippagePctPerSide"),
            "hasFutureMtfPeer": fut["hasFuturePeer"],
            "futureMtfPeerCount": fut["futurePeerCount"],
            "causalStillResonates": fut["causalStillResonates"],
            "source": rec.get("source"),
            "reportAssetClass": meta["reportAssetClass"],
            "reportAssetClassLabel": CLS_LABEL.get(meta["reportAssetClass"], meta["reportAssetClass"]),
            "reportBucket": report_bucket,
            "reportBucketLabel": BUCKET_LABEL.get(report_bucket, report_bucket),
            "reportUnderlying": meta.get("reportUnderlying") or "",
            "reportEvidence": meta.get("reportEvidence") or "",
            "reportCapUsd": meta.get("reportCapUsd") if meta.get("reportCapUsd") is not None else (rec.get("marketCapUsd") or ""),
            "reportCapNote": meta.get("reportCapNote") or "",
            "reportIncludedInCryptoWinRate": meta["reportAssetClass"] == "crypto" and official and str(rec.get("interval")) == "15m",
        }
        out.append(rec_out)
    return out


def is_crypto_row(row: dict[str, Any]) -> bool:
    return row.get("reportAssetClass") == "crypto"


def is_non_crypto_row(row: dict[str, Any]) -> bool:
    return row.get("reportAssetClass") not in {"crypto", "excluded_stable_or_heloc"}


def line_row(label: str, b: dict[str, Any]) -> str:
    return (
        f"| {label} | {b['total']} | {b['settledForWinRate']} | {b['wins']} | {b['losses']} | "
        f"{b['flats']} | {b['pending']} | {b['errors']} | {b['observation']} | {wr_text(b)} |"
    )


HDR = "| 分类 | 总样本 | 已结算 | 胜 | 负 | 平 | 未结算 | 异常 | 观察档 | 胜率 |"
SEP = "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    EXPORT.mkdir(parents=True, exist_ok=True)
    started = time.time()
    now_ms = int(time.time() * 1000)
    start_ms = now_ms - WINDOW_MS
    ensure_market_cap_map()
    t1_usd, t2_usd = mcap_thresholds_usd()
    assumptions = audit_assumptions()

    all_items = list_alert_stats()
    # 30d slice then retired filter
    raw30 = [r for r in all_items if start_ms <= int(r.get("signalAt") or 0) <= now_ms]
    rows30 = filter_alert_stats(raw30, time_filter=None, now_ms=now_ms)
    peer = filter_alert_stats(all_items, time_filter=None)
    # interval coverage
    iv_all = Counter(str(r.get("interval") or "") for r in all_items)
    iv_30 = Counter(str(r.get("interval") or "") for r in rows30)
    coverage = {}
    for iv in sorted(set(iv_all) | set(iv_30), key=lambda x: (-iv_30.get(x, 0), x)):
        vals = [int(r.get("signalAt") or 0) for r in all_items if str(r.get("interval") or "") == iv and int(r.get("signalAt") or 0) > 0]
        vals30 = [int(r.get("signalAt") or 0) for r in rows30 if str(r.get("interval") or "") == iv and int(r.get("signalAt") or 0) > 0]
        coverage[iv] = {
            "allTime": len(vals),
            "inWindow": len(vals30),
            "allTimeRangeCst": [cst(min(vals)), cst(max(vals))] if vals else None,
            "windowRangeCst": [cst(min(vals30)), cst(max(vals30))] if vals30 else None,
        }

    rows15 = filter_alert_stats(rows30, interval="15m")
    rows1h = filter_alert_stats(rows30, interval="1h")
    rows4h = filter_alert_stats(rows30, interval="4h")
    rows1d = filter_alert_stats(rows30, interval="1d")
    rows1w = filter_alert_stats(rows30, interval="1w")

    off15 = apply_filter(rows15, interval=None, peer=peer, mtf=True, min_tier="B", exact=False)
    off1h = apply_filter(rows1h, interval=None, peer=peer, mtf=True, min_tier="B", exact=False)
    off4h = apply_filter(rows4h, interval=None, peer=peer, mtf=True, min_tier="B", exact=False)
    off1d = apply_filter(rows1d, interval=None, peer=peer, mtf=True, min_tier="B", exact=False)
    off1w = apply_filter(rows1w, interval=None, peer=peer, mtf=True, min_tier="B", exact=False)
    # score-only reference for 1d/1w, not official
    ref1d_ab = apply_filter(rows1d, interval=None, peer=peer, mtf=False, min_tier="B", exact=False)
    ref1w_ab = apply_filter(rows1w, interval=None, peer=peer, mtf=False, min_tier="B", exact=False)

    official_15 = attach_report(off15, sample_set="official_mtf_ab_15m", official=True, peer=peer)
    official_4h = attach_report(off4h, sample_set="official_mtf_ab_4h", official=True, peer=peer)
    official_1h = attach_report(off1h, sample_set="excluded_1h_mtf_ab", official=False, peer=peer)
    raw_1d = attach_report(rows1d if not off1d else apply_filter(rows1d, interval=None, peer=peer, mtf=False, min_tier="all", exact=False), sample_set="raw_1d_mtf_unsupported", official=False, peer=peer)
    # attach confluence on 1d raw for description
    raw_1d_att = apply_filter(rows1d, interval=None, peer=peer, mtf=False, min_tier="all", exact=False)
    raw_1d = attach_report(raw_1d_att, sample_set="raw_1d_mtf_unsupported", official=False, peer=peer)
    raw_1w_alltime = [r for r in all_items if str(r.get("interval") or "") == "1w"]
    raw_1w_alltime = filter_alert_stats(raw_1w_alltime, time_filter=None)
    raw_1w_att = apply_filter(raw_1w_alltime, interval=None, peer=peer, mtf=False, min_tier="all", exact=False) if raw_1w_alltime else []
    raw_1w_rows = attach_report(raw_1w_att, sample_set="raw_1w_outside_or_empty", official=False, peer=peer)

    # split official
    crypto_official = [r for r in official_15 if is_crypto_row(r)]
    # 15m non-crypto must not enter official US (user asked equity intervals 4h/1d/1w only)
    us_15m_excluded = [r for r in official_15 if is_non_crypto_row(r)]
    crypto_15m_unknown = [r for r in official_15 if r["reportAssetClass"] == "unknown"]
    crypto_15m_excluded_stable = [r for r in official_15 if r["reportAssetClass"] == "excluded_stable_or_heloc"]
    us_4h_official = [r for r in official_4h if is_non_crypto_row(r)]
    crypto_4h_not_in_scope = [r for r in official_4h if is_crypto_row(r)]
    us_1h_excluded = [r for r in official_1h if is_non_crypto_row(r)]
    us_1d_raw = [r for r in raw_1d if is_non_crypto_row(r)]
    crypto_1d_raw = [r for r in raw_1d if is_crypto_row(r)]
    us_1w_raw_window = [r for r in raw_1w_rows if is_non_crypto_row(r) and start_ms <= int(r.get("signalAtMs") or 0) <= now_ms]
    us_1w_alltime = [r for r in raw_1w_rows if is_non_crypto_row(r)]

    def by_bucket(rows, keys):
        return {k: bucket_counts([r for r in rows if r["reportBucket"] == k]) for k in keys}

    crypto_tiers = by_bucket(crypto_official, ("t1", "t2", "t3"))
    us_major_4h = by_bucket(us_4h_official, ("eq-t1", "eq-t2", "eq-t3"))
    us_other_4h = {
        "eq-other": bucket_counts([r for r in us_4h_official if r["reportBucket"] == "eq-other"]),
        "eq-index": bucket_counts([r for r in us_4h_official if r["reportBucket"] == "eq-index"]),
        "eq-lev": bucket_counts([r for r in us_4h_official if r["reportBucket"] == "eq-lev"]),
        "eq-macro": bucket_counts([r for r in us_4h_official if r["reportBucket"] == "eq-macro"]),
        "non_us_equity": bucket_counts([r for r in us_4h_official if r["reportBucket"] == "non_us_equity"]),
        "unknown": bucket_counts([r for r in us_4h_official if r["reportBucket"] == "unknown"]),
    }

    # future stats on official sets
    def fut_stats(rows):
        n = sum(1 for r in rows if str(r.get("hasFutureMtfPeer")).lower() == "true" or r.get("hasFutureMtfPeer") is True)
        drop = sum(1 for r in rows if r.get("hasMtfResonance") and not (str(r.get("causalStillResonates")).lower() == "true" or r.get("causalStillResonates") is True))
        return {"n": len(rows), "withFuturePeer": n, "wouldDropIfCausalOnly": drop}

    official_rows = crypto_official + us_4h_official
    coverage_rows = us_15m_excluded + us_1h_excluded + us_1d_raw + us_1w_alltime + crypto_15m_unknown + crypto_4h_not_in_scope

    funnel = {
        "allLoaded": len(all_items),
        "afterRolling30d": len(rows30),
        "cryptoCandidate15m": len(rows15),
        "all4hInWindow": len(rows4h),
        "all1dInWindow": len(rows1d),
        "all1wInWindow": len(rows1w),
        "mtfAb15mAllAssets": len(off15),
        "mtfAb1hAllAssets": len(off1h),
        "mtfAb4hAllAssets": len(off4h),
        "mtfAb1dAllAssets": len(off1d),
        "mtfAb1wAllAssets": len(off1w),
        "officialCrypto15mAfterReportClass": len(crypto_official),
        "officialUs4hAfterReportClass": len(us_4h_official),
        "excludedUs15mMtfAb": len(us_15m_excluded),
        "excludedUs1hMtfAb": len(us_1h_excluded),
        "rawUs1dInWindow": len(us_1d_raw),
        "rawCrypto1dInWindow": len(crypto_1d_raw),
        "scoreOnly1dAB_notOfficial": len(ref1d_ab),
        "unknownInOfficial15m": len(crypto_15m_unknown),
        "stableExcludedInOfficial15m": len(crypto_15m_excluded_stable),
    }

    params = {
        "resultKind": "既有结算复核统计（未重跑 K 线）",
        "task": "形态信号列表 滚动30天 / 仅多周期共振 / 综合评分 A,B / 币圈仅15m / 美股个股及集合仅4h·1d·1w",
        "timezone": "Asia/Shanghai (UTC+8)",
        "cutoffMs": now_ms,
        "cutoffCst": cst(now_ms),
        "window": "rolling_30d",
        "windowMs": WINDOW_MS,
        "windowStartMs": start_ms,
        "windowStartCst": cst(start_ms),
        "windowEndCst": cst(now_ms),
        "filters": {
            "source": "形态信号列表同口径 list_alert_stats + _apply_tier_filters，不改生产默认/策略/通知周期",
            "time": "滚动 30×24 小时，截止与起点在运行时固定",
            "confluence": "A∪B（min_tier=B，精确 A+精确 B）",
            "mtfResonanceOnly": True,
            "cryptoInterval": "15m only",
            "equityIntervalsRequested": ["4h", "1d", "1w"],
            "equityExcludedIntervals": ["15m", "1h"],
        },
        "mtfResonanceDefinition": {
            "supportedIntervals": sorted(MTF_RESONANCE_INTERVALS),
            "window": "±4 hours",
            "rule": "同币、同向、同形态族，时间窗内覆盖 ≥2 个周期（仅 15m/1h/4h 为合格周期）",
            "dailyWeeklySupported": False,
            "dailyWeeklyNote": "现逻辑 MTF_RESONANCE_INTERVALS={'15m','1h','4h'}，未实现 1d/1w 共振。本次不发明日周线共振。1d/1w 在「仅多周期共振」下官方样本不适用，不记 0% 胜率；仅报告库内原始数量。",
        },
        "settlement": {
            "source": "形态信号列表已落盘 outcome，未重跑 K 线，未写入生产库",
            "rulesSummary": settle_rules_summary(),
            "fees": "落盘通常未扣手续费/滑点",
            "auditAssumptions": {
                "leverageMajor": assumptions.get("leverageMajor"),
                "leverageAlt": assumptions.get("leverageAlt"),
                "feePctPerSideDefaultDocumented": assumptions.get("feePctPerSideDefault"),
                "slippagePctPerSideDefaultDocumented": assumptions.get("slippagePctPerSideDefault"),
            },
        },
        "mcapTiers": {
            "cryptoThresholdsUsd": {"t1_gt": t1_usd, "t2_gt": t2_usd},
            "lookAhead": "用当前 CoinGecko 缓存与同日公司市值种子划分历史样本，存在轻微前视；本次实时刷新因代理失败未成功，沿用缓存",
            "majorTechList": sorted(MAJOR_TECH),
        },
        "funnel": funnel,
        "coverageByInterval": coverage,
        "futureMtfOfficialCrypto15m": fut_stats(crypto_official),
        "futureMtfOfficialUs4h": fut_stats(us_4h_official),
        "elapsedSec": None,
        "productionUnchanged": True,
        "sevenDayBaselinePreserved": "/workspace/oi_pattern_list_7d_mtf_15m_ab/",
    }

    results = {
        "resultKind": "既有结算复核统计（未重跑 K 线）",
        "params": params,
        "crypto15mOfficial": {
            "summary": bucket_counts(crypto_official),
            "byTier": {k: {"tier": k, "label": BUCKET_LABEL[k], **v} for k, v in crypto_tiers.items()},
            "unknownSeparated": bucket_counts(crypto_15m_unknown),
        },
        "equityOfficial": {
            "note": "官方口径仅 4h 可进入现有多周期共振；1d/1w 不适用，不记 0% 胜率。未混入美股 15m/1h。",
            "interval4h": {
                "summary": bucket_counts(us_4h_official),
                "usMajor": {k: {"tier": k, "label": BUCKET_LABEL[k], **v} for k, v in us_major_4h.items()},
                "otherGroups": {k: {"tier": k, "label": BUCKET_LABEL[k], **v} for k, v in us_other_4h.items()},
            },
            "interval1d": {
                "officialStatus": "unsupported_mtf",
                "officialSampleNA": True,
                "officialWinRateNotComputed": True,
                "rawInWindowNonCrypto": bucket_counts(us_1d_raw),
                "scoreOnlyAB_notOfficial": len(ref1d_ab),
            },
            "interval1w": {
                "officialStatus": "unsupported_mtf",
                "officialSampleNA": True,
                "officialWinRateNotComputed": True,
                "rawInWindowNonCrypto": bucket_counts(us_1w_raw_window),
                "allTimeNonCryptoListedForCoverage": [
                    {"signalAtCst": r["signalAtCst"], "tradeSymbol": r["tradeSymbol"], "typeLabel": r["typeLabel"], "outcome": r["outcome"], "inWindow": start_ms <= int(r.get("signalAtMs") or 0) <= now_ms}
                    for r in us_1w_alltime
                ],
            },
            "officialCombinedEquals4hOnly": bucket_counts(us_4h_official),
        },
        "excludedFromThisRequest": {
            "us15mMtfAb": bucket_counts(us_15m_excluded),
            "us1hMtfAb": bucket_counts(us_1h_excluded),
            "crypto4hMtfAbNotInCryptoScope": bucket_counts(crypto_4h_not_in_scope),
        },
    }
    params["elapsedSec"] = round(time.time() - started, 3)

    # CSVs
    official_csv = official_rows
    coverage_csv = us_15m_excluded + us_1h_excluded + us_1d_raw + us_1w_alltime + crypto_4h_not_in_scope + crypto_15m_unknown
    fields = list(official_csv[0].keys()) if official_csv else list((coverage_csv[0].keys()) if coverage_csv else ["key"])

    def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
        with path.open("w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            for row in rows:
                w.writerow(row)

    write_csv(OUT / "signals_official.csv", official_csv)
    write_csv(OUT / "signals_coverage_nonofficial.csv", coverage_csv)
    write_csv(OUT / "signals_all_review.csv", official_csv + coverage_csv)
    (OUT / "params.json").write_text(json.dumps(params, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    (OUT / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    # NOTES
    csum = bucket_counts(crypto_official)
    us4 = bucket_counts(us_4h_official)
    notes = f"""# 形态信号列表 30 天既有结算复核（币圈 15m / 美股 4h·1d·1w）

本结果是**既有结算复核统计**，不是重跑 K 线，也不是新策略或因果变体回测。未改生产默认周期、策略、通知或共振逻辑，未提交、未重启。7 天基线仍保留在 `/workspace/oi_pattern_list_7d_mtf_15m_ab/`。

## 窗口（Asia/Shanghai, UTC+8）
- 截止：{cst(now_ms)}
- 起点：{cst(start_ms)}（滚动 30×24 小时）
- 口径：仅多周期共振 + 综合评分 A∪B；币圈仅 15m；美股个股及集合仅 4h/1d/1w，**未混入**美股 15m/1h

## 共振是否支持 1d/1w
现逻辑 `MTF_RESONANCE_INTERVALS = {{15m, 1h, 4h}}`，**没有**日线/周线共振，本次未发明。
- 4h 可以与 15m/1h 同行周期共振，可进入官方口径
- 1d/1w 在「仅多周期共振」下官方样本为**不适用**，**不记 0% 胜率**
- 窗口内 1d 库内原始 {len(rows1d)} 条（其中非加密/集合 {len(us_1d_raw)} 条）；官方 MTF 筛选后 0 条
- 窗口内 1w 库内原始 **0** 条。全库仅 1 条 1w：PAXG 倒锤子，2026-10-12 08:42:27，在本窗口开始之前

## 30 天数据覆盖
- 15m：{coverage.get('15m', {}).get('inWindow')} 条，窗口内范围 {coverage.get('15m', {}).get('windowRangeCst')}
- 1h：{coverage.get('1h', {}).get('inWindow')} 条
- 4h：{coverage.get('4h', {}).get('inWindow')} 条，窗口内范围 {coverage.get('4h', {}).get('windowRangeCst')}
- 1d：{coverage.get('1d', {}).get('inWindow')} 条，窗口内范围 {coverage.get('1d', {}).get('windowRangeCst')}
- 1w：窗口内 0 条（全库 1 条在窗口外）
- 漏斗：全库 {funnel['allLoaded']} → 30 天 {funnel['afterRolling30d']} → 15m 全部 {funnel['cryptoCandidate15m']} / 4h 全部 {funnel['all4hInWindow']} / 1d 全部 {funnel['all1dInWindow']} / 1w 全部 {funnel['all1wInWindow']}
- 全部资产 MTF+A/B：15m {funnel['mtfAb15mAllAssets']}，4h {funnel['mtfAb4hAllAssets']}，1d {funnel['mtfAb1dAllAssets']}，1w {funnel['mtfAb1wAllAssets']}
- 报告层分类后官方：币圈 15m {funnel['officialCrypto15mAfterReportClass']}；美股/集合 4h {funnel['officialUs4hAfterReportClass']}
- 按本次要求排除的美股 15m MTF+A/B：{funnel['excludedUs15mMtfAb']}；美股 1h MTF+A/B：{funnel['excludedUs1hMtfAb']}

## 胜率定义
分母只计 take_profit + stop_loss；观察档、平、未结算、异常、缺失不进分母，缺失不当中性。落盘通常未扣手续费/滑点。几乎全部历史结算 profile 仍可能是旧 t3 参数，不是按当前市值三档重算。

## 加密 15m 三梯队（仅确认的加密代币；当前 CoinGecko 流通市值 >500 亿 t1、>80 亿 t2，其余或确认加密但缺失市值为 t3）

{HDR}
{SEP}
{line_row("t1 第一梯队", crypto_tiers["t1"])}
{line_row("t2 第二梯队", crypto_tiers["t2"])}
{line_row("t3 第三梯队", crypto_tiers["t3"])}
{line_row("加密合计", csum)}

未知待核验（已从加密胜率排除）：{bucket_counts(crypto_15m_unknown)['total']} 条。稳定币/FIGR_HELOC：{len(crypto_15m_excluded_stable)} 条。

## 美股 4h（官方可进入共振的唯一周期）及 1d/1w 原始覆盖

### 4h 官方（仅多周期共振 + A/B，已排除加密）
{HDR}
{SEP}
{line_row("eq-t1 个股第一梯队", us_major_4h["eq-t1"])}
{line_row("eq-t2 个股第二梯队", us_major_4h["eq-t2"])}
{line_row("eq-t3 个股第三梯队", us_major_4h["eq-t3"])}
{line_row("美股其他", us_other_4h["eq-other"])}
{line_row("指数", us_other_4h["eq-index"])}
{line_row("杠杆", us_other_4h["eq-lev"])}
{line_row("宏观", us_other_4h["eq-macro"])}
{line_row("非美股权益", us_other_4h["non_us_equity"])}
{line_row("未知待核验", us_other_4h["unknown"])}
{line_row("美股/集合 4h 合计", us4)}

因 1d/1w 不能进入现有共振，**官方合计等于 4h 合计**，不是把缺失周期写成 0%。

### 1d（官方不适用）
- 官方「仅多周期共振」样本：不适用（不支持 1d 共振），不计算官方胜率
- 窗口内非加密原始条数：{len(us_1d_raw)}；胜/负/平/未结算/观察 = {bucket_counts(us_1d_raw)['wins']}/{bucket_counts(us_1d_raw)['losses']}/{bucket_counts(us_1d_raw)['flats']}/{bucket_counts(us_1d_raw)['pending']}/{bucket_counts(us_1d_raw)['observation']}
- 上述胜负只是库内原始结算盘点，**不是**本口径官方胜率
- 若不要求共振、只看综合分 A/B，1d 全部资产有 {len(ref1d_ab)} 条，仍不得当作官方结果

### 1w（官方不适用）
- 窗口内原始 0 条，官方样本不适用，不记 0% 胜率
- 全库 1 条 1w 在窗口外：PAXG，2026-10-12 08:42:27

## 报告层分类说明
未把未进白名单的股票/ETF/商品记入加密。例如 15m 官方 MTF+A/B 全资产 {len(off15)} 条中，{len(us_15m_excluded)} 条为美股/集合/商品等，已从加密胜率移出，且因周期是 15m 也不进入本次美股官方统计。KORU 归杠杆集合，XAUT/BZ/XAG/CL 归宏观，NBIS/MU/SKHY 等归美股其他，SKHYNIX 归非美股权益。

## 方法限制（须一并阅读）
1. 共振窗 ±4 小时含未来信息。官方币圈 15m：{fut_stats(crypto_official)['withFuturePeer']}/{fut_stats(crypto_official)['n']} 条有未来 peer；官方美股 4h：{fut_stats(us_4h_official)['withFuturePeer']}/{fut_stats(us_4h_official)['n']} 条。列表统计 ≠ 可交易因果回测。
2. 未重跑结算；旧结算 profile 与未扣费用限制仍在。
3. 用当前市值/同日公司市值缓存划分历史样本，有轻微前视；实时刷新失败，沿用缓存。
4. 官方美股 4h 仅 {len(us_4h_official)} 条，样本很少；信号可能集中，百分率不稳定。
5. 本次只做用户要求的周期调整统计，未改共振实现，未补日周线策略。

## 文件
- signals_official.csv：官方样本（币圈 15m + 美股/集合 4h）
- signals_coverage_nonofficial.csv：1d/1w 原始覆盖，以及按要求排除的美股 15m/1h
- signals_all_review.csv：以上合并，用 sampleSet / inOfficialFilter 区分
- params.json / results.json / NOTES.md
"""
    (OUT / "NOTES.md").write_text(notes, encoding="utf-8")
    (OUT / "summary.txt").write_text(notes, encoding="utf-8")

    # copy to allowed export dir
    import shutil
    for p in OUT.iterdir():
        if p.is_file() and p.suffix in {".csv", ".json", ".md", ".txt", ".py"}:
            shutil.copy2(p, EXPORT / p.name)
    shutil.copy2(Path(__file__), EXPORT / "run_30d_review.py")

    print("CUTOFF", cst(now_ms), "START", cst(start_ms))
    print("FUNNEL", json.dumps(funnel, ensure_ascii=False))
    print("CRYPTO", wr_text(csum), {k: (v["total"], wr_text(v), v["symbols"]) for k, v in crypto_tiers.items()})
    print("US4H", wr_text(us4), us4["symbols"])
    for k, v in {**us_major_4h, **us_other_4h}.items():
        if v["total"] or k.startswith("eq-t"):
            print(" ", k, wr_text(v), v["symbols"])
    print("US15m excluded", len(us_15m_excluded), "US1h excluded", len(us_1h_excluded))
    print("US1d raw", len(us_1d_raw), bucket_counts(us_1d_raw))
    print("US1w window", len(us_1w_raw_window), "alltime", [(r["signalAtCst"], r["tradeSymbol"], r["outcome"]) for r in us_1w_alltime])
    print("unknown official 15m", len(crypto_15m_unknown), [r["tradeSymbol"] for r in crypto_15m_unknown])
    print("official n", len(official_csv), "coverage n", len(coverage_csv))
    print("export", EXPORT)


if __name__ == "__main__":
    main()
