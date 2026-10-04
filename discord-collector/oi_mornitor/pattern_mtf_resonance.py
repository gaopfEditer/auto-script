"""形态信号列表：15m / 1h / 4h 多周期共振（同币、同向、同形态族、时间窗内 ≥2 周期）。"""
from __future__ import annotations

import re
from typing import Any

MTF_RESONANCE_INTERVALS = frozenset({"15m", "1h", "4h"})
MTF_RESONANCE_WINDOW_MS = 4 * 60 * 60 * 1000

_INTERVAL_ORDER = {"15m": 0, "1h": 1, "4h": 2}

_FAMILY_LABELS: dict[str, str] = {
    "shooting_star": "射击之星",
    "inverted_hammer": "倒锤子",
    "vp_thrust": "量价推进",
    "vp_confirm": "量价确认",
    "reversal": "反转",
}

_V_PREFIX_RE = re.compile(r"^V[\+\-]?")


def _norm_label(raw: str) -> str:
    s = str(raw or "").strip()
    for sep in (" · ", "·", "|", "｜"):
        if sep in s:
            s = s.split(sep, 1)[0].strip()
            break
    return s


def mtf_resonance_family(type_label: str, side: str) -> str | None:
    """将 typeLabel 映射为共振形态族；不在白名单则 None。"""
    lab = _norm_label(type_label)
    if not lab or _V_PREFIX_RE.match(lab):
        return None
    if "(oi异动)" in lab or "oi异动" in lab:
        return None
    if "射击之星" in lab:
        if "连续" in lab or "（2）" in lab:
            return None
        return "shooting_star"
    if "倒锤子" in lab:
        return "inverted_hammer"
    if "量价推进" in lab:
        return "vp_thrust"
    if "量价确认" in lab:
        return "vp_confirm"
    reversal_needles = (
        "底部二次探底",
        "二次探底",
        "破底翻",
        "2B",
        "Spring",
        "spring",
        "扫荡",
        "反转",
        "圆弧",
        "顶部结构",
        "头肩",
        "M顶",
        "流动性掠夺",
    )
    if any(x in lab for x in reversal_needles):
        return "reversal"
    return None


def _symbol_key(rec: dict[str, Any]) -> str:
    return str(rec.get("symbol") or "").strip().upper()


def _side_key(rec: dict[str, Any]) -> str:
    side = str(rec.get("side") or "").strip().lower()
    if side in ("long", "short"):
        return side
    d = str(rec.get("dir") or "").strip()
    if d == "多":
        return "long"
    if d == "空":
        return "short"
    return ""


def compute_mtf_resonance_by_key(
    records: list[dict[str, Any]],
    *,
    window_ms: int = MTF_RESONANCE_WINDOW_MS,
) -> dict[str, dict[str, Any]]:
    """对给定记录集计算 key → mtfResonance（仅 eligible 行）。"""
    eligible: list[dict[str, Any]] = []
    for r in records:
        if not isinstance(r, dict):
            continue
        key = str(r.get("key") or "").strip()
        if not key:
            continue
        iv = str(r.get("interval") or "").strip()
        if iv not in MTF_RESONANCE_INTERVALS:
            continue
        side = _side_key(r)
        if side not in ("long", "short"):
            continue
        fam = mtf_resonance_family(str(r.get("typeLabel") or ""), side)
        if not fam:
            continue
        sat = int(r.get("signalAt") or 0)
        if sat <= 0:
            continue
        eligible.append({**r, "_fam": fam, "_side": side, "_sym": _symbol_key(r), "_sat": sat})

    buckets: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for row in eligible:
        bk = (row["_sym"], row["_fam"], row["_side"])
        buckets.setdefault(bk, []).append(row)

    out: dict[str, dict[str, Any]] = {}
    for bucket in buckets.values():
        bucket.sort(key=lambda x: x["_sat"])
        n = len(bucket)
        for i in range(n):
            center = bucket[i]
            lo = center["_sat"] - window_ms
            hi = center["_sat"] + window_ms
            intervals: set[str] = set()
            for j in range(n):
                peer = bucket[j]
                if peer["_sat"] < lo or peer["_sat"] > hi:
                    continue
                iv = str(peer.get("interval") or "").strip()
                if iv in MTF_RESONANCE_INTERVALS:
                    intervals.add(iv)
            if len(intervals) < 2:
                continue
            iv_sorted = sorted(intervals, key=lambda x: _INTERVAL_ORDER.get(x, 99))
            fam = str(center["_fam"])
            out[str(center["key"])] = {
                "tiers": len(iv_sorted),
                "intervals": iv_sorted,
                "family": fam,
                "familyLabel": _FAMILY_LABELS.get(fam, fam),
            }
    return out


def attach_mtf_resonance(records: list[dict[str, Any]]) -> None:
    """就地写入 mtfResonance 字段（无共振则删除旧字段）。"""
    by_key = compute_mtf_resonance_by_key(records)
    for r in records:
        if not isinstance(r, dict):
            continue
        key = str(r.get("key") or "").strip()
        extra = by_key.get(key)
        if extra:
            r["mtfResonance"] = extra
        else:
            r.pop("mtfResonance", None)
