"""形态卡片统一推送/入库门控：Live、胜率库、回测共用，避免漂移。"""
from __future__ import annotations

import logging
from typing import Any

from oi_mornitor.pattern_push_gate import passes_push_mtf_gate
from oi_mornitor.pattern_settle_profile import is_observation_record
from oi_mornitor.signal_policy import (
    is_blocked_stats_record,
    is_disabled_pattern_interval,
)

logger = logging.getLogger(__name__)


def passes_pattern_card_emit_gate(
    alert: dict[str, Any],
    peers: list[dict[str, Any]] | None = None,
) -> bool:
    """
    基础门控（与 record_alert_from_push 前置条件对齐）：
    - signal_policy 停推类型与周期
    - OI_PATTERN_PUSH_MTF_MIN 多周期共振
    """
    if not isinstance(alert, dict):
        return False
    if is_blocked_stats_record(alert):
        return False
    iv = str(alert.get("interval") or "").strip()
    if is_disabled_pattern_interval(iv):
        return False
    kind = str(alert.get("kind") or alert.get("signal_kind") or "").strip()
    if kind in ("破底翻确认", "spring_2b"):
        return False
    if not passes_push_mtf_gate(alert, peers):
        return False
    return True


def attach_confluence_on_alert(
    alert: dict[str, Any],
    peers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    from oi_mornitor.signal_confluence import confluence_for_alert

    conf = confluence_for_alert(alert, peers)
    alert["confluence"] = conf
    return conf


def record_confluence_observation_only(alert: dict[str, Any]) -> None:
    """综合分未达推送档：入库、正常结算，但不推 TG、不计头条胜率。"""
    try:
        from oi_mornitor.pattern_alert_stats import record_alert_from_push

        stub = dict(alert)
        stub["confluence_observation_only"] = True
        record_alert_from_push(stub)
    except Exception as exc:  # noqa: BLE001
        logger.warning("共振观察档入库失败: %s", exc)


def passes_confluence_tier_push_gate(alert: dict[str, Any]) -> bool:
    """需 alert 已写入 confluence。"""
    from oi_mornitor.signal_confluence import passes_confluence_push_gate

    conf = alert.get("confluence")
    if not isinstance(conf, dict):
        conf = attach_confluence_on_alert(alert)
    return passes_confluence_push_gate(conf)


def ingest_live_pattern_alert(
    alert: dict[str, Any],
    peers: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """
    现网扫描命中后写入形态胜率库 + ticker（与 TG 开关/送达无关）。
    口径与约定一致：基础门控 + MTF；B+ 正式条，C 档 confluence_observation_only。
    """
    if is_observation_record(alert):
        return None
    if not passes_pattern_card_emit_gate(alert, peers):
        return None
    attach_confluence_on_alert(alert, peers)
    from oi_mornitor.pattern_alert_stats import record_alert_from_push

    rec: dict[str, Any] | None
    if passes_confluence_tier_push_gate(alert):
        rec = record_alert_from_push(alert)
    else:
        record_confluence_observation_only(alert)
        rec = None
    try:
        from oi_mornitor.pattern_alert_ticker import record_ticker_from_alert

        record_ticker_from_alert(alert)
    except Exception as exc:  # noqa: BLE001
        logger.warning("形态 ticker 入库失败: %s", exc)
    return rec


def telegram_push_allowed_or_record_observation(
    alert: dict[str, Any],
    peers: list[dict[str, Any]] | None = None,
) -> bool:
    """
    TG 推送完整门控：基础门控 + OI_CONFLUENCE_PUSH_MIN_TIER。
    胜率入库请用 ingest_live_pattern_alert（扫描侧），此处仅判定是否发 TG。
    """
    if not passes_pattern_card_emit_gate(alert, peers):
        return False
    attach_confluence_on_alert(alert, peers)
    return passes_confluence_tier_push_gate(alert)


def would_telegram_push(
    alert: dict[str, Any],
    peers: list[dict[str, Any]] | None = None,
) -> bool:
    """回测「实际会推 TG」判定（不发 TG、不写库）。"""
    if not passes_pattern_card_emit_gate(alert, peers):
        return False
    attach_confluence_on_alert(alert, peers)
    return passes_confluence_tier_push_gate(alert)


def passes_backtest_emit_gate(
    alert: dict[str, Any],
    peers: list[dict[str, Any]] | None = None,
) -> bool:
    """回测扫描：基础门控 + 排除量价/标签观察档（不含共振 C 档——留作分组统计）。"""
    if is_observation_record(alert):
        return False
    return passes_pattern_card_emit_gate(alert, peers)


def alert_from_candle_hit(
    *,
    sym: str,
    iv: str,
    hit: dict[str, Any],
    close_ts_sec: int,
    close_ms: int,
) -> dict[str, Any]:
    kind = str(hit.get("kind") or "")
    side = "bull" if kind == "inverted_hammer" else str(hit.get("side") or "bear")
    type_label = str(hit.get("type_label") or kind)
    return {
        "symbol": sym,
        "type": "candle_pattern_card",
        "interval": iv,
        "kind": kind,
        "signal_kind": str(hit.get("signal_kind") or kind),
        "side": side,
        "type_label": type_label,
        "pattern_label": str(hit.get("text") or ""),
        "signal_text": str(hit.get("text") or type_label),
        "price": float(hit.get("close") or hit.get("price") or 0),
        "close": float(hit.get("close") or 0),
        "high": float(hit.get("high") or 0),
        "low": float(hit.get("low") or 0),
        "open": float(hit.get("open") or 0),
        "prior_high": hit.get("prior_high"),
        "prior_low": hit.get("prior_low"),
        "near_vegas": hit.get("near_vegas"),
        "trend_pct": hit.get("trend_pct"),
        "vol_ratio": hit.get("vol_ratio"),
        "card_vol_ok": hit.get("card_vol_ok", True),
        "kline_open_time": close_ts_sec,
        "time": close_ts_sec,
        "kline_close_time": close_ms,
        "observation_only": bool(hit.get("observation_only")),
        "vp_formal": hit.get("vp_formal"),
    }


def alert_from_structure_hit(
    *,
    sym: str,
    iv: str,
    hit: dict[str, Any],
    close_ts_sec: int,
    close_ms: int,
) -> dict[str, Any]:
    kind = str(hit.get("kind") or "")
    side = str(hit.get("side") or "")
    type_label = str(hit.get("type_label") or kind)
    inv = hit.get("defense")
    alert: dict[str, Any] = {
        "symbol": sym,
        "type": "structure_pattern_card",
        "interval": iv,
        "kind": kind,
        "signal_kind": kind,
        "side": side,
        "type_label": type_label,
        "pattern_label": str(hit.get("pattern_label") or type_label),
        "signal_text": str(hit.get("pattern_label") or type_label),
        "price": float(hit.get("close") or hit.get("price") or 0),
        "close": float(hit.get("close") or 0),
        "high": float(hit.get("high") or 0),
        "low": float(hit.get("low") or 0),
        "open": float(hit.get("open") or 0),
        "defense": inv,
        "vol_ratio": hit.get("vol_ratio"),
        "kline_open_time": close_ts_sec,
        "time": close_ts_sec,
        "kline_close_time": close_ms,
    }
    if inv is not None:
        try:
            alert["invalid_level"] = float(inv)
        except (TypeError, ValueError):
            pass
    return alert


def stats_peer_stub_from_alert(alert: dict[str, Any]) -> dict[str, Any]:
    from oi_mornitor.pattern_push_gate import alert_to_resonance_stub

    return alert_to_resonance_stub(alert)
