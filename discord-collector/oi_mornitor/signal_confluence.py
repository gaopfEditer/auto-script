"""形态信号综合共振分（列表展示 / 入库标签；非自动下单）。

维度：形态族权重 + 周期 + 多周期共振 + 来源质量 + 已知高胜率组合加成。
"""
from __future__ import annotations

from typing import Any

from oi_mornitor.main_card_policy import is_main_card_symbol
from oi_mornitor.pattern_mtf_resonance import mtf_resonance_family

_TIER_ORDER = ("A", "B", "C", "D")

# 形态族基础分（单信号强度）
_FAMILY_BASE: dict[str, int] = {
    "reversal": 28,  # 结构二次探底 / 顶部结构
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

# 命名组合（命中则写入 combos[]，并额外加分）
_COMBO_RULES: tuple[tuple[str, str, int], ...] = (
    (
        "结构反转·高周期",
        "reversal + interval∈{1h,4h}",
        12,
    ),
    (
        "结构·双周期共振",
        "reversal + mtf≥2",
        14,
    ),
    (
        "结构·三周期共振",
        "reversal + mtf=3",
        22,
    ),
    (
        "蜡烛形态·双周期共振",
        "shooting_star|inverted_hammer + mtf≥2",
        16,
    ),
    (
        "量价确认·共振",
        "vp_confirm + mtf≥2",
        18,
    ),
    (
        "量价确认·三周期",
        "vp_confirm + mtf=3",
        26,
    ),
    (
        "主流币精选",
        "is_main_card_symbol",
        8,
    ),
)


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


def _tier_from_score(score: int) -> str:
    if score >= 78:
        return "A"
    if score >= 58:
        return "B"
    if score >= 40:
        return "C"
    return "D"


def _mtf_tiers(rec: dict[str, Any]) -> int:
    mtf = rec.get("mtfResonance")
    if not isinstance(mtf, dict):
        return 0
    try:
        return int(mtf.get("tiers") or 0)
    except (TypeError, ValueError):
        return 0


def compute_signal_confluence(rec: dict[str, Any]) -> dict[str, Any]:
    """返回 { score, tier, reasons[], combos[], family }。"""
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

    # —— 命名组合（与 _COMBO_RULES 说明对齐）——
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

    # 孤立 15m 量价确认：封顶 C，避免误读为高置信
    if fam == "vp_confirm" and iv == "15m" and mtf_n < 2:
        score = min(score, 38)
        reasons.append("单周期15m量价确认封顶")

    if fam == "vp_thrust" and mtf_n < 2:
        score = min(score, 45)

    score = max(0, min(100, score))
    tier = _tier_from_score(score)

    action_hint = {
        "A": "可重点跟单 / 入库统计",
        "B": "需结合盘面；建议仅 MAIN 或共振",
        "C": "观察或缩小仓位",
        "D": "默认忽略（噪声或孤立15m量价）",
    }.get(tier, "")

    return {
        "score": score,
        "tier": tier,
        "family": fam,
        "reasons": reasons[:12],
        "combos": combos,
        "actionHint": action_hint,
    }


def attach_signal_confluence(records: list[dict[str, Any]]) -> None:
    """就地写入 confluence 字段（需先 attach_mtf_resonance）。"""
    for r in records:
        if not isinstance(r, dict):
            continue
        r["confluence"] = compute_signal_confluence(r)


_TIER_RANK: dict[str, int] = {"A": 4, "B": 3, "C": 2, "D": 1}


def tier_meets_minimum(tier: str | None, minimum: str | None) -> bool:
    """minimum 为 all 时不筛；B 表示 B 及以上（含 A）。"""
    min_t = str(minimum or "all").strip().upper()
    if not min_t or min_t == "ALL":
        return True
    got = str(tier or "D").strip().upper()
    need = _TIER_RANK.get(min_t, 0)
    return _TIER_RANK.get(got, 0) >= need


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


def attach_confluence_to_backtest_items(items: list[dict[str, Any]]) -> None:
    """回测明细：先 MTF 共振，再综合分（与形态信号列表同口径）。"""
    from oi_mornitor.pattern_mtf_resonance import attach_mtf_resonance

    if not items:
        return
    records = [_backtest_item_to_confluence_record(it) for it in items if isinstance(it, dict)]
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
                if str((it.get("confluence") or {}).get("tier") or "D").upper() == "D"
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


def summarize_by_confluence_tier(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按 A/B/C/D 分桶计数（不含胜率，由 structure_backtest 调 summarize）。"""
    buckets: dict[str, list[dict[str, Any]]] = {t: [] for t in _TIER_ORDER}
    for it in items:
        conf = it.get("confluence")
        tier = str(conf.get("tier") if isinstance(conf, dict) else "D").upper()
        if tier not in buckets:
            tier = "D"
        buckets[tier].append(it)
    return [{"tier": t, "count": len(buckets[t])} for t in _TIER_ORDER if buckets[t]]
