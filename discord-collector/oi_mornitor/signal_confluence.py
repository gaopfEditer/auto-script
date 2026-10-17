"""形态信号综合共振分（列表展示 / 入库标签 / TG；非自动下单）。

V2：可校准的加性特征权重 + 训练分布百分位映射 0–100；保留 legacy 分对比。
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

from oi_mornitor.confluence_features import (
    derive_combos,
    extract_confluence_features,
    feature_display_name,
    normalize_type_label,
)
from oi_mornitor.env_parse import env_str
from oi_mornitor.main_card_policy import is_main_card_symbol
from oi_mornitor.pattern_mtf_resonance import mtf_resonance_family

logger = logging.getLogger(__name__)

_TIER_ORDER = ("A", "B", "C", "D")

# 业主离线拟合默认 ΔR（无 weights 文件时回退）
DEFAULT_FEATURE_WEIGHTS: dict[str, float] = {
    "combo:结构·双周期共振": 0.12,
    "family:vp_thrust": 0.10,
    "combo:双周期共振": 0.06,
    "family:reversal": 0.06,
    "combo:量价推进·多": 0.05,
    "combo:顶部结构确认": 0.05,
    "side:short": 0.04,
    "interval:4h": 0.025,
    "interval:15m": 0.02,
    "mcap:t3": 0.01,
    "combo:蜡烛形态·双周期共振": -0.095,
    "type:倒锤子": -0.085,
    "family:inverted_hammer": -0.084,
    "interval:1h": -0.06,
    "mcap:t1": -0.06,
    "mcap:t2": -0.057,
    "combo:单周期15m量价确认封顶": -0.036,
    "side:long": -0.02,
    "feat:cf_distribution": 0.10,
    "feat:cf_distribution_against": -0.08,
    "feat:cf_funding_align": 0.0,
    "feat:cf_whale_align": 0.0,
    "feat:cf_liq_reclaim": 0.0,
    "feat:cf_quiet_accum": 0.0,
    "feat:cf_oi_flush_align": 0.0,
    "feat:cf_oi_rebuild_align": 0.0,
    "feat:cf_funding_against": 0.0,
    "feat:cf_oi_rebuild_penalty": 0.0,
}

_WEIGHTS_VERSION = 2
_WEIGHTS_LOCK = threading.RLock()
_WEIGHTS_CACHE: dict[str, Any] | None = None

# —— legacy 口径（对比用）——
_FAMILY_BASE: dict[str, int] = {
    "reversal": 28,
    "shooting_star": 22,
    "inverted_hammer": 22,
    "vp_confirm": 14,
    "vp_thrust": 10,
}

_INTERVAL_SCORE: dict[str, int] = {
    "4h": 16,
    "1h": 11,
    "15m": 4,
    "30m": 0,
}


def default_weights_path() -> Path:
    from oi_mornitor.config import PATTERN_STATE_DB

    custom = env_str("OI_CONFLUENCE_WEIGHTS_PATH", "").strip()
    if custom:
        return Path(custom).expanduser().resolve()
    return Path(PATTERN_STATE_DB).resolve().parent / "data" / "confluence_weights.json"


def _weights_file_mtime_ns(path: Path) -> int:
    try:
        return path.stat().st_mtime_ns if path.is_file() else -1
    except OSError:
        return -1


def _load_weights_file() -> dict[str, Any] | None:
    """读取权重 JSON；缺失/损坏时返回 None（调用方回退 DEFAULT）。按 mtime 缓存。"""
    global _WEIGHTS_CACHE
    path = default_weights_path()
    mtime_ns = _weights_file_mtime_ns(path)
    with _WEIGHTS_LOCK:
        cached = _WEIGHTS_CACHE
        if (
            cached is not None
            and cached.get("_path") == str(path)
            and cached.get("_mtime_ns") == mtime_ns
        ):
            return None if cached.get("missing") else cached
        if mtime_ns < 0:
            _WEIGHTS_CACHE = {"_path": str(path), "_mtime_ns": mtime_ns, "missing": True}
            return None
        try:
            raw = path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
            logger.warning("读取共振权重失败 %s: %s", path, exc)
            _WEIGHTS_CACHE = {"_path": str(path), "_mtime_ns": mtime_ns, "missing": True}
            return None
        if not isinstance(data, dict) or not isinstance(data.get("weights"), dict):
            logger.warning("共振权重格式无效 %s，使用内置默认", path)
            _WEIGHTS_CACHE = {"_path": str(path), "_mtime_ns": mtime_ns, "missing": True}
            return None
        data = dict(data)
        data["_path"] = str(path)
        data["_mtime_ns"] = mtime_ns
        _WEIGHTS_CACHE = data
        return data


def reload_confluence_weights() -> None:
    global _WEIGHTS_CACHE
    with _WEIGHTS_LOCK:
        _WEIGHTS_CACHE = None


def active_feature_weights() -> dict[str, float]:
    data = _load_weights_file()
    if data and isinstance(data.get("weights"), dict) and data["weights"]:
        out: dict[str, float] = {}
        for k, v in data["weights"].items():
            try:
                out[str(k)] = float(v)
            except (TypeError, ValueError):
                continue
        if out:
            return out
    return dict(DEFAULT_FEATURE_WEIGHTS)


def _percentile_breakpoints() -> list[float]:
    data = _load_weights_file()
    if data and isinstance(data.get("trainRawPercentiles"), list):
        pts = []
        for x in data["trainRawPercentiles"]:
            try:
                pts.append(float(x))
            except (TypeError, ValueError):
                continue
        if len(pts) >= 5:
            return pts
    # 默认：用内置权重在空特征上的 spread 近似
    return [-0.25, -0.08, 0.0, 0.08, 0.22]


def compute_raw_score(features: set[str], weights: dict[str, float]) -> float:
    return sum(weights.get(f, 0.0) for f in features)


def map_raw_to_percentile_score(raw: float, breakpoints: list[float] | None = None) -> int:
    pts = breakpoints or _percentile_breakpoints()
    if len(pts) < 2:
        return max(0, min(100, int(round(50 + raw * 100))))
    # pts: p10,p30,p50,p70,p90 近似
    edges = [pts[0], pts[1], pts[2], pts[3], pts[4]]
    if raw <= edges[0]:
        return max(0, int(round(10 * raw / edges[0]))) if edges[0] else 0
    if raw >= edges[-1]:
        return min(100, 90 + int(round(10 * (raw - edges[-1]) / max(abs(edges[-1]), 0.01))))
    for i in range(len(edges) - 1):
        lo, hi = edges[i], edges[i + 1]
        if lo <= raw <= hi:
            frac = (raw - lo) / (hi - lo) if hi != lo else 0.5
            pct_lo = 10 + i * 20
            return int(round(pct_lo + frac * 20))
    return 50


def tier_from_percentile_score(score: int) -> str:
    if score >= 80:
        return "A"
    if score >= 60:
        return "B"
    return "C"


def _top_factors(features: set[str], weights: dict[str, float], limit: int = 3) -> list[str]:
    ranked = sorted(
        ((f, weights.get(f, 0.0)) for f in features),
        key=lambda x: abs(x[1]),
        reverse=True,
    )
    out: list[str] = []
    for f, w in ranked:
        if abs(w) < 1e-6:
            continue
        out.append(feature_display_name(f))
        if len(out) >= limit:
            break
    return out


def format_confluence_tg_line(conf: dict[str, Any]) -> str:
    score = conf.get("score")
    tier = conf.get("tier") or "C"
    factors = conf.get("topFactors") or []
    fac_s = "+".join(factors[:3]) if factors else ""
    if fac_s:
        return f"共振分 {score}（{tier}）：{fac_s}"
    return f"共振分 {score}（{tier}）"


def _norm_label(rec: dict[str, Any]) -> str:
    return str(rec.get("typeLabel") or rec.get("type_label") or "").strip()


def _side(rec: dict[str, Any]) -> str:
    s = str(rec.get("side") or "").lower()
    if s in ("long", "short"):
        return s
    d = str(rec.get("dir") or "")
    if d == "多":
        return "long"
    if d == "空":
        return "short"
    return ""


def _mtf_tiers(rec: dict[str, Any]) -> int:
    mtf = rec.get("mtfResonance")
    if not isinstance(mtf, dict):
        return 0
    try:
        return int(mtf.get("tiers") or 0)
    except (TypeError, ValueError):
        return 0


def compute_signal_confluence_legacy(rec: dict[str, Any]) -> dict[str, Any]:
    """旧版加总分（0–100），仅作 legacyScore 对比。"""
    lab = _norm_label(rec)
    side = _side(rec)
    iv = str(rec.get("interval") or "").strip()
    fam = mtf_resonance_family(lab, side) if lab else None
    reasons: list[str] = []
    combos: list[str] = []
    score = 0

    if "观察" in lab:
        score -= 18
        reasons.append("观察档降权")

    if fam:
        base = _FAMILY_BASE.get(fam, 8)
        score += base
        reasons.append(f"形态族 {fam} +{base}")
    else:
        score += 6
        reasons.append("未归类形态 +6")

    iv_sc = _INTERVAL_SCORE.get(iv, 0)
    if iv_sc:
        score += iv_sc
        reasons.append(f"周期 {iv} +{iv_sc}")

    mtf_n = _mtf_tiers(rec)
    if mtf_n >= 3:
        score += 28
        reasons.append("三周期共振 +28")
    elif mtf_n == 2:
        score += 16
        reasons.append("双周期共振 +16")

    src = str(rec.get("source") or "")
    if src == "telegram_push":
        score += 10
        reasons.append("TG 卡片推送 +10")
    elif src == "telegram_card":
        score += 8
        reasons.append("TG 交易卡 +8")
    elif src == "equity_pattern":
        score += 6
        reasons.append("币股形态 +6")

    sym = str(rec.get("tradeSymbol") or rec.get("symbol") or "")
    if is_main_card_symbol(sym):
        score += 8
        combos.append("主流币精选")
        reasons.append("MAIN 默认白名单 +8")

    if fam == "reversal" and iv in ("1h", "4h"):
        score += 12
        combos.append("结构反转·高周期")
    if fam == "reversal" and mtf_n >= 2:
        score += 14
        if "结构·双周期共振" not in combos:
            combos.append("结构·双周期共振")
    if fam == "reversal" and mtf_n >= 3:
        score += 8
        combos.append("结构·三周期共振")
    if fam in ("shooting_star", "inverted_hammer") and mtf_n >= 2:
        score += 16
        combos.append("蜡烛形态·双周期共振")
    if fam == "vp_confirm" and mtf_n >= 2:
        score += 18
        combos.append("量价确认·共振")
    if fam == "vp_confirm" and mtf_n >= 3:
        score += 10
        combos.append("量价确认·三周期")

    if fam == "vp_confirm" and iv == "15m" and mtf_n < 2:
        score = min(score, 38)
        reasons.append("单周期15m量价确认封顶")

    if fam == "vp_thrust" and mtf_n < 2:
        score = min(score, 45)

    score = max(0, min(100, score))
    if score >= 78:
        tier = "A"
    elif score >= 58:
        tier = "B"
    elif score >= 40:
        tier = "C"
    else:
        tier = "D"

    return {
        "score": score,
        "tier": tier,
        "family": fam,
        "reasons": reasons[:12],
        "combos": combos,
    }


def compute_signal_confluence_v2(
    rec: dict[str, Any],
    *,
    weights: dict[str, float] | None = None,
    breakpoints: list[float] | None = None,
) -> dict[str, Any]:
    w = weights or active_feature_weights()
    feats = extract_confluence_features(rec)
    raw = compute_raw_score(feats, w)
    score = map_raw_to_percentile_score(raw, breakpoints)
    tier = tier_from_percentile_score(score)
    lab = _norm_label(rec)
    side = _side(rec)
    iv = str(rec.get("interval") or "").strip()
    fam = mtf_resonance_family(lab, side) if lab else None
    mtf_n = _mtf_tiers(rec)
    combos = derive_combos(rec, fam, mtf_n, iv, side)
    top = _top_factors(feats, w)
    return {
        "score": score,
        "tier": tier,
        "rawScore": round(raw, 4),
        "topFactors": top,
        "family": fam,
        "combos": combos,
        "featureCount": len(feats),
    }


def compute_signal_confluence(rec: dict[str, Any]) -> dict[str, Any]:
    """返回 V2 分 + legacyScore + 展示字段。"""
    legacy = compute_signal_confluence_legacy(rec)
    v2 = compute_signal_confluence_v2(rec)
    tier = v2["tier"]
    action_hint = {
        "A": "可重点跟单 / 入库统计",
        "B": "需结合盘面；建议仅 MAIN 或共振",
        "C": "观察或缩小仓位",
        "D": "默认忽略（噪声或孤立15m量价）",
    }.get(tier, "")
    return {
        "score": v2["score"],
        "tier": tier,
        "legacyScore": legacy.get("score"),
        "legacyTier": legacy.get("tier"),
        "rawScore": v2.get("rawScore"),
        "topFactors": v2.get("topFactors") or [],
        "family": v2.get("family"),
        "combos": v2.get("combos") or [],
        "reasons": legacy.get("reasons") or [],
        "actionHint": action_hint,
    }


def score_records(
    records: list[dict[str, Any]],
    *,
    weights: dict[str, float] | None = None,
    percentile_from: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """校准用：为每条记录附加 _rawScore / _score。"""
    w = weights or active_feature_weights()
    ref_raw: list[float] = []
    if percentile_from:
        for r in percentile_from:
            ref_raw.append(compute_raw_score(extract_confluence_features(r), w))
    else:
        ref_raw = [compute_raw_score(extract_confluence_features(r), w) for r in records]
    ref_raw_sorted = sorted(ref_raw)
    n = len(ref_raw_sorted)

    def _bp() -> list[float]:
        if n < 5:
            return _percentile_breakpoints()
        idx = lambda p: ref_raw_sorted[min(n - 1, max(0, int(p * (n - 1))))]
        return [idx(0.1), idx(0.3), idx(0.5), idx(0.7), idx(0.9)]

    bps = _bp()
    out: list[dict[str, Any]] = []
    for rec in records:
        feats = extract_confluence_features(rec)
        raw = compute_raw_score(feats, w)
        sc = map_raw_to_percentile_score(raw, bps)
        out.append({**rec, "_rawScore": raw, "_score": sc})
    return out


def compute_quintile_table(
    scored: list[dict[str, Any]],
    r_values: list[float],
) -> list[dict[str, Any]]:
    if not scored or len(scored) != len(r_values):
        return []
    pairs = sorted(zip(scored, r_values), key=lambda x: x[0].get("_score", 0))
    n = len(pairs)
    q_size = max(1, n // 5)
    tables: list[dict[str, Any]] = []
    for qi in range(5):
        start = qi * q_size
        end = n if qi == 4 else (qi + 1) * q_size
        chunk = pairs[start:end]
        if not chunk:
            continue
        rs = [rv for _, rv in chunk]
        wins = sum(1 for rv in rs if rv > 0)
        exp_r = sum(rs) / len(rs)
        tables.append(
            {
                "quintile": qi + 1,
                "n": len(rs),
                "expR": round(exp_r, 4),
                "winRate": round(wins / len(rs), 4) if rs else None,
            }
        )
    return tables


def build_weights_payload(
    *,
    weights: dict[str, float],
    feature_n: dict[str, int],
    train_raw_scores: list[float],
    train_quintiles: list[dict[str, Any]],
    test_quintiles: list[dict[str, Any]],
    split_ms: int,
    shrink_k: int,
    min_n: int,
    train_count: int,
    test_count: int,
) -> dict[str, Any]:
    sorted_raw = sorted(train_raw_scores)
    n = len(sorted_raw)
    if n >= 5:
        idx = lambda p: sorted_raw[min(n - 1, max(0, int(p * (n - 1))))]
        percentiles = [idx(0.1), idx(0.3), idx(0.5), idx(0.7), idx(0.9)]
    else:
        percentiles = _percentile_breakpoints()
    return {
        "version": _WEIGHTS_VERSION,
        "fittedAt": __import__("time").time() * 1000,
        "splitSignalAtMs": split_ms,
        "shrinkK": shrink_k,
        "minFeatureN": min_n,
        "trainCount": train_count,
        "testCount": test_count,
        "weights": weights,
        "featureN": feature_n,
        "trainRawPercentiles": [round(x, 5) for x in percentiles],
        "trainQuintiles": train_quintiles,
        "testQuintiles": test_quintiles,
    }


def attach_signal_confluence(records: list[dict[str, Any]]) -> None:
    """就地写入 confluence 字段（需先 attach_mtf_resonance）。"""
    for r in records:
        if not isinstance(r, dict):
            continue
        r["confluence"] = compute_signal_confluence(r)


_TIER_RANK: dict[str, int] = {"A": 4, "B": 3, "C": 2, "D": 1}


def confluence_push_min_tier() -> str:
    from oi_mornitor.config import OI_CONFLUENCE_PUSH_MIN_TIER

    return OI_CONFLUENCE_PUSH_MIN_TIER


def tier_meets_minimum(tier: str | None, minimum: str | None) -> bool:
    """minimum 为 all 时不筛；B 表示 B 及以上（含 A）。"""
    min_t = str(minimum or "all").strip().upper()
    if not min_t or min_t == "ALL":
        return True
    got = str(tier or "C").strip().upper()
    need = _TIER_RANK.get(min_t, 0)
    return _TIER_RANK.get(got, 0) >= need


def passes_confluence_push_gate(confluence: dict[str, Any] | None) -> bool:
    """推送门槛：默认 B 及以上才推 TG。"""
    min_t = confluence_push_min_tier()
    if min_t == "ALL":
        return True
    tier = str((confluence or {}).get("tier") or "C").upper()
    return tier_meets_minimum(tier, min_t)


def confluence_for_alert(alert: dict[str, Any], peers: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """推送前：由 alert + 胜率 peers 计算共振分。"""
    from oi_mornitor.pattern_alert_stats import (
        list_alert_stats_cached,
        mtf_resonance_peers_for_signal_at,
    )
    from oi_mornitor.pattern_push_gate import alert_to_resonance_stub
    from oi_mornitor.pattern_mtf_resonance import attach_mtf_resonance

    stub = alert_to_resonance_stub(alert)
    if peers is None:
        all_cached = list_alert_stats_cached()
        pool = mtf_resonance_peers_for_signal_at(all_cached, int(stub.get("signalAt") or 0))
    else:
        from oi_mornitor.pattern_mtf_resonance import peers_within_mtf_window

        pool = peers_within_mtf_window(peers, int(stub.get("signalAt") or 0))
    combined = pool + [stub]
    attach_mtf_resonance(combined)
    from oi_mornitor.mcap_tier import resolve_mcap_tier

    sym = str(alert.get("symbol") or "")
    stub["mcapTier"] = resolve_mcap_tier(sym)
    for k in ("vol_ratio", "macd_divergence", "htf_trend_aligned", "kol_tier"):
        if alert.get(k) is not None:
            stub[k] = alert.get(k)
    if isinstance(alert.get("capitalFlow"), dict):
        stub["capitalFlow"] = alert.get("capitalFlow")
    return compute_signal_confluence(stub)


def append_confluence_to_message(
    text: str,
    conf: dict[str, Any] | None,
    *,
    capital_flow: dict[str, Any] | None = None,
) -> str:
    from oi_mornitor.capital_flow_features import format_capital_flow_tg_line

    lines: list[str] = []
    if text.strip():
        lines.append(text.strip())
    cf_line = format_capital_flow_tg_line(capital_flow)
    if cf_line:
        lines.append(cf_line)
    if conf and conf.get("score") is not None:
        lines.append(format_confluence_tg_line(conf))
    return "\n".join(lines) if lines else text


def backtest_item_confluence_key(item: dict[str, Any]) -> str:
    sym = str(item.get("symbol") or "").upper()
    iv = str(item.get("interval") or "")
    kind = str(item.get("kind") or "")
    sat = int(item.get("signalAt") or 0)
    return f"bt:{sym}:{iv}:{kind}:{sat}"


def _backtest_item_to_confluence_record(item: dict[str, Any]) -> dict[str, Any]:
    side_raw = str(item.get("side") or "").lower()
    side = "long" if side_raw == "bull" else ("short" if side_raw == "bear" else "")
    emit = str(item.get("emit") or "struct")
    source = "telegram_push" if emit in ("struct", "candle") else "backtest"
    return {
        "key": backtest_item_confluence_key(item),
        "symbol": item.get("symbol"),
        "tradeSymbol": item.get("symbol"),
        "typeLabel": item.get("typeLabel") or item.get("kind"),
        "interval": item.get("interval"),
        "side": side,
        "dir": "多" if side == "long" else ("空" if side == "short" else "—"),
        "signalAt": item.get("signalAt"),
        "source": source,
    }


def _copy_capital_flow_to_record(rec: dict[str, Any], item: dict[str, Any]) -> None:
    cf = item.get("capitalFlow")
    if isinstance(cf, dict):
        rec["capitalFlow"] = cf


def attach_confluence_to_backtest_items(items: list[dict[str, Any]]) -> None:
    """回测明细：先 MTF 共振，再综合分（与形态信号列表同口径）。"""
    from oi_mornitor.pattern_mtf_resonance import attach_mtf_resonance

    if not items:
        return
    records = []
    for it in items:
        if not isinstance(it, dict):
            continue
        rec = _backtest_item_to_confluence_record(it)
        _copy_capital_flow_to_record(rec, it)
        records.append(rec)
    attach_mtf_resonance(records)
    attach_signal_confluence(records)
    by_key = {str(r["key"]): r for r in records if r.get("key")}
    for it in items:
        if not isinstance(it, dict):
            continue
        rec = by_key.get(backtest_item_confluence_key(it))
        if not rec:
            continue
        if rec.get("mtfResonance"):
            it["mtfResonance"] = rec["mtfResonance"]
        elif "mtfResonance" in it:
            del it["mtfResonance"]
        it["confluence"] = rec.get("confluence")


def filter_items_by_confluence(
    items: list[dict[str, Any]],
    *,
    min_tier: str | None = None,
    mtf_resonance_only: bool = False,
) -> list[dict[str, Any]]:
    out = list(items)
    if mtf_resonance_only:
        out = [it for it in out if isinstance(it.get("mtfResonance"), dict)]
    min_raw = str(min_tier or "all").strip().upper()
    if min_raw and min_raw != "ALL":
        if min_raw == "D":
            out = [
                it
                for it in out
                if str((it.get("confluence") or {}).get("tier") or "C").upper() == "D"
            ]
        else:
            out = [
                it
                for it in out
                if tier_meets_minimum(
                    (it.get("confluence") or {}).get("tier")
                    if isinstance(it.get("confluence"), dict)
                    else None,
                    min_raw,
                )
            ]
    return out


def sort_records_by_confluence_score(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def key_fn(r: dict[str, Any]) -> tuple[int, int]:
        conf = r.get("confluence") if isinstance(r.get("confluence"), dict) else {}
        try:
            sc = int(conf.get("score") or 0)
        except (TypeError, ValueError):
            sc = 0
        sat = int(r.get("signalAt") or 0)
        return (-sc, -sat)

    return sorted(rows, key=key_fn)


def summarize_by_confluence_tier(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按 A/B/C/D 分桶计数（不含胜率，由 structure_backtest 调 summarize）。"""
    buckets: dict[str, list[dict[str, Any]]] = {t: [] for t in _TIER_ORDER}
    for it in items:
        conf = it.get("confluence")
        tier = str(conf.get("tier") if isinstance(conf, dict) else "C").upper()
        if tier not in buckets:
            tier = "C"
        buckets[tier].append(it)
    return [{"tier": t, "count": len(buckets[t])} for t in _TIER_ORDER if buckets[t]]
