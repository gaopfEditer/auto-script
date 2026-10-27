"""潜力发现 · 方向推断与综合评分说明。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.potential_model_eval import MODEL_LABELS, ModelResult

STAGE_CN: dict[str, str] = {
    "watch": "观察",
    "primed": "就绪",
    "triggered": "已触发",
    "exiting": "衰竭/了结",
}

DIRECTION_LABEL: dict[str, str] = {
    "long": "看多",
    "short": "看空",
    "neutral": "观望",
}


def direction_label(direction: str) -> str:
    return DIRECTION_LABEL.get(str(direction or "").strip().lower(), "观望")


def infer_direction(r: ModelResult) -> str:
    """交易叙事方向（非保证盈利）。"""
    mid = r.model_id
    m = r.metrics or {}
    if mid == "liquidity_sweep":
        side = str(m.get("sweep_side") or "").lower()
        if side == "high":
            return "short"
        if side == "low":
            return "long"
        if r.hit and float(r.score) >= 45:
            return "neutral"
        return "neutral"
    if mid in (
        "quiet_oi_breakout",
        "short_squeeze",
        "relative_strength",
        "wyckoff_spring",
    ):
        if r.stage == "exiting" and r.exit:
            return "neutral"
        return "long"
    return "neutral"


def _pct(v: Any, *, digits: int = 0) -> str | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if digits == 0:
        return f"{x:+.0%}"
    return f"{x:+.1%}"


def _num(v: Any, *, digits: int = 2) -> str | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return f"{x:.{digits}f}"


def model_score_reasons(r: ModelResult) -> list[str]:
    """单模型得分与因子说明（供列表展示）。"""
    mid = r.model_id
    m = r.metrics or {}
    lines: list[str] = [
        f"得分 {int(round(r.score))}/100 · 阶段 {STAGE_CN.get(r.stage, r.stage)} · {direction_label(infer_direction(r))}",
    ]

    if mid == "short_squeeze":
        fm = m.get("funding_mean_3")
        fr = m.get("funding_rate")
        rate = fm if fm is not None else fr
        if rate is not None:
            lines.append(f"资金费率 {float(rate):.2%}（深度负费率 → 空头支付、轧空叙事偏多）")
        oi1 = _pct(m.get("oi_change_1d_pct"))
        if oi1:
            lines.append(f"OI 1 日 {oi1}（持仓变化，配合抗跌则加分）")
        prem = m.get("spot_premium")
        if prem is not None:
            lines.append(f"现货溢价 {float(prem):+.2%}（偏正则现货偏强）")
    elif mid == "quiet_oi_breakout":
        oq = m.get("oi_quiet_ratio")
        if oq is not None:
            lines.append(f"OI 沉寂比 {float(oq):.2f}（越低表示长期 OI 低位）")
        oi7 = _pct(m.get("oi_change_7d_pct"))
        oi14 = _pct(m.get("oi_change_14d_pct"))
        if oi7 or oi14:
            lines.append(f"OI 抬升 7d/14d {oi7 or '—'}/{oi14 or '—'}")
        vr = _num(m.get("volume_ratio"))
        if vr:
            lines.append(f"量比 {vr}×MA20（温和放量加分，突破放量更高）")
        atr_p = m.get("atr_pctile")
        if atr_p is not None:
            lines.append(f"ATR 分位 {float(atr_p):.0%}（波动收敛加分）")
    elif mid == "relative_strength":
        vs = _pct(m.get("vs_btc_pct"), digits=1)
        if vs:
            lines.append(f"相对 BTC {vs}（弱市抗跌/强市领先）")
        regime = m.get("btc_regime")
        if regime:
            lines.append(f"BTC 环境 {regime}")
        vr = _num(m.get("volume_ratio"))
        if vr:
            lines.append(f"突破量比 {vr}×")
    elif mid == "wyckoff_spring":
        rw = m.get("range_width_pct")
        if rw is not None:
            lines.append(f"箱体宽度 {float(rw):.1%}")
        sd = m.get("spring_depth_pct")
        if sd is not None:
            lines.append(f"Spring 深度 {float(sd):.2%}")
        rb = m.get("spring_reclaim_bars")
        if rb is not None:
            lines.append(f"收回用时 {int(rb)} 根 K")
    elif mid == "liquidity_sweep":
        side = str(m.get("sweep_side") or "")
        if side == "high":
            lines.append("扫上方流动性后收回 → 叙事偏空")
        elif side == "low":
            lines.append("扫下方流动性后收回 → 叙事偏多")
        lv = m.get("level")
        if lv is not None:
            lines.append(f"关键位 {float(lv):.6g}")

    if r.stage == "exiting" and r.exit:
        lines.append(f"衰竭：{r.exit[:80]}")
    elif r.entry:
        lines.append(r.entry[:100])

    return lines[:6]


def finalize_model_result(r: ModelResult) -> ModelResult:
    d = infer_direction(r)
    r.direction = d
    r.score_reasons = model_score_reasons(r)
    return r


def composite_score_breakdown(valid: list[ModelResult], composite: float) -> dict[str, Any]:
    if not valid:
        return {
            "direction": "neutral",
            "direction_label": direction_label("neutral"),
            "score_summary": "",
            "score_reasons": [],
        }
    scores = [float(r.score) for r in valid]
    max_s = max(scores)
    bonus = 5.0 * (len(valid) - 1)
    best = max(valid, key=lambda r: r.score)
    direction = infer_direction(best)
    long_n = sum(1 for r in valid if infer_direction(r) == "long")
    short_n = sum(1 for r in valid if infer_direction(r) == "short")
    if long_n and short_n:
        direction = infer_direction(best)
    elif long_n and not short_n:
        direction = "long"
    elif short_n and not long_n:
        direction = "short"

    summary_parts = [f"综合 {int(round(composite))} 分"]
    summary_parts.append(f"= 最高单模型 {int(round(max_s))} 分（{best.label or MODEL_LABELS.get(best.model_id, best.model_id)}）")
    if len(valid) > 1:
        summary_parts.append(f"+ 多模型共振 {len(valid)} 个（每个 +5，上限 100）→ +{int(bonus)}")
    summary = " ".join(summary_parts)

    reasons: list[str] = [summary, f"主方向：{direction_label(direction)}（由最高分模型 {best.label} 主导）"]
    for r in sorted(valid, key=lambda x: -float(x.score)):
        tag = direction_label(infer_direction(r))
        reasons.append(f"— {r.label} [{tag}] {int(round(r.score))} 分")
        for line in model_score_reasons(r)[1:4]:
            reasons.append(f"   · {line}")

    return {
        "direction": direction,
        "direction_label": direction_label(direction),
        "score_summary": summary,
        "score_reasons": reasons[:14],
        "max_model_score": int(round(max_s)),
        "resonance_bonus": int(bonus),
        "model_count": len(valid),
    }
