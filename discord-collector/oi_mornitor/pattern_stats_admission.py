"""形态胜率库入库门控：去重键、同向冷却、反向锁定、T3·15m MA144 附加门槛。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.config import (
    OI_MA144_T3_15M_MIN_MTF,
    OI_MA144_T3_15M_MIN_SCORE,
    OI_PATTERN_STATS_COOLDOWN_OPPOSITE_BARS,
    OI_PATTERN_STATS_COOLDOWN_SAME_BARS,
)
from oi_mornitor.mcap_tier import resolve_mcap_tier
from oi_mornitor.pattern_signal_time import resolve_signal_at_from_alert
from oi_mornitor.symbol_aliases import human_base_asset, normalize_usdt_symbol

_INTERVAL_SEC: dict[str, int] = {
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
    "1w": 604800,
}

_KNOWN_KINDS = frozenset(
    {
        "shooting_star",
        "inverted_hammer",
        "hammer",
        "hanging_man",
        "doji",
        "spring_2b",
        "head_shoulders",
        "double_top",
        "double_bottom",
    }
)


def is_canonical_stats_key(key: str) -> bool:
    parts = str(key or "").split(":")
    if len(parts) < 5:
        return False
    side = parts[-1].lower()
    if side not in ("long", "short", "bull", "bear"):
        return False
    kind = parts[3]
    if not kind:
        return False
    # 旧版中文文案 key：第 4 段常含「射击」「倒锤」等且 side 不是 long/short
    if kind in _KNOWN_KINDS:
        return True
    if any(x in kind for x in ("射击", "倒锤", "锤子", "之星", "均线")):
        return False
    return len(kind) <= 48 and kind.replace("_", "").isascii()


def legacy_message_key_from_record(rec: dict[str, Any]) -> str | None:
    """由记录字段还原旧版 message 型 key（用于合并迁移）。"""
    key = str(rec.get("key") or "")
    if is_canonical_stats_key(key):
        return None
    parts = key.split(":")
    if len(parts) < 3:
        return None
    typ = parts[0] or str(rec.get("type") or "candle_pattern_card")
    sym = parts[1] or str(rec.get("tradeSymbol") or rec.get("symbol") or "")
    close_t = parts[2] or rec.get("signalAt") or ""
    label = str(rec.get("typeLabel") or "").strip()
    if not label and len(parts) > 3:
        label = ":".join(parts[3:])
    if not label:
        return None
    return f"{typ}:{sym}:{close_t}:{label}"


def canonical_stats_key_from_record(rec: dict[str, Any]) -> str:
    """将记录规范为 type:symbol:close:kind:side。"""
    key = str(rec.get("key") or "")
    if is_canonical_stats_key(key):
        return key
    typ = "candle_pattern_card"
    sym = ""
    close_t = ""
    if key:
        parts = key.split(":")
        if parts:
            typ = parts[0] or typ
        if len(parts) > 1:
            sym = parts[1]
        if len(parts) > 2:
            close_t = parts[2]
    sym = sym or str(rec.get("tradeSymbol") or rec.get("symbol") or "")
    close_t = close_t or rec.get("kline_close_time") or rec.get("signalAt") or ""
    kind = str(rec.get("kind") or rec.get("signal_kind") or "").strip()
    if not kind:
        lab = str(rec.get("typeLabel") or "").strip()
        if "射击" in lab:
            kind = "shooting_star"
        elif "倒锤" in lab:
            kind = "inverted_hammer"
        elif lab:
            kind = lab
    side = str(rec.get("side") or "").lower()
    if side == "bull":
        side = "long"
    elif side == "bear":
        side = "short"
    if side not in ("long", "short"):
        d = str(rec.get("dir") or "")
        if d == "多":
            side = "long"
        elif d == "空":
            side = "short"
    return f"{typ}:{sym}:{close_t}:{kind}:{side}"


def is_observation_stats_record(rec: dict[str, Any]) -> bool:
    """与前端 isObservationStatsRecord / 头条胜率排除对齐。"""
    from oi_mornitor.pattern_settle_profile import is_observation_record

    if is_observation_record(rec):
        return True
    if rec.get("confluence_observation_only"):
        return True
    if rec.get("second_trial_observation_only"):
        return True
    st = rec.get("second_trial")
    if isinstance(st, dict) and st.get("enabled") and not st.get("formal"):
        return True
    conf = rec.get("confluence")
    if isinstance(conf, dict):
        tier = str(conf.get("tier") or "").strip().upper()
        if tier == "C":
            return True
    return False


def _bar_ms(interval: str) -> int:
    sec = _INTERVAL_SEC.get(str(interval or "").strip().lower())
    if sec:
        return sec * 1000
    return 900_000


def _record_identity(rec: dict[str, Any]) -> tuple[str, str, str]:
    sym = normalize_usdt_symbol(str(rec.get("tradeSymbol") or rec.get("symbol") or ""))
    base = human_base_asset(sym) or sym
    iv = str(rec.get("interval") or "").strip().lower()
    side = str(rec.get("side") or "").lower()
    if side == "bull":
        side = "long"
    elif side == "bear":
        side = "short"
    return base, iv, side


def stats_cooldown_blocks(
    alert: dict[str, Any],
    existing: list[dict[str, Any]],
) -> bool:
    """
    同币同周期：同向 ≥ OI_PATTERN_STATS_COOLDOWN_SAME_BARS 根 K；
    反向 ≥ OI_PATTERN_STATS_COOLDOWN_OPPOSITE_BARS 根 K 内互斥。
    """
    same_bars = max(0, int(OI_PATTERN_STATS_COOLDOWN_SAME_BARS))
    opp_bars = max(0, int(OI_PATTERN_STATS_COOLDOWN_OPPOSITE_BARS))
    if same_bars <= 0 and opp_bars <= 0:
        return False
    iv = str(alert.get("interval") or "").strip().lower()
    bar_ms = _bar_ms(iv)
    sym = normalize_usdt_symbol(str(alert.get("symbol") or ""))
    base = human_base_asset(sym) or sym.upper()
    side = str(alert.get("side") or "").lower()
    if side == "bull":
        side = "long"
    elif side == "bear":
        side = "short"
    if side not in ("long", "short"):
        return False
    signal_at = resolve_signal_at_from_alert(alert)
    if signal_at <= 0:
        return False
    opp = "short" if side == "long" else "long"
    for rec in existing:
        if not isinstance(rec, dict):
            continue
        r_base, r_iv, r_side = _record_identity(rec)
        if r_base != base or r_iv != iv or r_side not in ("long", "short"):
            continue
        try:
            r_at = int(rec.get("signalAt") or 0)
        except (TypeError, ValueError):
            continue
        if r_at <= 0:
            continue
        delta_bars = abs(signal_at - r_at) / float(bar_ms)
        if r_side == side and same_bars > 0 and delta_bars < same_bars:
            return True
        if r_side == opp and opp_bars > 0 and delta_bars < opp_bars:
            return True
    return False


def passes_ma144_t3_15m_gate(
    alert: dict[str, Any],
    peers: list[dict[str, Any]] | None = None,
) -> bool:
    """T3 市值 + 15m MA144：须 MTF≥门槛或综合分≥门槛（默认 MTF 2 / 分 70）。"""
    if str(alert.get("type") or "") != "ma144_candle_card":
        return True
    iv = str(alert.get("interval") or "").strip().lower()
    if iv != "15m":
        return True
    sym = str(alert.get("symbol") or "")
    if resolve_mcap_tier(sym) != "t3":
        return True
    from oi_mornitor.pattern_push_gate import mtf_tier_count_for_alert

    need_mtf = max(1, int(OI_MA144_T3_15M_MIN_MTF))
    if mtf_tier_count_for_alert(alert, peers) >= need_mtf:
        return True
    conf = alert.get("confluence")
    if not isinstance(conf, dict):
        from oi_mornitor.pattern_emit_gate import attach_confluence_on_alert

        conf = attach_confluence_on_alert(alert, peers)
    try:
        score = float((conf or {}).get("score") or 0)
    except (TypeError, ValueError):
        score = 0.0
    return score >= float(OI_MA144_T3_15M_MIN_SCORE)


def passes_stats_admission(
    alert: dict[str, Any],
    existing: list[dict[str, Any]] | None = None,
    peers: list[dict[str, Any]] | None = None,
) -> bool:
    """胜率库新条入库（含前端补登记应对齐的口径子集）。"""
    pool = list(existing or [])
    if stats_cooldown_blocks(alert, pool):
        return False
    if not passes_ma144_t3_15m_gate(alert, peers):
        return False
    return True
