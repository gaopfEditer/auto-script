"""形态信号列表 / 卡片 / 胜率库 共用推送策略（2026-09 优化）。"""
from __future__ import annotations

import re
from typing import Any

# —— 停推：OI 异动反转、V 前缀、连续插针、二次射击之星 ——
_BLOCKED_LABEL_SUBSTR = (
    "(oi异动)",
    "oi异动",
    "连续上插针",
    "连续下插针",
    "非上轨连续上插针",
    "非下轨连续下插针",
)

_BLOCKED_LABEL_EXACT = frozenset(
    {
        "射击之星（2）",
        "量价推进·空",
        "量价推进-空",
    }
)

_BLOCKED_ALERT_TYPES = frozenset(
    {
        "candle_pattern_oi",
        "oi_anomaly",
    }
)

_V_PREFIX_RE = re.compile(r"^V[\+\-]?")

# 圆弧顶样本薄，不进自动卡片/列表
_BLOCKED_STRUCTURE_KINDS = frozenset({"curvature_decay"})

# 形态信号列表已停用周期（不入库 / 不扫描 / 不结算）
PATTERN_DISABLED_INTERVALS = frozenset({"30m", "30min"})


def is_disabled_pattern_interval(interval: str | None) -> bool:
    return str(interval or "").strip().lower() in PATTERN_DISABLED_INTERVALS


def filter_active_intervals(
    intervals: tuple[str, ...] | list[str],
) -> tuple[str, ...]:
    return tuple(x for x in intervals if not is_disabled_pattern_interval(x))


def normalize_type_label(raw: str) -> str:
    s = str(raw or "").strip()
    for sep in (" · ", "·", "|"):
        if sep in s:
            s = s.split(sep)[0].strip()
    return s


def is_blocked_marker_text(text: str) -> bool:
    """图表 marker 文案：停推类仍可在图上标注，但部分完全屏蔽。"""
    s = str(text or "").strip()
    if not s:
        return False
    if any(x in s for x in _BLOCKED_LABEL_SUBSTR):
        return True
    if s in _BLOCKED_LABEL_EXACT or "（2）" in s:
        return True
    if _V_PREFIX_RE.match(s):
        return True
    if "连续" in s and "插针" in s:
        return True
    return False


def is_blocked_card_type_label(type_label: str) -> bool:
    """Telegram 卡片 / 胜率入库 typeLabel。"""
    raw = str(type_label or "").strip()
    if not raw:
        return False
    if raw in _BLOCKED_LABEL_EXACT:
        return True
    lab = normalize_type_label(raw)
    if not lab:
        return False
    if lab in _BLOCKED_LABEL_EXACT:
        return True
    if any(x in lab for x in _BLOCKED_LABEL_SUBSTR):
        return True
    if "（2）" in lab:
        return True
    if _V_PREFIX_RE.match(lab):
        return True
    if "连续" in lab and "插针" in lab:
        return True
    return False


def is_blocked_structure_kind(kind: str) -> bool:
    return str(kind or "").strip() in _BLOCKED_STRUCTURE_KINDS


def is_blocked_ticker_alert(alert: dict[str, Any]) -> bool:
    """形态 ticker / Toast 落盘前过滤。"""
    if not isinstance(alert, dict):
        return True
    if is_disabled_pattern_interval(str(alert.get("interval") or "")):
        return True
    typ = str(alert.get("type") or "").strip().lower()
    if typ in _BLOCKED_ALERT_TYPES:
        return True
    kind = str(alert.get("kind") or alert.get("signal_kind") or "").strip()
    if kind in _BLOCKED_STRUCTURE_KINDS:
        return True
    if kind in (
        "continuous_upper_wick",
        "continuous_lower_wick",
        "continuous_non_upper_wick",
        "continuous_non_lower_wick",
        "oi_anomaly",
    ):
        return True
    lab = str(
        alert.get("type_label")
        or alert.get("status_label")
        or alert.get("signal_text")
        or alert.get("message")
        or ""
    )
    if is_blocked_card_type_label(lab):
        return True
    if typ == "vp_cont_thrust" and str(alert.get("side") or "").lower() == "short":
        return True
    return False


def is_blocked_stats_record(alert: dict[str, Any]) -> bool:
    """TG 推送后胜率入库前过滤。"""
    if is_blocked_ticker_alert(alert):
        return True
    return False


_LEGACY_BREAKOUT_TYPES = frozenset({
    "pattern_bull_continuation",
    "trigger",
    "breakout_trigger",
})
_LEGACY_BREAKOUT_LABELS = ("带量突破", "形态多头爆发", "多头爆发")

_RETIRED_KINDS = frozenset({
    "破底翻确认",
    "spring_2b",
    "continuous_upper_wick",
    "continuous_lower_wick",
    "continuous_non_upper_wick",
    "continuous_non_lower_wick",
    "oi_anomaly",
    "curvature_decay",
})

_RETIRED_KEY_PREFIXES = _BLOCKED_ALERT_TYPES | _LEGACY_BREAKOUT_TYPES | _RETIRED_KINDS | frozenset(
    {"vp_cont_thrust"}
)


def _type_label_from_record(rec: dict[str, Any]) -> str:
    lab = str(rec.get("typeLabel") or rec.get("type_label") or "").strip()
    if lab:
        return lab
    key = str(rec.get("key") or "")
    if not key:
        return ""
    parts = key.split(":")
    if len(parts) < 4:
        return ""
    tail = ":".join(parts[3:]).strip()
    for sep in (" · ", "·", "|", "｜"):
        if sep in tail:
            tail = tail.split(sep, 1)[0].strip()
            break
    return tail


def is_retired_pattern_stats_record(rec: dict[str, Any]) -> bool:
    """胜率库中应删除且不再展示的记录（停推类型 / 停用周期 / legacy）。"""
    if not isinstance(rec, dict):
        return True
    if is_disabled_pattern_interval(str(rec.get("interval") or "")):
        return True

    key = str(rec.get("key") or "")
    if key.startswith("pattern_bull_continuation:") or key.startswith("trigger:"):
        return True

    typ = str(rec.get("type") or "").strip().lower()
    if typ in _RETIRED_KEY_PREFIXES:
        if typ == "vp_cont_thrust":
            return str(rec.get("side") or "").lower() == "short"
        return True

    if key:
        prefix = key.split(":", 1)[0].lower()
        if prefix in _RETIRED_KEY_PREFIXES:
            if prefix == "vp_cont_thrust":
                return str(rec.get("side") or "").lower() == "short"
            return True

    kind = str(rec.get("kind") or rec.get("signal_kind") or "").strip()
    if kind in _RETIRED_KINDS or kind in _BLOCKED_STRUCTURE_KINDS:
        return True

    lab = _type_label_from_record(rec)
    if lab == "破底翻确认":
        return True
    if is_blocked_card_type_label(lab):
        return True
    if any(x in lab for x in _LEGACY_BREAKOUT_LABELS):
        return True

    if typ == "vp_cont_thrust" and str(rec.get("side") or "").lower() == "short":
        return True
    return False


def is_retired_pattern_ticker_item(row: dict[str, Any]) -> bool:
    """ticker 滚动条中应剔除的条目。"""
    if not isinstance(row, dict):
        return True
    alert = row.get("alert")
    if isinstance(alert, dict):
        if is_blocked_ticker_alert(alert):
            return True
        kind = str(alert.get("kind") or alert.get("type_label") or "").strip()
        if kind in _RETIRED_KINDS:
            return True
        pseudo = {
            "key": str(row.get("key") or ""),
            "typeLabel": alert.get("type_label"),
            "interval": alert.get("interval"),
            "side": alert.get("side"),
            "type": alert.get("type"),
            "kind": alert.get("kind"),
        }
        return is_retired_pattern_stats_record(pseudo)
    return is_retired_pattern_stats_record({"key": str(row.get("key") or "")})
