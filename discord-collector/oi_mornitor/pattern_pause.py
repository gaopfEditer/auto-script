"""形态暂停与 4h 环境闸：默认停用原版二次探底 / 射击之星的实盘推送与默认回测交易。

可通过 env 重新打开供研究。过滤假设（如下跌趋势禁止底部直接做多）同样可开关，默认开。
这些是待验证的假设，不是已证明有效的规则。
"""
from __future__ import annotations

from typing import Any, Iterable

from oi_mornitor.env_parse import env_bool

# 默认暂停：原版底部二次探底、原版射击之星（含连续走平）。
OI_PAUSE_BOTTOM_SECONDARY = env_bool("OI_PAUSE_BOTTOM_SECONDARY", True)
OI_PAUSE_SHOOTING_STAR = env_bool("OI_PAUSE_SHOOTING_STAR", True)
# 假设闸：4h 明显下降趋势时禁止底部形态直接做多（仅在二次探底被研究重开时生效；默认 ON）。
OI_BOTTOM_4H_DOWNTREND_FORBID_LONG = env_bool("OI_BOTTOM_4H_DOWNTREND_FORBID_LONG", True)

PAUSED_BOTTOM_KINDS = frozenset({"bottom_secondary_test"})
PAUSED_SHOOT_KINDS = frozenset({"shooting_star", "consecutive_flat_shooting_star"})

PAUSED_BOTTOM_LABELS = frozenset({"底部二次探底确认"})
PAUSED_SHOOT_LABELS = frozenset({"射击之星", "连续走平射击之星"})

# 头肩顶：保留但不主动调参（仅标记）。
OBSERVATION_ONLY_KINDS = frozenset({"m_top_vegas_break"})  # M顶样本不足，观察
RESEARCH_KINDS = frozenset({"liquidity_sweep"})  # 保留研究，严格版见独立策略


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
    """假设闸：4h 明显下降趋势时禁止底部直接做多。"""
    if not OI_BOTTOM_4H_DOWNTREND_FORBID_LONG:
        return False
    r = str(regime_4h or "").strip().lower()
    return r in ("trend_down", "downtrend", "down")
