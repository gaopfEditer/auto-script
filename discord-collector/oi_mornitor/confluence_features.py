"""共振分特征提取（校准与实时打分共用口径）。"""
from __future__ import annotations

import re
from typing import Any

from oi_mornitor.main_card_policy import is_main_card_symbol
from oi_mornitor.pattern_mtf_resonance import mtf_resonance_family

_NUM_SUFFIX_RE = re.compile(r"[（(]\s*\d+\s*[)）]\s*$")
_TRAILING_NUM_RE = re.compile(r"\d+$")

# 特征展示名（TG / topFactors）
FEATURE_DISPLAY: dict[str, str] = {
    "combo:结构·双周期共振": "结构双周期",
    "combo:双周期共振": "双周期共振",
    "combo:蜡烛形态·双周期共振": "蜡烛双周期",
    "combo:结构·三周期共振": "结构三周期",
    "combo:量价确认·共振": "量价确认共振",
    "combo:结构反转·高周期": "结构高周期",
    "combo:顶部结构确认": "顶部结构",
    "combo:量价推进·多": "量价推进多",
    "combo:量价推进·空": "量价推进空",
    "combo:主流币精选": "主流币",
    "combo:单周期15m量价确认封顶": "15m量价封顶",
    "family:reversal": "结构反转族",
    "family:vp_thrust": "量价推进",
    "family:vp_confirm": "量价确认",
    "family:inverted_hammer": "倒锤子族",
    "family:shooting_star": "射击之星族",
    "type:倒锤子": "倒锤子",
    "interval:4h": "4h",
    "interval:1h": "1h",
    "interval:15m": "15m",
    "side:long": "多单",
    "side:short": "空单",
    "mcap:t1": "大盘梯队",
    "mcap:t2": "中盘梯队",
    "mcap:t3": "小盘梯队",
    "feat:vol_ratio_high": "放量",
    "feat:vol_ratio_low": "缩量",
    "feat:macd_div": "MACD背离",
    "feat:htf_align": "HTF同向",
    "feat:macro_align": "宏观同向",
    "feat:kol_a": "KOL-A",
    "feat:kol_b": "KOL-B",
    "feat:kol_c": "KOL-C",
}


def normalize_type_label(raw: str) -> str:
    s = str(raw or "").strip()
    for sep in (" · ", "·", "|", "｜"):
        if sep in s:
            s = s.split(sep, 1)[0].strip()
            break
    s = _NUM_SUFFIX_RE.sub("", s).strip()
    s = _TRAILING_NUM_RE.sub("", s).strip()
    return s


def _side(rec: dict[str, Any]) -> str:
    s = str(rec.get("side") or "").lower()
    if s in ("long", "short", "bull", "bear"):
        return "long" if s in ("long", "bull") else "short"
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


def _vol_ratio_bucket(rec: dict[str, Any]) -> str | None:
    vr = rec.get("vol_ratio")
    if vr is None:
        vr = rec.get("volRatio")
    try:
        n = float(vr)
    except (TypeError, ValueError):
        return None
    if n >= 1.35:
        return "high"
    if n > 0 and n < 0.85:
        return "low"
    return None


def _bool_feat(rec: dict[str, Any], *keys: str) -> bool:
    for k in keys:
        v = rec.get(k)
        if v is True:
            return True
        if isinstance(v, str) and v.strip().lower() in ("1", "true", "yes", "on"):
            return True
    return False


def _kol_tier(rec: dict[str, Any]) -> str | None:
    raw = rec.get("kol_tier") or rec.get("kolTier") or rec.get("source_kol_tier")
    s = str(raw or "").strip().upper()
    if s in ("A", "B", "C"):
        return s
    return None


def derive_combos(rec: dict[str, Any], fam: str | None, mtf_n: int, iv: str, side: str) -> list[str]:
    """命名组合（结构/蜡烛共振分开）。"""
    combos: list[str] = []
    sym = str(rec.get("tradeSymbol") or rec.get("symbol") or "")
    if is_main_card_symbol(sym):
        combos.append("主流币精选")
    if fam == "reversal" and iv in ("1h", "4h"):
        combos.append("结构反转·高周期")
    if fam == "reversal" and mtf_n >= 2:
        combos.append("结构·双周期共振")
    if fam == "reversal" and mtf_n >= 3:
        combos.append("结构·三周期共振")
    if fam in ("shooting_star", "inverted_hammer") and mtf_n >= 2:
        combos.append("蜡烛形态·双周期共振")
    if fam == "vp_confirm" and mtf_n >= 2:
        combos.append("量价确认·共振")
    if mtf_n >= 2:
        combos.append("双周期共振")
    if mtf_n >= 3 and fam == "vp_confirm":
        combos.append("量价确认·三周期")
    lab = normalize_type_label(str(rec.get("typeLabel") or rec.get("type_label") or ""))
    if "顶部结构" in lab or str(rec.get("pattern_label") or "").find("顶部") >= 0:
        combos.append("顶部结构确认")
    if fam == "vp_thrust" and side == "long":
        combos.append("量价推进·多")
    if fam == "vp_thrust" and side == "short":
        combos.append("量价推进·空")
    if fam == "vp_confirm" and iv == "15m" and mtf_n < 2:
        combos.append("单周期15m量价确认封顶")
    return combos


def extract_confluence_features(rec: dict[str, Any]) -> set[str]:
    """返回激活的特征键集合（用于加权求和）。"""
    lab_raw = str(rec.get("typeLabel") or rec.get("type_label") or "").strip()
    lab = normalize_type_label(lab_raw)
    side = _side(rec)
    iv = str(rec.get("interval") or "").strip()
    fam = mtf_resonance_family(lab_raw, side) if lab_raw else None
    mtf_n = _mtf_tiers(rec)

    feats: set[str] = set()
    if lab:
        feats.add(f"label:{lab}")
        if iv:
            feats.add(f"label_iv:{lab}|{iv}")
    if iv:
        feats.add(f"interval:{iv}")
    if side in ("long", "short"):
        feats.add(f"side:{side}")
    if fam:
        feats.add(f"family:{fam}")
    mcap = str(rec.get("mcapTier") or "t3").strip().lower()
    if mcap in ("t1", "t2", "t3"):
        feats.add(f"mcap:{mcap}")

    if "倒锤子" in lab:
        feats.add("type:倒锤子")

    for combo in derive_combos(rec, fam, mtf_n, iv, side):
        feats.add(f"combo:{combo}")

    vb = _vol_ratio_bucket(rec)
    if vb == "high":
        feats.add("feat:vol_ratio_high")
    elif vb == "low":
        feats.add("feat:vol_ratio_low")
    if _bool_feat(rec, "macd_divergence", "macdDivergence", "macd_div"):
        feats.add("feat:macd_div")
    if _bool_feat(rec, "htf_trend_aligned", "htfTrendAligned", "htf_align"):
        feats.add("feat:htf_align")
    if _bool_feat(rec, "macro_morning_aligned", "btcMorningAligned", "qqqMorningAligned"):
        feats.add("feat:macro_align")
    kol = _kol_tier(rec)
    if kol == "A":
        feats.add("feat:kol_a")
    elif kol == "B":
        feats.add("feat:kol_b")
    elif kol == "C":
        feats.add("feat:kol_c")

    return feats


def feature_display_name(key: str) -> str:
    if key in FEATURE_DISPLAY:
        return FEATURE_DISPLAY[key]
    if key.startswith("label:"):
        return key[6:][:12]
    if key.startswith("combo:"):
        return key[6:][:14]
    if key.startswith("family:"):
        return FEATURE_DISPLAY.get(key, key[7:])
    return key.split(":", 1)[-1][:14]
