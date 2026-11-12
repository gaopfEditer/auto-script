"""形态暂停与环境闸：默认停用原版二次探底 / 射击之星的实盘推送与默认回测交易。

可通过 env 重新打开供研究。打开后仍可走情境闸（可 env 开关）：
  放行 ⟺ 方向尚未被反向收盘突破  OR  大周期已出现同向反转

旧的「4h 下跌一律禁止底部做多」默认开，在二次探底被研究重开时生效。
这些是待验证的假设，不是已证明有效的规则。
"""
from __future__ import annotations

from typing import Any, Iterable

import pandas as pd

from oi_mornitor.env_parse import env_bool

# 默认暂停：原版底部二次探底、原版射击之星（含连续走平）。
OI_PAUSE_BOTTOM_SECONDARY = env_bool("OI_PAUSE_BOTTOM_SECONDARY", True)
OI_PAUSE_SHOOTING_STAR = env_bool("OI_PAUSE_SHOOTING_STAR", True)
# 假设闸：4h 明显下降趋势时禁止底部形态直接做多（仅在二次探底被研究重开时生效；默认 ON）。
OI_BOTTOM_4H_DOWNTREND_FORBID_LONG = env_bool("OI_BOTTOM_4H_DOWNTREND_FORBID_LONG", True)
# 情境闸：方向未破 OR 大周期已反转（默认开）。
OI_REQUIRE_DIRECTION_OR_HTF_REVERSAL = env_bool("OI_REQUIRE_DIRECTION_OR_HTF_REVERSAL", True)

PAUSED_BOTTOM_KINDS = frozenset({"bottom_secondary_test"})
PAUSED_SHOOT_KINDS = frozenset({"shooting_star", "consecutive_flat_shooting_star"})

PAUSED_BOTTOM_LABELS = frozenset({"底部二次探底确认"})
PAUSED_SHOOT_LABELS = frozenset({"射击之星", "连续走平射击之星"})

# 头肩顶：保留但不主动调参（仅标记）。
OBSERVATION_ONLY_KINDS = frozenset({"m_top_vegas_break"})  # M顶样本不足，观察
RESEARCH_KINDS = frozenset({"liquidity_sweep"})  # 保留研究，严格版见独立策略

# 需情境闸的形态
CONTEXT_GATED_KINDS = frozenset(
    {"bottom_secondary_test", "shooting_star", "consecutive_flat_shooting_star"}
)


def paused_kinds(*, bottom: bool | None = None, shoot: bool | None = None) -> frozenset[str]:
    out: set[str] = set()
    if (OI_PAUSE_BOTTOM_SECONDARY if bottom is None else bottom):
        out |= set(PAUSED_BOTTOM_KINDS)
    if (OI_PAUSE_SHOOTING_STAR if shoot is None else shoot):
        out |= set(PAUSED_SHOOT_KINDS)
    return frozenset(out)


def is_paused_kind(kind: str, *, bottom: bool | None = None, shoot: bool | None = None) -> bool:
    return str(kind or "").strip() in paused_kinds(bottom=bottom, shoot=shoot)


def is_paused_label(label: str, *, bottom: bool | None = None, shoot: bool | None = None) -> bool:
    lab = str(label or "").strip()
    if not lab:
        return False
    if (OI_PAUSE_BOTTOM_SECONDARY if bottom is None else bottom) and (
        lab in PAUSED_BOTTOM_LABELS or "二次探底" in lab
    ):
        return True
    if (OI_PAUSE_SHOOTING_STAR if shoot is None else shoot) and (
        lab in PAUSED_SHOOT_LABELS or lab.startswith("射击之星")
    ):
        return True
    return False


def is_paused_alert(alert: dict[str, Any] | None) -> bool:
    if not isinstance(alert, dict):
        return False
    kind = str(alert.get("kind") or alert.get("signal_kind") or "").strip()
    if is_paused_kind(kind):
        return True
    lab = str(
        alert.get("type_label")
        or alert.get("typeLabel")
        or alert.get("signal_text")
        or alert.get("message")
        or ""
    )
    return is_paused_label(lab)


def default_trade_kinds(all_ids: Iterable[str]) -> list[str]:
    """默认结构回测交易集合：剔除已暂停形态（研究时可在请求里显式勾选）。"""
    paused = paused_kinds()
    return [str(k) for k in all_ids if str(k) not in paused]


def kind_option_meta(kind_id: str, label: str, side: str) -> dict[str, Any]:
    paused = is_paused_kind(kind_id) or is_paused_label(label)
    meta: dict[str, Any] = {"id": kind_id, "label": label, "side": side, "paused": paused}
    if paused:
        meta["pausedReason"] = "已暂停原版（研究可勾选重开）"
        meta["grade"] = "paused"
    elif kind_id in CONTEXT_GATED_KINDS:
        meta["grade"] = "context_gated"
        meta["gradeLabel"] = "情境闸：方向未破或大周期已反转"
        meta["contextGate"] = "direction_intact_or_htf_reversal"
    elif kind_id in OBSERVATION_ONLY_KINDS:
        meta["grade"] = "observation"
        meta["gradeLabel"] = "观察（样本不足）"
    elif kind_id in RESEARCH_KINDS:
        meta["grade"] = "research"
        meta["gradeLabel"] = "保留研究"
    elif kind_id == "hs_vegas_break":
        meta["grade"] = "hold"
        meta["gradeLabel"] = "保留，不主动调参"
    else:
        meta["grade"] = "active"
    return meta


def bottom_long_forbidden_by_4h_downtrend(regime_4h: str | None) -> bool:
    """假设闸：4h 明显下降趋势时禁止底部直接做多（默认开；暂停期间不生效）。"""
    if not OI_BOTTOM_4H_DOWNTREND_FORBID_LONG:
        return False
    r = str(regime_4h or "").strip().lower()
    return r in ("trend_down", "downtrend", "down")


def _is_long_side(side: str) -> bool:
    s = str(side or "").strip().lower()
    return s in ("bull", "long", "多", "buy")


def adverse_direction_broken(
    df: pd.DataFrame,
    *,
    bar_idx: int,
    side: str,
) -> bool:
    """反向收盘突破（BOS）是否已发生：多看跌破摆动低，空看涨破摆动高。"""
    from oi_mornitor.market_regime import bos_by_close

    if _is_long_side(side):
        return bos_by_close(df, bar_idx=bar_idx, side="short")
    return bos_by_close(df, bar_idx=bar_idx, side="long")


def htf_already_reversed(
    df_htf: pd.DataFrame | None,
    *,
    htf_idx: int | None,
    side: str,
) -> bool:
    """大周期已同向反转：趋势标签同向，或相对前趋势出现 CHoCH。"""
    if df_htf is None or htf_idx is None or htf_idx < 0 or len(df_htf) == 0:
        return False
    from oi_mornitor.market_regime import choch_by_close, classify_trend_regime

    idx = min(int(htf_idx), len(df_htf) - 1)
    r = classify_trend_regime(df_htf, end_idx=idx, tf="4h")
    long = _is_long_side(side)
    if long and r.label == "trend_up":
        return True
    if (not long) and r.label == "trend_down":
        return True
    # CHoCH：相对反向趋势的结构转变
    prior = "down" if long else "up"
    if choch_by_close(df_htf, bar_idx=idx, prior_trend=prior):
        return True
    return False


def passes_direction_or_htf_reversal(
    *,
    side: str,
    df_signal: pd.DataFrame,
    bar_idx: int,
    df_htf: pd.DataFrame | None = None,
    htf_idx: int | None = None,
    enabled: bool | None = None,
) -> tuple[bool, str]:
    """放行：方向未破  OR  大周期已反转。返回 (ok, reason)。"""
    use = OI_REQUIRE_DIRECTION_OR_HTF_REVERSAL if enabled is None else bool(enabled)
    if not use:
        return True, "gate_disabled"

    broken = adverse_direction_broken(df_signal, bar_idx=bar_idx, side=side)
    direction_intact = not broken
    htf_rev = htf_already_reversed(df_htf, htf_idx=htf_idx, side=side)

    if direction_intact or htf_rev:
        parts = []
        if direction_intact:
            parts.append("direction_intact")
        if htf_rev:
            parts.append("htf_reversed")
        return True, "+".join(parts) if parts else "ok"

    return False, "adverse_bos_and_no_htf_reversal"


def needs_direction_or_htf_gate(kind: str) -> bool:
    return str(kind or "").strip() in CONTEXT_GATED_KINDS


def align_htf_index(df_htf: pd.DataFrame | None, signal_open_ms: int) -> int | None:
    """取 open_time <= 信号开盘的最后一根大周期 K（位置下标）。"""
    if df_htf is None or len(df_htf) == 0 or "open_time" not in df_htf.columns:
        return None
    times = df_htf["open_time"].astype("int64").tolist()
    target = int(signal_open_ms)
    best = None
    for i, t in enumerate(times):
        if int(t) <= target:
            best = i
        else:
            break
    return best
