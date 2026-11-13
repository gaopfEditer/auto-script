#!/usr/bin/env python3
"""MTF-only vs A/B-only constraint comparison on already-settled outcomes.

Engine B: list_alert_stats + same report-layer classification as this morning's
6m official review. No kline rerun, no production writes.

Engine A: document current auto-script gates; re-filter the already-finished
structure_mtf_15m_6m trades (MTF available, confluence A/B NOT stored).
Does not start a new kline crawl.
"""
from __future__ import annotations

import csv
import importlib.util
import json
import math
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path("/Users/maotouying/frontend/code/1.operations/auto-script/discord-collector")
sys.path.insert(0, str(ROOT))

SIX_DIR = Path(
    "/Users/maotouying/.openmausbot/task-workspaces/"
    "09ce09cf-3550-433e-9107-dc73373d246c/"
    "10673020-f267-44ed-8201-3325577b903c/"
    "trading-oi-pipeline/02-backtest/six_month_official_mtf_ab_tier_20261113"
)
SIX_SCRIPT = SIX_DIR / "run_6m_official_mtf_ab_review.py"

OUT = Path(
    "/Users/maotouying/frontend/code/1.operations/auto-script/"
    "discord-collector/_backtest_exports/oi_filter_compare_mtf_ab_20261113"
)
STRUCT_CSV = ROOT / "oi_mornitor/data/structure_mtf_15m_6m/trades_15m.csv"
STRUCT_SUMMARY = ROOT / "oi_mornitor/data/structure_mtf_15m_6m/summary.json"

WINDOW_START_MS = 1778631148000
WINDOW_END_MS = 1794528748000
TZ = timezone(timedelta(hours=8))
SMALL_N = 15
T1 = 50_000_000_000
T2_PROD = 8_000_000_000
T2_RESEARCH = 5_000_000_000

# Morning official checksum (8B t2, crypto 15m, MTF+A/B)
CHECKSUM = {
    "t1": {"settled": 130, "wins": 95, "losses": 35, "winRatePct": 73.08, "sumPnl": 5052.31},
    "t2": {"settled": 75, "wins": 45, "losses": 30, "winRatePct": 60.00, "sumPnl": 1166.69},
    "t3": {"settled": 267, "wins": 146, "losses": 121, "winRatePct": 54.68, "sumPnl": 1431.86},
    "all": {"settled": 472, "wins": 286, "losses": 186, "winRatePct": 60.59},
}

CRYPTO_BUCKETS = ("t1", "t2", "t3")
US_MAJOR_BUCKETS = ("eq-t1", "eq-t2", "eq-t3")
US_COLLECTION_BUCKETS = ("eq-index", "eq-lev", "eq-macro", "eq-other")
US_OTHER = ("non_us_equity", "unknown", "excluded")


def load_rev():
    spec = importlib.util.spec_from_file_location("rev6m", SIX_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def cst(ms: int) -> str:
    if not ms:
        return ""
    return datetime.fromtimestamp(ms / 1000.0, TZ).strftime("%Y-%m-%d %H:%M:%S")


def pnl_stats(pnls: list[float]) -> dict[str, Any]:
    if not pnls:
        return {"n": 0, "avg": None, "median": None, "sum": None}
    return {
        "n": len(pnls),
        "avg": round(sum(pnls) / len(pnls), 4),
        "median": round(statistics.median(pnls), 4),
        "sum": round(sum(pnls), 2),
    }


def stats_of(rows: list[dict[str, Any]], *, pnl_key: str = "pnlPct") -> dict[str, Any]:
    """Win-rate from take_profit + stop_loss only. Observation/flat/pending/error/missing excluded."""
    total = len(rows)
    obs = pending = wins = losses = flats = errors = other = 0
    settled_pnls: list[float] = []
    for r in rows:
        obs_flag = r.get("observation")
        if obs_flag is True or obs_flag == "true" or obs_flag == "True":
            obs += 1
        oc = str(r.get("outcome") or "pending").strip().lower() or "pending"
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
        if oc in ("take_profit", "stop_loss"):
            raw = r.get(pnl_key)
            if raw in (None, ""):
                continue
            try:
                settled_pnls.append(float(raw))
            except (TypeError, ValueError):
                pass
    settled = wins + losses
    wr = (wins / settled) if settled else None
    pnl = pnl_stats(settled_pnls)
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
        "winRate": wr,
        "winRatePct": round(100.0 * wr, 2) if wr is not None else None,
        "smallSample": bool(settled < SMALL_N),
        "pnlPct": {
            "source": pnl_key,
            "note": "leveraged margin return as stored; sum is not an equity curve; fees only if already deducted in stored field",
            **pnl,
        },
        "symbols": dict(Counter(str(r.get("tradeSymbol") or r.get("symbol") or "") for r in rows)),
    }


def wr_text(b: dict[str, Any]) -> str:
    if b.get("winRate") is None:
        return "n/a（无已结算胜负，不记 0%）" if b.get("total", 0) else "n/a（无样本，不记 0%）"
    flag = " 〔小样本〕" if b.get("smallSample") else ""
    return f"{b['winRatePct']:.2f}%（{b['wins']}/{b['settledForWinRate']}）{flag}"


def group_by(rows: list[dict[str, Any]], key: str) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list] = defaultdict(list)
    for r in rows:
        out[str(r.get(key) or "")].append(r)
    return dict(out)


def breakdown(rows: list[dict[str, Any]], key: str, order: tuple[str, ...] | None = None) -> dict[str, Any]:
    g = group_by(rows, key)
    keys = list(order) if order else sorted(g, key=lambda k: (-len(g[k]), k))
    for k in g:
        if k not in keys:
            keys.append(k)
    return {k: stats_of(g.get(k, [])) for k in keys}


def cross_breakdown(rows: list[dict[str, Any]], k1: str, k2: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for r in rows:
        a = str(r.get(k1) or "")
        b = str(r.get(k2) or "")
        out.setdefault(a, {}).setdefault(b, []).append(r)
    return {a: {b: stats_of(rs) for b, rs in inner.items()} for a, inner in out.items()}


def delta_wr(new: dict, base: dict) -> dict[str, Any] | None:
    if new.get("winRate") is None or base.get("winRate") is None:
        return None
    return {
        "pp": round(new["winRatePct"] - base["winRatePct"], 2),
        "settledNew": new["settledForWinRate"],
        "settledBase": base["settledForWinRate"],
        "winsNew": new["wins"],
        "winsBase": base["wins"],
    }


def research_t2_bucket(row: dict[str, Any]) -> str:
    """Research cut: t2 if cap > $5B and not t1. Not the auto-script default."""
    b = str(row.get("reportBucket") or "")
    if b != "t1" and b != "t2" and b != "t3":
        return b
    cap = row.get("reportCapUsd")
    try:
        cap_f = float(cap) if cap not in (None, "") else None
    except (TypeError, ValueError):
        cap_f = None
    if cap_f is None:
        return "t3"
    if cap_f > T1:
        return "t1"
    if cap_f > T2_RESEARCH:
        return "t2_research_gt5b"
    return "t3"


def checksum_compare(by_tier: dict, all_s: dict) -> dict[str, Any]:
    out = {"matched": True, "details": {}}
    for k, exp in CHECKSUM.items():
        got = all_s if k == "all" else by_tier.get(k, {})
        d = {
            "expected": exp,
            "got": {
                "settled": got.get("settledForWinRate"),
                "wins": got.get("wins"),
                "losses": got.get("losses"),
                "winRatePct": got.get("winRatePct"),
                "sumPnl": (got.get("pnlPct") or {}).get("sum"),
            },
        }
        ok = (
            d["got"]["settled"] == exp["settled"]
            and d["got"]["wins"] == exp["wins"]
            and d["got"]["losses"] == exp["losses"]
            and (d["got"]["winRatePct"] == exp["winRatePct"] or (
                d["got"]["winRatePct"] is not None
                and abs(d["got"]["winRatePct"] - exp["winRatePct"]) < 0.011
            ))
        )
        if "sumPnl" in exp and d["got"]["sumPnl"] is not None:
            ok = ok and abs(d["got"]["sumPnl"] - exp["sumPnl"]) < 0.05
        d["match"] = ok
        if not ok:
            out["matched"] = False
        out["details"][k] = d
    return out


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str] | None = None) -> None:
    if not rows and not fields:
        path.write_text("", encoding="utf-8-sig")
        return
    fields = fields or list(rows[0].keys())
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for row in rows:
            w.writerow(row)


def slice_pack(name: str, rows: list[dict[str, Any]], *, note: str = "") -> dict[str, Any]:
    s = stats_of(rows)
    by_cap = breakdown(rows, "reportBucket")
    by_type = breakdown(rows, "typeLabel")
    by_fam = breakdown(rows, "mtfFamily")
    by_fam_label = breakdown(rows, "mtfFamilyLabel")
    cross = cross_breakdown(rows, "reportBucket", "typeLabel")
    # research 5B for crypto rows only
    research = None
    crypto_like = [r for r in rows if r.get("reportAssetClass") == "crypto"]
    if crypto_like:
        tagged = []
        for r in crypto_like:
            rr = dict(r)
            rr["researchBucket"] = research_t2_bucket(r)
            tagged.append(rr)
        research = breakdown(tagged, "researchBucket", ("t1", "t2_research_gt5b", "t3"))
    causal_rows = [r for r in rows if _truthy(r.get("causalStillResonates"))]
    future_peer_rows = [r for r in rows if _truthy(r.get("hasFutureMtfPeer"))]
    causal_and_official_mtf = [
        r for r in rows if _truthy(r.get("hasMtfResonance")) and _truthy(r.get("causalStillResonates"))
    ]
    official_mtf_depends_on_future = [
        r
        for r in rows
        if _truthy(r.get("hasMtfResonance")) and not _truthy(r.get("causalStillResonates"))
    ]
    return {
        "name": name,
        "note": note,
        "summary": s,
        "byCapBucket": by_cap,
        "byTypeLabel": by_type,
        "byMtfFamily": by_fam,
        "byMtfFamilyLabel": by_fam_label,
        "byCapXTypeLabel": cross,
        "researchT2gt5B": research,
        "causalSensitivity": {
            "note": "Primary MTF is official ±4h (may include future peers). Causal = same-symbol/side/family covering ≥2 of 15m/1h/4h using only peers at or before signalAt. 1d/1w have no implemented resonance.",
            "officialMtfN": sum(1 for r in rows if _truthy(r.get("hasMtfResonance"))),
            "causalStillResonates": stats_of(causal_rows),
            "hasFutureMtfPeer": stats_of(future_peer_rows),
            "officialMtfAndCausal": stats_of(causal_and_official_mtf),
            "officialMtfDependsOnFuturePeer": stats_of(official_mtf_depends_on_future),
        },
        "summaryText": wr_text(s),
    }


def _truthy(v: Any) -> bool:
    return v in (True, "true", "True", "1", 1)


def struct_outcome_norm(oc: str) -> str:
    s = str(oc or "").strip().lower()
    if s in ("take_profit", "tp", "win"):
        return "take_profit"
    if s in ("stop_loss", "sl", "loss"):
        return "stop_loss"
    if s in ("flat", "timeout"):
        return "flat"
    if s in ("error",):
        return "error"
    if s in ("pending", ""):
        return "pending"
    return s


def main() -> None:
    started = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    rev = load_rev()

    from oi_mornitor.mcap_tier import mcap_thresholds_usd
    from oi_mornitor.pattern_alert_stats import (
        _apply_tier_filters,
        _rec_pnl_pct,
        filter_alert_stats,
        list_alert_stats,
    )
    from oi_mornitor.pattern_mtf_resonance import (
        MTF_RESONANCE_INTERVALS,
        has_mtf_resonance,
    )
    from oi_mornitor.pattern_settle import settle_rules_summary
    from oi_mornitor.signal_policy import (
        is_blocked_stats_record,
        is_disabled_pattern_interval,
        is_retired_pattern_stats_record,
    )
    from oi_mornitor.pattern_pause import is_paused_alert, is_paused_label, is_paused_kind
    from oi_mornitor.config import (
        OI_PATTERN_PUSH_MTF_MIN,
        OI_CONFLUENCE_PUSH_MIN_TIER,
    )

    t1_usd, t2_usd = mcap_thresholds_usd()
    # Do not refresh CoinGecko; use disk cache (same mild look-ahead as morning).
    from oi_mornitor.mcap_market_quote import _load_disk_cache, _MAP, _MAP_TS

    _load_disk_cache()
    cache_ts = _MAP_TS
    cache_n = len(_MAP or {})

    all_items = list_alert_stats()
    raw_window = [r for r in all_items if WINDOW_START_MS <= int(r.get("signalAt") or 0) <= WINDOW_END_MS]
    rows_w = filter_alert_stats(raw_window, time_filter=None, now_ms=WINDOW_END_MS)
    peer = filter_alert_stats(all_items, time_filter=None)

    # Attach MTF + confluence + report class once (peers = all-time filtered pool, same as 6m official).
    # Use exact official apply_filter for MTF+A/B checksum path.
    def attach_and_report(rows: list, *, sample: str) -> list:
        # _apply_tier_filters with min_tier=all and mtf=False still attaches MTF/confluence/mcap
        attached = _apply_tier_filters(
            list(rows),
            confluence_min_tier="all",
            mtf_resonance_only=False,
            mcap_tier_filter="all",
            mtf_peer_rows=peer,
            confluence_exact=False,
        )
        return rev.attach_report(attached, sample_set=sample, official=False, peer=peer)

    print("loading/attaching...", "all", len(all_items), "window", len(rows_w), flush=True)
    full = attach_and_report(rows_w, sample="full_window")
    print("attached", len(full), "elapsed", round(time.time() - started, 2), flush=True)

    def is_crypto15(r):
        return r.get("reportAssetClass") == "crypto" and str(r.get("interval")) == "15m"

    def is_us_official_iv(r):
        # US / collections / non-crypto, official intervals 4h/1d/1w only
        return (
            r.get("reportAssetClass") not in {"crypto", "excluded_stable_or_heloc"}
            and str(r.get("interval")) in {"4h", "1d", "1w"}
        )

    def is_ab(r):
        return str(r.get("confluenceTier") or "").upper() in {"A", "B"}

    def is_mtf(r):
        return _truthy(r.get("hasMtfResonance"))

    def is_soxs(r):
        base = rev.base_of(str(r.get("tradeSymbol") or r.get("symbol") or ""))
        return base == "SOXS"

    crypto_base = [r for r in full if is_crypto15(r)]
    us_base = [r for r in full if is_us_official_iv(r)]
    soxs_in_us = [r for r in us_base if is_soxs(r)]
    us_tradable = [r for r in us_base if not is_soxs(r)]

    # 1d/1w under MTF-only are N/A (no implemented resonance)
    us_4h = [r for r in us_tradable if str(r.get("interval")) == "4h"]
    us_1d = [r for r in us_tradable if str(r.get("interval")) == "1d"]
    us_1w = [r for r in us_tradable if str(r.get("interval")) == "1w"]

    slices_crypto = {
        "baseline": {
            "rows": crypto_base,
            "note": "interval/market rules only: crypto 15m, reportAssetClass=crypto; no MTF, no A/B",
        },
        "mtf_only": {
            "rows": [r for r in crypto_base if is_mtf(r)],
            "note": "official ±4h MTF resonance only; any confluence grade; 15m only (MTF intervals are 15m/1h/4h)",
        },
        "ab_only": {
            "rows": [r for r in crypto_base if is_ab(r)],
            "note": "confluence A or B (min_tier=B, same as official); no MTF required",
        },
        "mtf_ab": {
            "rows": [r for r in crypto_base if is_mtf(r) and is_ab(r)],
            "note": "official combined filter (MTF + A/B); checksum vs this morning",
        },
    }
    slices_us_4h = {
        "baseline": {"rows": us_4h, "note": "US/collections 4h only; no MTF, no A/B; SOXS excluded from tradable"},
        "mtf_only": {"rows": [r for r in us_4h if is_mtf(r)], "note": "4h MTF only (15m/1h/4h resonance def)"},
        "ab_only": {"rows": [r for r in us_4h if is_ab(r)], "note": "4h A/B only"},
        "mtf_ab": {"rows": [r for r in us_4h if is_mtf(r) and is_ab(r)], "note": "4h official combined"},
    }
    slices_us_1d = {
        "baseline": {"rows": us_1d, "note": "US/collections 1d; MTF N/A (not implemented)"},
        "mtf_only": {"rows": [], "note": "N/A: 1d has no implemented MTF resonance; not reported as 0%"},
        "ab_only": {"rows": [r for r in us_1d if is_ab(r)], "note": "1d A/B only; MTF not required so 1d may enter"},
        "mtf_ab": {"rows": [], "note": "N/A under official MTF+A/B because MTF is not implemented on 1d"},
    }
    slices_us_1w = {
        "baseline": {"rows": us_1w, "note": "US/collections 1w; MTF N/A"},
        "mtf_only": {"rows": [], "note": "N/A: 1w has no implemented MTF resonance; not reported as 0%"},
        "ab_only": {"rows": [r for r in us_1w if is_ab(r)], "note": "1w A/B only"},
        "mtf_ab": {"rows": [], "note": "N/A under official MTF+A/B"},
    }

    def pack_all(smap, prefix):
        return {
            k: slice_pack(f"{prefix}:{k}", v["rows"], note=v["note"])
            for k, v in smap.items()
        }

    crypto_packs = pack_all(slices_crypto, "crypto15m")
    us4_packs = pack_all(slices_us_4h, "us4h")
    us1d_packs = pack_all(slices_us_1d, "us1d")
    us1w_packs = pack_all(slices_us_1w, "us1w")

    # Split US packs by major vs collections
    def us_split(rows):
        major = [r for r in rows if str(r.get("reportBucket") or "") in US_MAJOR_BUCKETS]
        collections = [r for r in rows if str(r.get("reportBucket") or "") in US_COLLECTION_BUCKETS]
        other = [r for r in rows if str(r.get("reportBucket") or "") not in US_MAJOR_BUCKETS + US_COLLECTION_BUCKETS]
        return {
            "majorTech": slice_pack("major", major, note="AAPL/NVDA/... company-cap tiers; not mixed into collections"),
            "collectionsAndOther": {
                "eq-index": stats_of([r for r in collections if r.get("reportBucket") == "eq-index"]),
                "eq-lev": stats_of([r for r in collections if r.get("reportBucket") == "eq-lev"]),
                "eq-macro": stats_of([r for r in collections if r.get("reportBucket") == "eq-macro"]),
                "eq-other": stats_of([r for r in collections if r.get("reportBucket") == "eq-other"]),
                "other": stats_of(other),
            },
            "byCapBucket": breakdown(rows, "reportBucket"),
        }

    for packs, smap in ((us4_packs, slices_us_4h), (us1d_packs, slices_us_1d), (us1w_packs, slices_us_1w)):
        for k, v in smap.items():
            packs[k]["usSplit"] = us_split(v["rows"])

    # Exact official apply_filter checksum (same function path as morning)
    off15 = rev.apply_filter(
        filter_alert_stats(rows_w, interval="15m"),
        interval=None, peer=peer, mtf=True, min_tier="B", exact=False,
    )
    off15_rep = rev.attach_report(off15, sample_set="official_checksum", official=True, peer=peer)
    off15_crypto = [r for r in off15_rep if r.get("reportAssetClass") == "crypto"]
    chk_by_tier = breakdown(off15_crypto, "reportBucket", CRYPTO_BUCKETS)
    chk_all = stats_of(off15_crypto)
    checksum = checksum_compare(chk_by_tier, chk_all)

    # Funnel
    iv_w = Counter(str(r.get("interval") or "") for r in rows_w)
    iv_full_att = Counter(str(r.get("interval") or "") for r in full)
    crypto_any_iv = [r for r in full if r.get("reportAssetClass") == "crypto"]
    funnel = {
        "allLoaded": len(all_items),
        "afterFixed6mWindowRaw": len(raw_window),
        "afterFilterAlertStats": len(rows_w),
        "afterAttachAndReport": len(full),
        "intervalInWindow": dict(iv_w),
        "cryptoAnyInterval": len(crypto_any_iv),
        "crypto15mBaseline": len(crypto_base),
        "crypto15mMtfOnly": len(slices_crypto["mtf_only"]["rows"]),
        "crypto15mAbOnly": len(slices_crypto["ab_only"]["rows"]),
        "crypto15mMtfAb": len(slices_crypto["mtf_ab"]["rows"]),
        "crypto15mBaselineSettled": crypto_packs["baseline"]["summary"]["settledForWinRate"],
        "crypto15mMtfOnlySettled": crypto_packs["mtf_only"]["summary"]["settledForWinRate"],
        "crypto15mAbOnlySettled": crypto_packs["ab_only"]["summary"]["settledForWinRate"],
        "crypto15mMtfAbSettled": crypto_packs["mtf_ab"]["summary"]["settledForWinRate"],
        "us4hBaseline": len(us_4h),
        "us4hMtfOnly": len(slices_us_4h["mtf_only"]["rows"]),
        "us4hAbOnly": len(slices_us_4h["ab_only"]["rows"]),
        "us4hMtfAb": len(slices_us_4h["mtf_ab"]["rows"]),
        "us1dBaseline": len(us_1d),
        "us1dAbOnly": len(slices_us_1d["ab_only"]["rows"]),
        "us1wBaseline": len(us_1w),
        "us1wAbOnly": len(slices_us_1w["ab_only"]["rows"]),
        "soxsExcludedFromTradable": len(soxs_in_us),
        "excludedCrypto15m15mOr1hUS_notInThisBaseline": {
            "us15m": sum(1 for r in full if r.get("reportAssetClass") not in {"crypto", "excluded_stable_or_heloc"} and str(r.get("interval")) == "15m"),
            "us1h": sum(1 for r in full if r.get("reportAssetClass") not in {"crypto", "excluded_stable_or_heloc"} and str(r.get("interval")) == "1h"),
        },
        "unknownInCrypto15mPath": sum(1 for r in full if r.get("reportAssetClass") == "unknown" and str(r.get("interval")) == "15m"),
        "stableExcluded15m": sum(1 for r in full if r.get("reportAssetClass") == "excluded_stable_or_heloc" and str(r.get("interval")) == "15m"),
    }

    # Comparison narrative numbers
    def cmp_block(packs):
        b, m, a, x = packs["baseline"]["summary"], packs["mtf_only"]["summary"], packs["ab_only"]["summary"], packs["mtf_ab"]["summary"]
        return {
            "baseline": {"text": wr_text(b), **{k: b[k] for k in ("total", "settledForWinRate", "wins", "losses", "winRatePct")}},
            "mtf_only": {"text": wr_text(m), "vsBaseline": delta_wr(m, b), **{k: m[k] for k in ("total", "settledForWinRate", "wins", "losses", "winRatePct")}},
            "ab_only": {"text": wr_text(a), "vsBaseline": delta_wr(a, b), **{k: a[k] for k in ("total", "settledForWinRate", "wins", "losses", "winRatePct")}},
            "mtf_ab": {"text": wr_text(x), "vsBaseline": delta_wr(x, b), "vsMtfOnly": delta_wr(x, m), "vsAbOnly": delta_wr(x, a), **{k: x[k] for k in ("total", "settledForWinRate", "wins", "losses", "winRatePct")}},
            "whichSingleConstraintHigher": (
                "mtf_only" if (m.get("winRatePct") or -1) > (a.get("winRatePct") or -1)
                else ("ab_only" if (a.get("winRatePct") or -1) > (m.get("winRatePct") or -1)
                else ("tie" if m.get("winRatePct") is not None else "n/a"))
            ),
            "combinedBetterThanBothSingles": bool(
                x.get("winRatePct") is not None
                and (m.get("winRatePct") is None or x["winRatePct"] >= m["winRatePct"])
                and (a.get("winRatePct") is None or x["winRatePct"] >= a["winRatePct"])
                and (
                    (m.get("winRatePct") is not None and x["winRatePct"] > m["winRatePct"])
                    or (a.get("winRatePct") is not None and x["winRatePct"] > a["winRatePct"])
                )
            ),
        }

    # Gate extras on list records (Engine A filterables that do not need klines)
    def gate_flags(r_raw, r_rep):
        kind = str(r_raw.get("kind") or r_raw.get("signalKind") or r_rep.get("typeLabel") or "")
        lab = str(r_rep.get("typeLabel") or r_raw.get("typeLabel") or "")
        iv = str(r_rep.get("interval") or "")
        paused = False
        try:
            paused = is_paused_alert(r_raw) or is_paused_label(lab) or is_paused_kind(kind)
        except Exception:
            paused = is_paused_label(lab) or is_paused_kind(kind)
        blocked = False
        try:
            blocked = bool(is_blocked_stats_record(r_raw) or is_retired_pattern_stats_record(r_raw))
        except Exception:
            pass
        disabled_iv = is_disabled_pattern_interval(iv)
        spring = kind in ("破底翻确认", "spring_2b") or lab in ("破底翻确认",)
        obs = bool(r_rep.get("observation") in (True, "true", "True"))
        return {
            "paused": paused,
            "blockedOrRetired": blocked,
            "disabledInterval": disabled_iv,
            "springOrBottomspringBlocked": spring,
            "observation": obs,
        }

    # Map raw by key for gate flags
    raw_by_key = {}
    for r in rows_w:
        k = r.get("key")
        if k:
            raw_by_key[k] = r

    def apply_live_emit_extras(rows):
        kept = []
        dropped = Counter()
        for r in rows:
            raw = raw_by_key.get(r.get("key"), {})
            fl = gate_flags(raw, r)
            if fl["paused"]:
                dropped["paused"] += 1
                continue
            if fl["blockedOrRetired"]:
                dropped["blockedOrRetired"] += 1
                continue
            if fl["disabledInterval"]:
                dropped["disabledInterval"] += 1
                continue
            if fl["springOrBottomspringBlocked"]:
                dropped["springBlocked"] += 1
                continue
            if fl["observation"]:
                dropped["observation"] += 1
                continue
            kept.append(r)
        return kept, dict(dropped)

    # Engine A on list: same slices PLUS live emit extras (pause/block/obs). Does NOT force production confluence B
    # or MTF min, because the experiment varies those constraints. Live env MTF min is 1 (no-op).
    engine_a_list = {}
    for name, smap in (("crypto15m", slices_crypto), ("us4h", slices_us_4h)):
        engine_a_list[name] = {}
        for k, v in smap.items():
            kept, dropped = apply_live_emit_extras(v["rows"])
            engine_a_list[name][k] = {
                **slice_pack(f"engineA_list_extras:{name}:{k}", kept, note="same settled list + live emit extras (pause/block/obs/disabled/spring); MTF/AB already applied as slice; no kline situation gate"),
                "droppedByExtraGate": dropped,
                "inputN": len(v["rows"]),
                "keptN": len(kept),
            }

    # ---------- Engine A structure trades re-filter ----------
    engine_a_struct = {"available": False}
    if STRUCT_CSV.is_file():
        struct_sum = json.loads(STRUCT_SUMMARY.read_text(encoding="utf-8")) if STRUCT_SUMMARY.is_file() else {}
        struct_rows = []
        with STRUCT_CSV.open(encoding="utf-8") as f:
            for row in csv.DictReader(f):
                iso = str(row.get("signalAtIso") or "")
                try:
                    dt = datetime.fromisoformat(iso)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=TZ)
                    ms = int(dt.timestamp() * 1000)
                except Exception:
                    ms = 0
                in_official_window = WINDOW_START_MS <= ms <= WINDOW_END_MS
                sym = str(row.get("symbol") or "")
                meta = rev.classify_report(sym)
                oc = struct_outcome_norm(row.get("outcome") or "")
                rec = {
                    **row,
                    "tradeSymbol": sym,
                    "signalAtMs": ms,
                    "signalAtCst": cst(ms),
                    "outcome": oc,
                    "interval": "15m",
                    "pnlPct": row.get("netMovePct"),  # fees already in netMovePct per summary
                    "observation": False,
                    "hasMtfResonance": _truthy(row.get("displayMtf")),
                    "causalStillResonates": _truthy(row.get("causalMtf")),
                    "hasFutureMtfPeer": _truthy(row.get("displayMtf")) and not _truthy(row.get("causalMtf")),
                    "typeLabel": row.get("typeLabel"),
                    "mtfFamily": "",
                    "mtfFamilyLabel": "",
                    "confluenceTier": "",  # not stored
                    "inOfficialWindow": in_official_window,
                    **{f: meta[f] for f in (
                        "reportAssetClass", "reportBucket", "reportUnderlying",
                        "reportEvidence", "reportCapUsd", "reportCapNote",
                    )},
                }
                rec["reportAssetClassLabel"] = rev.CLS_LABEL.get(meta["reportAssetClass"], meta["reportAssetClass"])
                rec["reportBucketLabel"] = rev.BUCKET_LABEL.get(meta["reportBucket"], meta["reportBucket"])
                struct_rows.append(rec)

        # Primary: all 15m in the structure job window; also official-window subset
        def struct_slice(rows, crypto=True):
            if crypto:
                base = [r for r in rows if r.get("reportAssetClass") == "crypto"]
            else:
                base = [
                    r for r in rows
                    if r.get("reportAssetClass") not in {"crypto", "excluded_stable_or_heloc"}
                    and not (rev.base_of(r.get("tradeSymbol") or "") == "SOXS")
                ]
            return {
                "baseline": slice_pack("struct_baseline", base, note="structure engine 15m all; no confluence stored; netMovePct includes documented fees"),
                "mtf_only_displayOfficial": slice_pack(
                    "struct_mtf_display",
                    [r for r in base if _truthy(r.get("hasMtfResonance"))],
                    note="displayMtf = official ±4h definition",
                ),
                "mtf_only_causal": slice_pack(
                    "struct_mtf_causal",
                    [r for r in base if _truthy(r.get("causalStillResonates"))],
                    note="causalMtf = no future peers",
                ),
                "ab_only": {
                    "name": "struct_ab",
                    "note": "UNAVAILABLE: structure_mtf_15m_6m trades_15m.csv has no confluenceTier/score. Computing confluence needs features not in this CSV. A new structure/AI scan would be a heavy kline job (~3.45h prior run) and is not started.",
                    "available": False,
                    "summary": stats_of([]),
                },
            }

        official_window_struct = [r for r in struct_rows if r.get("inOfficialWindow")]
        engine_a_struct = {
            "available": True,
            "source": str(STRUCT_CSV),
            "jobSummaryPath": str(STRUCT_SUMMARY),
            "jobWindow": (struct_sum.get("window") if isinstance(struct_sum, dict) else None),
            "elapsedSecOriginalJob": (struct_sum.get("elapsedSec") if isinstance(struct_sum, dict) else None),
            "jobStatus": (struct_sum.get("jobStatus") if isinstance(struct_sum, dict) else None),
            "kinds": (struct_sum.get("kinds") if isinstance(struct_sum, dict) else None),
            "feeModel": (struct_sum.get("feeModel") if isinstance(struct_sum, dict) else None),
            "notes": (struct_sum.get("notes") if isinstance(struct_sum, dict) else None),
            "countsJob": (struct_sum.get("counts") if isinstance(struct_sum, dict) else None),
            "nTradesCsv": len(struct_rows),
            "nInOfficialWindow": len(official_window_struct),
            "abOnly": "unavailable_no_confluence_field",
            "cryptoJobWindow": struct_slice(struct_rows, crypto=True),
            "cryptoOfficialWindow": struct_slice(official_window_struct, crypto=True),
            "usJobWindow15m": struct_slice(struct_rows, crypto=False),
            "usNote": "This structure job is 15m-only. Official equity study uses 4h/1d/1w; these 15m US rows are coverage only, not official-style equity tables.",
            "comparisonToListEngineB": "Different engine: re-detected structure patterns on Top200 snapshot, different kind coverage (no inverted hammer / VP etc.), different settlement (fees in netMovePct), slightly different window. Win rates are NOT directly comparable to Engine B list settlements.",
        }

        # write a compact structure crypto MTF csv (official window, crypto, display MTF)
        struct_crypto_official = [r for r in official_window_struct if r.get("reportAssetClass") == "crypto"]
        write_csv(OUT / "engineA_structure_crypto15m_officialWindow_all.csv", struct_crypto_official)
        write_csv(
            OUT / "engineA_structure_crypto15m_officialWindow_mtf_display.csv",
            [r for r in struct_crypto_official if _truthy(r.get("hasMtfResonance"))],
        )

    # ---------- write CSVs ----------
    fields = list(full[0].keys()) if full else ["key"]
    write_csv(OUT / "signals_full_window.csv", full, fields)
    for name, smap in (
        ("crypto15m", slices_crypto),
        ("us4h", slices_us_4h),
        ("us1d", slices_us_1d),
        ("us1w", slices_us_1w),
    ):
        for k, v in smap.items():
            write_csv(OUT / f"signals_{name}_{k}.csv", v["rows"], fields)

    # Gate documentation (from code + current process env values; no secrets)
    from oi_mornitor.pattern_pause import (
        OI_PAUSE_BOTTOM_SECONDARY,
        OI_PAUSE_SHOOTING_STAR,
        OI_REQUIRE_DIRECTION_OR_HTF_REVERSAL,
        OI_BOTTOM_4H_DOWNTREND_FORBID_LONG,
        PAUSED_BOTTOM_KINDS,
        PAUSED_SHOOT_KINDS,
        CONTEXT_GATED_KINDS,
    )
    gate_doc = {
        "repoHeadExpected": "deeb97d3b957fed71df6f4c346beffe21e5d077d",
        "codeDefault_OI_PATTERN_PUSH_MTF_MIN": 2,
        "runtime_OI_PATTERN_PUSH_MTF_MIN": int(OI_PATTERN_PUSH_MTF_MIN),
        "runtimeNote_MTF": (
            "config.py default is 2; current process/env on this machine is "
            f"{int(OI_PATTERN_PUSH_MTF_MIN)}. If runtime==1, live push MTF gate is a no-op (need<=1 returns True)."
        ),
        "codeDefault_OI_CONFLUENCE_PUSH_MIN_TIER": "B",
        "runtime_OI_CONFLUENCE_PUSH_MIN_TIER": str(OI_CONFLUENCE_PUSH_MIN_TIER),
        "emitGate_passes_pattern_card_emit_gate": [
            "is_blocked_stats_record (retired/blocked labels and types)",
            "is_paused_alert when apply_pause=True (live default: bottom_secondary_test paused; shooting_star not paused)",
            "is_disabled_pattern_interval (30m)",
            "kind in {破底翻确认, spring_2b} blocked",
            "passes_push_mtf_gate: resonance tier count >= OI_PATTERN_PUSH_MTF_MIN",
        ],
        "telegramOrWouldPush": [
            "emit gate, then attach confluence, then passes_confluence_push_gate (min tier B by default)",
            "if confluence fails: record confluence_observation_only (settled but excluded from headline win rate)",
        ],
        "backtestEmit_passes_backtest_emit_gate": [
            "excludes is_observation_record",
            "apply_pause=False (paused kinds may enter if selected in job kinds)",
            "otherwise same emit gate including runtime MTF min",
        ],
        "situationGatesNeedKlines": {
            "OI_REQUIRE_DIRECTION_OR_HTF_REVERSAL": bool(OI_REQUIRE_DIRECTION_OR_HTF_REVERSAL),
            "OI_BOTTOM_4H_DOWNTREND_FORBID_LONG": bool(OI_BOTTOM_4H_DOWNTREND_FORBID_LONG),
            "CONTEXT_GATED_KINDS": sorted(CONTEXT_GATED_KINDS),
            "note": "cannot apply without kline data; not applied in this script",
        },
        "pausedDefaults": {
            "OI_PAUSE_BOTTOM_SECONDARY": bool(OI_PAUSE_BOTTOM_SECONDARY),
            "OI_PAUSE_SHOOTING_STAR": bool(OI_PAUSE_SHOOTING_STAR),
            "PAUSED_BOTTOM_KINDS": sorted(PAUSED_BOTTOM_KINDS),
            "PAUSED_SHOOT_KINDS": sorted(PAUSED_SHOOT_KINDS),
        },
        "aiSkipLlm": "ai_btc_backtest_jobs skip_llm / gates_only skips the LLM after gates. Existing jobs on this machine are small (BTC/ETH-scale, often 7d), not a 6m full-universe official study. A full structure kline job previously took 12425s (~3.45h) for 200 symbols 15m; not restarted.",
        "structureJobExisting": {
            "path": str(STRUCT_CSV),
            "abAvailable": False,
            "mtfAvailable": True,
        },
    }

    # HEAD
    import subprocess
    try:
        head = subprocess.check_output(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True
        ).strip()
    except Exception:
        head = "unknown"

    params = {
        "resultKind": "既有结算复核：MTF-only vs A/B-only vs baseline vs MTF+A/B；未重跑 K 线；未改生产默认",
        "timezone": "Asia/Shanghai (UTC+8)",
        "windowStartCst": cst(WINDOW_START_MS),
        "windowEndCst": cst(WINDOW_END_MS),
        "windowStartMs": WINDOW_START_MS,
        "windowEndMs": WINDOW_END_MS,
        "repoHead": head,
        "mcapTiersProduction": {
            "t1_gt": t1_usd,
            "t2_gt": t2_usd,
            "expectedProduction": {"t1_gt": T1, "t2_gt": T2_PROD},
            "lookAhead": "Historical rows classified with CURRENT circulating/company cap (disk cache, no live refresh this run). Mild look-ahead.",
            "cacheN": cache_n,
            "cacheTsUnix": cache_ts,
        },
        "researchT2": {
            "t2_gt": T2_RESEARCH,
            "label": "research cut only, not auto-script default; production remains 8B",
        },
        "settlement": {
            "engineB": "list_alert_stats stored outcomes; pnlPct = alertStatsPnlPct leveraged margin return; fees typically not deducted",
            "rulesSummary": settle_rules_summary(),
            "winRateDenominator": "take_profit + stop_loss only",
        },
        "mtfDefinition": {
            "supportedIntervals": sorted(MTF_RESONANCE_INTERVALS),
            "window": "±4 hours",
            "rule": "same symbol, same side, same pattern family, covering >=2 of 15m/1h/4h",
            "dailyWeeklySupported": False,
        },
        "filters": {
            "cryptoInterval": "15m only",
            "equityIntervals": ["4h", "1d", "1w"],
            "equityExcludedIntervals": ["15m", "1h"],
            "confluenceAB": "min_tier=B (A and B)",
        },
        "funnel": funnel,
        "checksumOfficialMtfAb": checksum,
        "gateDoc": gate_doc,
        "elapsedSec": None,
    }

    results = {
        "resultKind": params["resultKind"],
        "engineB_listSettlement": {
            "crypto15m": crypto_packs,
            "us4h": us4_packs,
            "us1d": us1d_packs,
            "us1w": us1w_packs,
            "comparison": {
                "crypto15m": cmp_block(crypto_packs),
                "us4h": cmp_block(us4_packs),
                "us1d": {
                    "note": "MTF-only and MTF+A/B are N/A on 1d (no implemented resonance). Compare A/B-only vs baseline only.",
                    "baseline": wr_text(us1d_packs["baseline"]["summary"]),
                    "ab_only": wr_text(us1d_packs["ab_only"]["summary"]),
                    "ab_vs_baseline": delta_wr(us1d_packs["ab_only"]["summary"], us1d_packs["baseline"]["summary"]),
                },
                "us1w": {
                    "note": "MTF N/A on 1w",
                    "baseline": wr_text(us1w_packs["baseline"]["summary"]),
                    "ab_only": wr_text(us1w_packs["ab_only"]["summary"]),
                    "ab_vs_baseline": delta_wr(us1w_packs["ab_only"]["summary"], us1w_packs["baseline"]["summary"]),
                },
            },
            "soxs": {"excludedFromTradable": len(soxs_in_us), "rows": len(soxs_in_us)},
        },
        "engineA_listEmitExtras": engine_a_list,
        "engineA_structureExistingJob": engine_a_struct if engine_a_struct.get("available") else {
            "available": False,
            "reason": "structure trades CSV not found",
        },
        "checksumOfficialMtfAb": checksum,
    }

    elapsed = round(time.time() - started, 3)
    params["elapsedSec"] = elapsed
    results["elapsedSec"] = elapsed

    (OUT / "params.json").write_text(json.dumps(params, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    (OUT / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    # NOTES.md
    cb = crypto_packs
    cmpc = results["engineB_listSettlement"]["comparison"]["crypto15m"]
    cmpu = results["engineB_listSettlement"]["comparison"]["us4h"]
    notes = []
    notes.append("# MTF-only vs A/B-only 约束比较（6 个月固定窗口，既有结算）")
    notes.append("")
    notes.append("本结果是**既有结算复核**，不是重跑 K 线，也不是新策略。未改生产默认（第二梯队仍是 >80 亿美元）、未提交、未重启。")
    notes.append(f"- 窗口：{cst(WINDOW_START_MS)} – {cst(WINDOW_END_MS)} Asia/Shanghai (UTC+8)")
    notes.append(f"- 仓库 HEAD：{head}")
    notes.append(f"- 生产市值门槛：t1 > {t1_usd:.0f}，t2 > {t2_usd:.0f}（已核对）。另附研究切割 t2 > 50 亿美元，仅作对照，不是 auto-script 默认。")
    notes.append("- 历史分档用**当前**流通/公司市值（磁盘缓存，本跑未实时刷新），存在轻微前视。")
    notes.append("- 胜率分母仅 take_profit + stop_loss；观察档、pending、flat、error、缺失不进分母，不当中性。")
    notes.append("- Engine B 的 pnlPct 是落盘杠杆保证金收益率；通常未扣手续费/滑点。合计不是权益曲线。")
    notes.append("- 官方 MTF 定义：同币同向同形态族、±4h、覆盖 ≥2 个 15m/1h/4h。1d/1w 无实现，MTF-only 下记 N/A，不记 0%。")
    notes.append("")
    notes.append("## 与今早官方 MTF+A/B 切片校验")
    notes.append(f"- matched: {checksum['matched']}")
    for k, d in checksum["details"].items():
        notes.append(f"  - {k}: expected {d['expected']} got {d['got']} match={d['match']}")
    notes.append("")
    notes.append("## Engine B（形态信号列表已结算，与今早同一方法）")
    notes.append("")
    notes.append("### 漏斗（币圈 15m）")
    notes.append(f"- 全库加载 {funnel['allLoaded']} → 窗口 {funnel['afterFixed6mWindowRaw']} → filter_alert_stats {funnel['afterFilterAlertStats']}")
    notes.append(
        f"- 币圈 15m baseline {funnel['crypto15mBaseline']}（已结算 {funnel['crypto15mBaselineSettled']}）"
        f" → MTF-only {funnel['crypto15mMtfOnly']}（已结算 {funnel['crypto15mMtfOnlySettled']}）"
        f" → A/B-only {funnel['crypto15mAbOnly']}（已结算 {funnel['crypto15mAbOnlySettled']}）"
        f" → MTF+A/B {funnel['crypto15mMtfAb']}（已结算 {funnel['crypto15mMtfAbSettled']}）"
    )
    notes.append("")
    notes.append("### 币圈 15m 胜率比较")
    for k in ("baseline", "mtf_only", "ab_only", "mtf_ab"):
        s = cb[k]["summary"]
        pnl = s["pnlPct"]
        notes.append(
            f"- {k}: {wr_text(s)}；总样本 {s['total']}；"
            f"pnl 平均 {pnl['avg']} / 中位 {pnl['median']} / 合计 {pnl['sum']}（n={pnl['n']}）"
        )
        # by cap
        notes.append("  按市值分档（生产 80 亿）：")
        for tid in CRYPTO_BUCKETS:
            bt = cb[k]["byCapBucket"].get(tid, stats_of([]))
            notes.append(f"    - {tid}: {wr_text(bt)}；n={bt['total']}；pnl均/中/合={bt['pnlPct']['avg']}/{bt['pnlPct']['median']}/{bt['pnlPct']['sum']}")
        if cb[k]["researchT2gt5B"]:
            notes.append("  研究切割 t2>50亿（非生产默认）：")
            for tid, bt in cb[k]["researchT2gt5B"].items():
                notes.append(f"    - {tid}: {wr_text(bt)}；n={bt['total']}")
        # top type labels with settled>=1
        notes.append("  按 typeLabel（已结算 <15 标小样本）：")
        items = sorted(cb[k]["byTypeLabel"].items(), key=lambda kv: (-(kv[1]["settledForWinRate"] or 0), kv[0]))
        for lab, bt in items:
            if bt["settledForWinRate"] == 0 and bt["total"] == 0:
                continue
            notes.append(f"    - {lab or '（空）'}: {wr_text(bt)}")
        cs = cb[k]["causalSensitivity"]
        notes.append(
            f"  因果敏感性：官方 MTF n={cs['officialMtfN']}；"
            f"其中因果仍共振 {wr_text(cs['officialMtfAndCausal'])}；"
            f"依赖未来 peer {wr_text(cs['officialMtfDependsOnFuturePeer'])}"
        )
    notes.append("")
    notes.append("### 哪条单约束更高（币圈 15m）")
    notes.append(f"- 单约束比较：{cmpc['whichSingleConstraintHigher']}")
    notes.append(f"- MTF-only vs baseline: {cmpc['mtf_only']['vsBaseline']}")
    notes.append(f"- A/B-only vs baseline: {cmpc['ab_only']['vsBaseline']}")
    notes.append(f"- MTF+A/B vs baseline: {cmpc['mtf_ab']['vsBaseline']}")
    notes.append(f"- MTF+A/B vs MTF-only: {cmpc['mtf_ab']['vsMtfOnly']}；vs A/B-only: {cmpc['mtf_ab']['vsAbOnly']}")
    notes.append(f"- 组合是否同时优于两个单约束：{cmpc['combinedBetterThanBothSingles']}")
    notes.append("")
    notes.append("### 美股 / 集合（官方周期 4h；1d/1w 在 MTF 下为 N/A）")
    notes.append(f"- 4h 漏斗：baseline {funnel['us4hBaseline']} → MTF {funnel['us4hMtfOnly']} → A/B {funnel['us4hAbOnly']} → MTF+A/B {funnel['us4hMtfAb']}")
    for k in ("baseline", "mtf_only", "ab_only", "mtf_ab"):
        s = us4_packs[k]["summary"]
        notes.append(f"- 4h {k}: {wr_text(s)}；总样本 {s['total']}")
        split = us4_packs[k]["usSplit"]
        notes.append("  主要科技股三档（不与集合混算）：")
        for tid in US_MAJOR_BUCKETS:
            bt = split["byCapBucket"].get(tid, stats_of([]))
            notes.append(f"    - {tid}: {wr_text(bt)} n={bt['total']}")
        notes.append("  集合（不进三档）：")
        for tid, bt in split["collectionsAndOther"].items():
            if bt["total"]:
                notes.append(f"    - {tid}: {wr_text(bt)} n={bt['total']} symbols={bt['symbols']}")
    notes.append(f"- 4h 单约束更高：{cmpu['whichSingleConstraintHigher']}")
    notes.append(f"- 1d baseline {wr_text(us1d_packs['baseline']['summary'])}；A/B-only {wr_text(us1d_packs['ab_only']['summary'])}；MTF N/A")
    notes.append(f"- 1w baseline {wr_text(us1w_packs['baseline']['summary'])}；A/B-only {wr_text(us1w_packs['ab_only']['summary'])}；MTF N/A")
    notes.append(f"- SOXS 观察-only，已从可交易分母排除：{funnel['soxsExcludedFromTradable']} 笔")
    notes.append("")
    notes.append("## Engine A（auto-script 门禁）")
    notes.append("")
    notes.append("门禁实现见 params.json gateDoc。要点：")
    notes.append(f"- 代码默认 OI_PATTERN_PUSH_MTF_MIN=2，当前进程运行值={int(OI_PATTERN_PUSH_MTF_MIN)}（=1 则实盘 MTF 推送门禁基本不生效）。")
    notes.append(f"- 综合评分推送门槛运行值={OI_CONFLUENCE_PUSH_MIN_TIER}（默认 B）。")
    notes.append("- 实盘还会暂停底部二次探底、拦截部分退役形态；情境闸（方向未破或大周期反转）需要 K 线，本次未套用。")
    notes.append("- 前端「仅门禁 / skip_llm」的 AI 回测会重扫 K 线。既有同类结构任务 structure_mtf_15m_6m 耗时 12425 秒（约 3.45 小时，Top200、15m、100199 条），本任务**未再启动**。该产物 CSV 有 displayMtf/causalMtf，**没有** confluence A/B 字段，故结构引擎上 A/B-only **无法计算**。若要完整 Engine A（重扫+共振分），应交给 OpenMausBot，命令见下。")
    notes.append("")
    notes.append("### Engine A 在列表已结算上加「实盘发射额外门禁」（暂停/退役/观察），不重跑 K 线")
    for name, packs in engine_a_list.items():
        notes.append(f"- {name}:")
        for k, v in packs.items():
            notes.append(f"    {k}: 输入 {v['inputN']} → 保留 {v['keptN']} 被额外门禁丢掉 {v['droppedByExtraGate']}；胜率 {wr_text(v['summary'])}")
    notes.append("")
    if engine_a_struct.get("available"):
        notes.append("### Engine A 既有结构回测产物再筛选（与列表引擎不可直接比）")
        notes.append(f"- 原任务窗口：{engine_a_struct.get('jobWindow')}，耗时 {engine_a_struct.get('elapsedSecOriginalJob')} 秒")
        notes.append(f"- CSV 行数 {engine_a_struct.get('nTradesCsv')}，落在官方窗口 {engine_a_struct.get('nInOfficialWindow')}")
        notes.append("- A/B-only：不可用（无综合评分字段）")
        for win_name, pack in (
            ("jobWindow", engine_a_struct["cryptoJobWindow"]),
            ("officialWindow", engine_a_struct["cryptoOfficialWindow"]),
        ):
            notes.append(f"- 币圈 15m {win_name}:")
            for k in ("baseline", "mtf_only_displayOfficial", "mtf_only_causal"):
                s = pack[k]["summary"]
                notes.append(f"    {k}: {wr_text(s)} n={s['total']}（结构结算 outcome 已归一；pnl 用 netMovePct，已含文档中的手续费）")
                for tid in CRYPTO_BUCKETS:
                    bt = pack[k]["byCapBucket"].get(tid, stats_of([]))
                    if bt["total"]:
                        notes.append(f"      {tid}: {wr_text(bt)}")
        notes.append(f"- {engine_a_struct.get('comparisonToListEngineB')}")
        notes.append(f"- {engine_a_struct.get('usNote')}")
    notes.append("")
    notes.append("## 若要完整 Engine A 重扫 K 线（未执行，建议 OpenMausBot）")
    notes.append("先前命令约为：`python oi_mornitor/scripts/run_structure_mtf_15m_6m.py`（已有产物，耗时约 3.45 小时，拉取 800 个 pair 的 K 线）。要补 A/B 需在结构扫描中计算并落盘 confluence，工作量至少同级，且会消耗行情 API。本次不启动。")
    notes.append("")
    notes.append("## 方法限制")
    notes.append("- 列表胜率用当前市值分档历史样本，有前视。")
    notes.append("- 官方 MTF 可用未来 ±4h peer；因果敏感性已另列，不替换主定义。")
    notes.append("- 列表 pnl 通常未扣手续费；结构产物的 netMovePct 已扣。两者不是同一结算。")
    notes.append("- 样本小的格子（已结算 <15）不要过度解读。美股官方周期样本尤其少。")
    notes.append("- 未发明 1d/1w 共振。")
    notes.append(f"- 本脚本耗时 {elapsed} 秒。")
    notes.append("")
    (OUT / "NOTES.md").write_text("\n".join(notes) + "\n", encoding="utf-8")
    (OUT / "summary.txt").write_text("\n".join(notes) + "\n", encoding="utf-8")

    print("ELAPSED", elapsed)
    print("CHECKSUM", checksum["matched"], json.dumps({k: v["match"] for k, v in checksum["details"].items()}))
    print("CRYPTO")
    for k in ("baseline", "mtf_only", "ab_only", "mtf_ab"):
        print(" ", k, wr_text(cb[k]["summary"]), "n", cb[k]["summary"]["total"])
        for tid in CRYPTO_BUCKETS:
            print("   ", tid, wr_text(cb[k]["byCapBucket"].get(tid, stats_of([]))))
    print("COMPARISON", json.dumps(cmpc, ensure_ascii=False))
    print("US4H")
    for k in ("baseline", "mtf_only", "ab_only", "mtf_ab"):
        print(" ", k, wr_text(us4_packs[k]["summary"]), "n", us4_packs[k]["summary"]["total"])
    print("OUT", OUT)


if __name__ == "__main__":
    main()
