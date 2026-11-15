"""V2 入场质量闸：多周期共振 OR 综合评分 ≥ 最低档（默认 B）。

口径对齐形态列表常用筛选（MTF / 综合评分 A–D），但在 K 线回测里用
15m/1h/4h 结构同向作「多周期共振」，并用可解释加分映射到 A/B/C，
不把人工分当胜率。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from oi_mornitor.signal_confluence import tier_from_percentile_score, tier_meets_minimum
from oi_mornitor.strategy.short_term_v2.common import BarContext
from oi_mornitor.strategy.short_term_v2.metrics import bar_ts, get_indicator_cache, rvol_at
from oi_mornitor.strategy.short_term_v2.params import tier_param
from oi_mornitor.strategy.short_term_v2.signal import V2Signal

DEFAULT_MIN_SCORE_TIER = "B"
DEFAULT_GATE_MODE = "and"  # 15m 机会 + 多周期共振 + 评分≥档；可选 or
GATE_MODES = ("and", "or")
_TF_LOOKBACK = 20


@dataclass
class QualityAssessment:
    ok: bool
    mtf_resonance: bool
    score: int
    score_tier: str
    aligned_tfs: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    gate_mode: str = "mtf_and_score_ge_b"
    setup_tf: str = "15m"

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "mtfResonance": self.mtf_resonance,
            "score": self.score,
            "scoreTier": self.score_tier,
            "alignedTfs": list(self.aligned_tfs),
            "reasons": list(self.reasons),
            "gateMode": self.gate_mode,
            "setupTf": self.setup_tf,
        }


def _align_idx(df, ts: int | None) -> int | None:
    if df is None or len(df) < _TF_LOOKBACK + 1 or ts is None:
        return None
    cache = get_indicator_cache(df)
    if cache and "open_time" in cache and len(cache["open_time"]):
        times = np.asarray(cache["open_time"], dtype=np.int64)
    else:
        times = df["open_time"].astype("int64").to_numpy()
        if times.size and int(times[-1]) < 1e12 and ts > 1e12:
            times = times * 1000
    j = int(np.searchsorted(times, int(ts), side="right") - 1)
    if j < _TF_LOOKBACK:
        return None
    return j


def _tf_bias(df, j: int) -> str | None:
    """相对近 lookback 高低中轴的方向偏置。"""
    if df is None or j is None or j < _TF_LOOKBACK:
        return None
    cache = get_indicator_cache(df)
    if cache and "high" in cache and "low" in cache and "close" in cache:
        hi = float(np.max(cache["high"][j - _TF_LOOKBACK : j]))
        lo = float(np.min(cache["low"][j - _TF_LOOKBACK : j]))
        c = float(cache["close"][j])
    else:
        hi = float(df["high"].iloc[j - _TF_LOOKBACK : j].astype(float).max())
        lo = float(df["low"].iloc[j - _TF_LOOKBACK : j].astype(float).min())
        c = float(df.iloc[j]["close"])
    mid = (hi + lo) / 2.0
    if c > mid:
        return "long"
    if c < mid:
        return "short"
    return None


def mtf_alignment(ctx: BarContext, direction: str) -> tuple[bool, list[str], list[str]]:
    """返回 (是否多周期共振, 同向周期列表, 说明)。

    与 V1 周期栈对齐：4H 环境 · 1H 结构 · 15M 机会。
    「多周期共振」= **1H 与 4H 均同向**（15m 只作机会形成，单独 +1H 不算共振，
    否则 S01 自带 1H 偏置会让 OR 闸几乎永真）。
    若缺 4H 数据：退化为 15m+1H 同向，并标记 soft。
    """
    side = str(direction or "").lower()
    if side not in ("long", "short"):
        return False, [], ["无方向，无法判共振"]
    ts = ctx.ts()
    aligned: list[str] = []
    notes: list[str] = []

    # 15m：当前根（记录，但不单独构成共振）
    b15 = _tf_bias(ctx.df_15m, ctx.idx)
    if b15 == side:
        aligned.append("15m")
        notes.append("15m同向")
    elif b15:
        notes.append(f"15m偏{b15}")

    j1 = _align_idx(ctx.df_1h, ts)
    b1 = _tf_bias(ctx.df_1h, j1) if j1 is not None else None
    if b1 == side:
        aligned.append("1h")
        notes.append("1h同向")
    elif b1:
        notes.append(f"1h偏{b1}")
    elif ctx.df_1h is None or len(ctx.df_1h) == 0:
        notes.append("1h缺失")

    has_4h = ctx.df_4h is not None and len(ctx.df_4h) > 0
    j4 = _align_idx(ctx.df_4h, ts) if has_4h else None
    b4 = _tf_bias(ctx.df_4h, j4) if j4 is not None else None
    if b4 == side:
        aligned.append("4h")
        notes.append("4h同向")
    elif b4:
        notes.append(f"4h偏{b4}")
    elif not has_4h:
        notes.append("4h缺失")

    if has_4h:
        ok = ("1h" in aligned) and ("4h" in aligned)
        if ok:
            notes.insert(0, f"多周期共振(1h+4h{';+15m' if '15m' in aligned else ''})")
        else:
            notes.insert(0, "未达共振(需1h+4h同向)")
    else:
        # 无 4h：退化为机会+结构双周期
        ok = ("15m" in aligned) and ("1h" in aligned)
        if ok:
            notes.insert(0, "多周期共振(soft:15m+1h，无4h)")
        else:
            notes.insert(0, "未达共振(无4h且15m+1h未齐)")
    return ok, aligned, notes


def score_signal(
    ctx: BarContext,
    sig: V2Signal,
    *,
    aligned_tfs: list[str] | None = None,
) -> tuple[int, str, list[str]]:
    """可解释加分 → 0–100 → A/B/C/D。

    **故意不含 MTF 加分**：多周期共振是 OR 的另一路；若把同向再计入评分，
    OR 闸会对已有 1H 偏置的 S01 几乎永真。
    档映射复用 confluence：≥80A / ≥60B；<40 → D。
    """
    del aligned_tfs  # 评分侧不使用，避免与 MTF 路重复计分
    reasons: list[str] = []
    # 基础分使「放量+费后RR达标」可摸到 B(60)；单靠基础仍低于 B
    score = 32
    reasons.append("entry_ready基础+32")

    rv = sig.rvol if sig.rvol is not None else rvol_at(ctx.df_15m, ctx.idx)
    thr = tier_param(ctx.market_cap_tier, "rvol_15m")
    if rv is not None and rv >= thr:
        bonus = 20 if rv >= thr * 1.5 else 14
        score += bonus
        reasons.append(f"RVOL={rv:.2f}+{bonus}")
    elif rv is not None:
        reasons.append(f"RVOL={rv:.2f}未达阈")

    oi = sig.oi_change_pct
    if oi is not None and abs(oi) >= tier_param(ctx.market_cap_tier, "oi_15m_pct"):
        score += 12
        reasons.append(f"OIΔ={oi:.2f}%+12")

    rr = (sig.data_flags or {}).get("rr_after_cost")
    if rr is not None:
        try:
            rr_f = float(rr)
            if rr_f >= 2.0:
                score += 18
                reasons.append(f"RR={rr_f:.2f}+18")
            elif rr_f >= 1.5:
                score += 12
                reasons.append(f"RR={rr_f:.2f}+12")
            elif rr_f >= 1.0:
                score += 6
                reasons.append(f"RR={rr_f:.2f}+6")
        except (TypeError, ValueError):
            pass

    chase = (sig.data_flags or {}).get("chase_atr")
    if chase is not None:
        try:
            ch = float(chase)
            if ch <= 0.5:
                score += 8
                reasons.append(f"追价近+8({ch:.2f}ATR)")
            elif ch > 0.85:
                score -= 6
                reasons.append(f"追价偏远-6({ch:.2f}ATR)")
        except (TypeError, ValueError):
            pass

    if ctx.market_cap_tier == 3:
        score -= 6
        reasons.append("T3-6")

    score = int(max(0, min(100, score)))
    tier = tier_from_percentile_score(score)
    if score < 40:
        tier = "D"
    reasons.append(f"→{score}({tier})")
    return score, tier, reasons


def assess_quality(
    ctx: BarContext,
    sig: V2Signal,
    *,
    min_score_tier: str = DEFAULT_MIN_SCORE_TIER,
    gate_mode: str = DEFAULT_GATE_MODE,
) -> QualityAssessment:
    mode = str(gate_mode or DEFAULT_GATE_MODE).strip().lower()
    if mode not in GATE_MODES:
        mode = DEFAULT_GATE_MODE
    mtf_ok, aligned, mtf_notes = mtf_alignment(ctx, sig.direction or "")
    score, tier, score_notes = score_signal(ctx, sig, aligned_tfs=aligned)
    score_ok = tier_meets_minimum(tier, min_score_tier)
    # 15m 为机会形成周期（扫描主周期）；共振看 1h+4h
    setup_ok = ctx.df_15m is not None and len(ctx.df_15m) > 0 and 0 <= ctx.idx < len(ctx.df_15m)
    if mode == "and":
        ok = bool(setup_ok and mtf_ok and score_ok)
        mode_label = f"15m + 多周期共振 AND 评分≥{str(min_score_tier).upper()}"
        gate_key = f"mtf_and_score_ge_{str(min_score_tier).lower()}"
    else:
        ok = bool(setup_ok and (mtf_ok or score_ok))
        mode_label = f"15m + (多周期共振 OR 评分≥{str(min_score_tier).upper()})"
        gate_key = f"mtf_or_score_ge_{str(min_score_tier).lower()}"
    reasons = [
        f"闸={mode_label}",
        f"setupTf=15m({'Y' if setup_ok else 'N'})",
        *mtf_notes,
        *score_notes,
        "通过" if ok else "未通过",
    ]
    return QualityAssessment(
        ok=ok,
        mtf_resonance=mtf_ok,
        score=score,
        score_tier=tier,
        aligned_tfs=aligned,
        reasons=reasons,
        gate_mode=gate_key,
        setup_tf="15m",
    )


def apply_quality_gate(
    ctx: BarContext,
    signals: list[V2Signal],
    *,
    enabled: bool = True,
    min_score_tier: str = DEFAULT_MIN_SCORE_TIER,
    gate_mode: str = DEFAULT_GATE_MODE,
) -> list[V2Signal]:
    """对 entry_ready 做闸；未过则降为 skipped（保留证据）。observe/skip 不动。"""
    if not enabled:
        return signals
    out: list[V2Signal] = []
    for s in signals:
        if s.status != "entry_ready":
            out.append(s)
            continue
        qa = assess_quality(ctx, s, min_score_tier=min_score_tier, gate_mode=gate_mode)
        s.data_flags = {**(s.data_flags or {}), "qualityGate": qa.to_dict()}
        s.evidence = list(s.evidence or []) + [
            f"质量闸:{'过' if qa.ok else '拒'} mode={qa.gate_mode} "
            f"MTF={'Y' if qa.mtf_resonance else 'N'} 分={qa.score}({qa.score_tier})"
        ]
        if qa.ok:
            out.append(s)
        else:
            s.status = "skipped"
            s.skip_reason = "quality_gate_fail"
            out.append(s)
    return out
