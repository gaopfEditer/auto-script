"""Sequoia 策略 ID 与中文名（UI / 胜率 typeLabel）。"""
from __future__ import annotations

from typing import Any

# id → (kind, 中文名, 默认方向 long/short)
STRATEGY_META: dict[str, dict[str, Any]] = {
    "turtle_trade": {
        "kind": "turtle_trade",
        "type_label": "海龟突破·多",
        "side": "long",
        "family": "sequoia_turtle",
        "desc": "N 根高点突破 + 量能 + 阳线过滤",
    },
    "ma_volume": {
        "kind": "ma_volume",
        "type_label": "均量金叉·多",
        "side": "long",
        "family": "sequoia_ma_volume",
        "desc": "短均线上穿长均线 + 放量",
    },
    "high_tight_flag": {
        "kind": "high_tight_flag",
        "type_label": "高紧旗形·多",
        "side": "long",
        "family": "sequoia_htf",
        "desc": "强势拉升后窄幅整理缩量",
    },
    "limit_up_shakeout": {
        "kind": "limit_up_shakeout",
        "type_label": "大阳洗盘·多",
        "side": "long",
        "family": "sequoia_shakeout",
        "desc": "大阳后阴线回踩仍守前收（加密版涨停洗盘）",
    },
    "uptrend_limit_down": {
        "kind": "uptrend_limit_down",
        "type_label": "趋势恐慌阴·多",
        "side": "long",
        "family": "sequoia_uld",
        "desc": "上升趋势中恐慌放量阴线（加密版跌停博弈）",
    },
    "rps_breakout": {
        "kind": "rps_breakout",
        "type_label": "相对强度突破·多",
        "side": "long",
        "family": "sequoia_rps",
        "desc": "固定流动宇宙内 RPS 高分位 + 近高点",
    },
}

ALL_STRATEGY_IDS: tuple[str, ...] = tuple(STRATEGY_META.keys())


def resolve_strategy_ids(selected: tuple[str, ...] | list[str] | None) -> tuple[str, ...]:
    if not selected:
        return ALL_STRATEGY_IDS
    out: list[str] = []
    for raw in selected:
        sid = str(raw or "").strip().lower()
        if sid in STRATEGY_META and sid not in out:
            out.append(sid)
    return tuple(out) if out else ALL_STRATEGY_IDS


def type_label_for(strategy_id: str) -> str:
    meta = STRATEGY_META.get(strategy_id) or {}
    return str(meta.get("type_label") or strategy_id)


def chinese_catalog() -> list[dict[str, str]]:
    return [
        {
            "id": sid,
            "kind": str(m["kind"]),
            "type_label": str(m["type_label"]),
            "side": str(m["side"]),
            "desc": str(m.get("desc") or ""),
        }
        for sid, m in STRATEGY_META.items()
    ]
