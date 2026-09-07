"""形态信号胜率共享库：TG 推送时落盘，结算结果回写，多端共用。"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

from oi_mornitor.config import PATTERN_STATE_DB
from oi_mornitor.symbol_aliases import human_base_asset, normalize_usdt_symbol

logger = logging.getLogger(__name__)

_LOCK = threading.RLock()
_STATS_FILE = Path(PATTERN_STATE_DB).resolve().parent / "pattern_alert_stats.json"
# 长期保存：不再按 7 天裁剪；仅软上限防文件无限膨胀（可 env 覆盖）
_MAX_ITEMS = int(os.environ.get("PATTERN_ALERT_STATS_MAX", "50000"))
_PAGE_SIZE_DEFAULT = 100
_VERIFY_DELAY_MS = 3 * 60 * 60 * 1000
_DEFAULT_TP_SL_PCT = 5.0
_LEV_100 = frozenset({"BTC", "ETH", "SOL"})

_TIME_FILTER_MS: dict[str, int] = {
    "2h": 2 * 60 * 60 * 1000,
    "8h": 8 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "1m": 30 * 24 * 60 * 60 * 1000,
}

_memory: list[dict[str, Any]] | None = None


def _now_ms() -> int:
    return int(time.time() * 1000)


def _to_ms(raw: Any, fallback: int | None = None) -> int:
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return fallback if fallback is not None else _now_ms()
    if not n or n <= 0:
        return fallback if fallback is not None else _now_ms()
    if n < 1e12:
        n *= 1000
    return int(n)


def _detect_tier(symbol: str) -> str:
    return "major" if human_base_asset(symbol) in _LEV_100 else "altcoin"


def _leverage(symbol: str) -> int:
    return 100 if human_base_asset(symbol) in _LEV_100 else 20


def _side_from_alert(alert: dict[str, Any]) -> str | None:
    side = str(alert.get("side") or "").lower()
    if side in ("bull", "long"):
        return "long"
    if side in ("bear", "short"):
        return "short"
    hint = str(alert.get("side_hint") or "")
    if "多" in hint or "涨" in hint:
        return "long"
    if "空" in hint or "跌" in hint:
        return "short"
    label = f"{alert.get('type_label') or ''} {alert.get('message') or ''}"
    if any(x in label for x in ("看跌", "做空", "顶部", "射击", "头肩", "M顶", "掠夺")):
        return "short"
    if any(x in label for x in ("看涨", "做多", "底部", "倒锤", "探底", "破底", "弹簧")):
        return "long"
    return None


def _entry_from_alert(alert: dict[str, Any]) -> float | None:
    for k in ("price", "close", "last_price", "entry_price"):
        try:
            n = float(alert.get(k))
        except (TypeError, ValueError):
            continue
        if n > 0:
            return n
    return None


def alert_stats_key(alert: dict[str, Any]) -> str:
    """与前端 PatternAlertTicker.alertKey 对齐。"""
    typ = str(alert.get("type") or "")
    sym = str(alert.get("symbol") or "")
    close_t = alert.get("kline_close_time") or alert.get("time") or alert.get("kline_open_time") or ""
    msg = alert.get("message") or alert.get("type_label") or ""
    return f"{typ}:{sym}:{close_t}:{msg}"


def _display_symbol(symbol: str) -> str:
    return human_base_asset(symbol) or str(symbol or "").upper()


def _normalize(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """校验 + 按 signalAt 降序；长期保留，仅超软上限时丢掉最旧。"""
    cleaned = [
        r
        for r in items
        if isinstance(r, dict)
        and isinstance(r.get("key"), str)
        and isinstance(r.get("signalAt"), (int, float))
        and int(r["signalAt"]) > 0
    ]
    cleaned.sort(key=lambda r: int(r.get("signalAt") or 0), reverse=True)
    if _MAX_ITEMS > 0 and len(cleaned) > _MAX_ITEMS:
        cleaned = cleaned[:_MAX_ITEMS]
    return cleaned


def _load() -> list[dict[str, Any]]:
    global _memory
    with _LOCK:
        if _memory is not None:
            return list(_memory)
        items: list[dict[str, Any]] = []
        if _STATS_FILE.is_file():
            try:
                raw = json.loads(_STATS_FILE.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    raw = raw.get("items") or []
                if isinstance(raw, list):
                    items = [x for x in raw if isinstance(x, dict)]
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取形态信号胜率库失败: %s", exc)
        _memory = _normalize(items)
        return list(_memory)


def _save(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    global _memory
    with _LOCK:
        cleaned = _normalize(items)
        _memory = cleaned
        try:
            _STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
            _STATS_FILE.write_text(
                json.dumps(
                    {"items": cleaned, "savedAt": _now_ms()},
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("写入形态信号胜率库失败: %s", exc)
        return list(cleaned)


def list_alert_stats() -> list[dict[str, Any]]:
    return _load()


def _type_label_of(rec: dict[str, Any]) -> str:
    return str(rec.get("typeLabel") or "").strip() or "未标注"


def filter_alert_stats(
    items: list[dict[str, Any]] | None = None,
    *,
    time_filter: str | None = None,
    type_label: str | None = None,
    interval: str | None = None,
    now_ms: int | None = None,
) -> list[dict[str, Any]]:
    rows = items if items is not None else _load()
    now = now_ms or _now_ms()
    tf = (time_filter or "all").strip().lower()
    if tf and tf != "all":
        span = _TIME_FILTER_MS.get(tf)
        if span:
            cutoff = now - span
            rows = [r for r in rows if int(r.get("signalAt") or 0) >= cutoff]
    tl = (type_label or "").strip()
    if tl and tl != "all":
        rows = [r for r in rows if _type_label_of(r) == tl]
    iv = (interval or "").strip()
    if iv and iv != "all":
        rows = [r for r in rows if str(r.get("interval") or "").strip() == iv]
    return rows


def list_interval_options(items: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """周期下拉：含胜率、总盈亏（相对当前时间筛选全集）。"""
    rows = items if items is not None else _load()
    groups: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        lab = str(r.get("interval") or "").strip() or "—"
        groups.setdefault(lab, []).append(r)
    out: list[dict[str, Any]] = []
    for lab, bucket in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        s = summarize(bucket)
        out.append(
            {
                "label": lab,
                "count": len(bucket),
                "wins": s["wins"],
                "losses": s["losses"],
                "winRate": s["winRate"],
                "totalPnlPct": s.get("totalPnlPct"),
            }
        )
    return out


def list_type_labels(items: list[dict[str, Any]] | None = None) -> list[str]:
    return [x["label"] for x in list_type_options(items)]


def _rec_pnl_pct(rec: dict[str, Any]) -> float | None:
    """与前端 alertStatsPnlPct / summarizeAlertWinRate 同口径（杠杆保证金 %）。"""
    oc = str(rec.get("outcome") or "pending")
    if oc in ("pending", "error"):
        return None
    move = rec.get("movePct")
    try:
        price_move = float(move) if move is not None else None
    except (TypeError, ValueError):
        price_move = None
    if price_move is None and oc in ("take_profit", "stop_loss"):
        try:
            step = float(rec.get("stepPct") or 0)
        except (TypeError, ValueError):
            step = 0.0
        price_move = step if step > 0 else _DEFAULT_TP_SL_PCT
    if price_move is None:
        return None
    if oc == "stop_loss":
        signed = -abs(price_move)
    elif oc == "take_profit":
        signed = abs(price_move)
    else:
        signed = price_move
    lev = _leverage(str(rec.get("tradeSymbol") or rec.get("symbol") or ""))
    return round(signed * lev, 2)


def list_type_options(items: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """类型下拉：含胜率、总盈亏率（相对当前时间筛选全集）。"""
    rows = items if items is not None else _load()
    groups: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        lab = _type_label_of(r)
        groups.setdefault(lab, []).append(r)
    out: list[dict[str, Any]] = []
    for lab, bucket in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        s = summarize(bucket)
        out.append(
            {
                "label": lab,
                "count": len(bucket),
                "wins": s["wins"],
                "losses": s["losses"],
                "winRate": s["winRate"],
                "totalPnlPct": s.get("totalPnlPct"),
            }
        )
    return out


def list_alert_stats_page(
    *,
    page: int = 1,
    page_size: int = _PAGE_SIZE_DEFAULT,
    time_filter: str | None = None,
    type_label: str | None = None,
    interval: str | None = None,
) -> dict[str, Any]:
    """分页列表；summary / typeOptions / intervalOptions 相对当前时间筛选全集；type/interval 再滤列表。"""
    page = max(1, int(page or 1))
    size = min(100, max(1, int(page_size or _PAGE_SIZE_DEFAULT)))
    timed = filter_alert_stats(time_filter=time_filter, type_label=None, interval=None)
    type_opts = list_type_options(timed)
    interval_opts = list_interval_options(timed)
    filtered = filter_alert_stats(timed, time_filter=None, type_label=type_label, interval=interval)
    total = len(filtered)
    pages = max(1, (total + size - 1) // size) if total else 1
    if page > pages:
        page = pages
    start = (page - 1) * size
    chunk = filtered[start : start + size]
    return {
        "items": chunk,
        "total": total,
        "page": page,
        "pageSize": size,
        "pages": pages,
        "summary": summarize(filtered),
        "typeOptions": type_opts,
        "intervalOptions": interval_opts,
        # 兼容旧前端
        "typeLabels": [x["label"] for x in type_opts],
    }

def record_alert_from_push(alert: dict[str, Any]) -> dict[str, Any] | None:
    """TG 推送形态/结构卡片时登记一条待核实信号。"""
    if not isinstance(alert, dict):
        return None
    side = _side_from_alert(alert)
    if side not in ("long", "short"):
        return None
    entry = _entry_from_alert(alert)
    if entry is None:
        return None
    key = alert_stats_key(alert)
    if not key.startswith(":") and key.count(":") < 2:
        return None
    sym_raw = str(alert.get("symbol") or "")
    signal_at = _to_ms(
        alert.get("scan_ts")
        or alert.get("kline_close_time")
        or alert.get("time")
        or alert.get("kline_open_time")
    )
    trade_symbol = normalize_usdt_symbol(sym_raw)
    type_label = str(
        alert.get("type_label") or alert.get("pattern_label") or alert.get("signal_text") or ""
    ).strip()
    interval = str(alert.get("interval") or "").strip()
    dir_cn = "多" if side == "long" else "空"

    with _LOCK:
        items = _load()
        existing = next((r for r in items if r.get("key") == key), None)
        if existing:
            # 已存在：只补缺字段，不覆盖已核结果
            patched = dict(existing)
            changed = False
            if not patched.get("typeLabel") and type_label:
                patched["typeLabel"] = type_label
                changed = True
            if not patched.get("interval") and interval:
                patched["interval"] = interval
                changed = True
            if not patched.get("tradeSymbol") and trade_symbol:
                patched["tradeSymbol"] = trade_symbol
                changed = True
            if changed:
                items = [patched if r.get("key") == key else r for r in items]
                _save(items)
                return patched
            return existing

        rec = {
            "key": key,
            "symbol": _display_symbol(sym_raw),
            "tradeSymbol": trade_symbol,
            "dir": dir_cn,
            "side": side,
            "signalAt": signal_at,
            "entry": entry,
            "tier": _detect_tier(sym_raw),
            "stepPct": _DEFAULT_TP_SL_PCT,
            "verifyAt": signal_at + _VERIFY_DELAY_MS,
            "outcome": "pending",
            "typeLabel": type_label,
            "interval": interval,
            "source": "telegram_push",
            "recordedAt": _now_ms(),
        }
        _save([rec, *items])
        logger.info(
            "形态信号胜率入库 %s %s %s @%s",
            rec["symbol"],
            type_label or "—",
            interval or "—",
            signal_at,
        )
        return rec


def apply_settle_updates(updates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """前端/服务端结算结果回写（按 key 合并）。"""
    if not updates:
        return _load()
    allow = {
        "outcome",
        "hitAt",
        "exitPrice",
        "movePct",
        "verifiedAt",
        "error",
        "tradeSymbol",
        "maxProfitPct",
        "maxProfitPrice",
        "maxProfitAt",
        "stepPct",
        "tier",
        "verifyAt",
    }
    with _LOCK:
        items = _load()
        by_key = {str(r.get("key")): dict(r) for r in items if r.get("key")}
        for u in updates:
            if not isinstance(u, dict):
                continue
            key = str(u.get("key") or "")
            if not key or key not in by_key:
                # 允许前端补登记一条完整记录
                if key and u.get("signalAt") and u.get("entry") and u.get("side"):
                    by_key[key] = {k: v for k, v in u.items() if v is not None}
                continue
            cur = by_key[key]
            for k, v in u.items():
                if k == "key":
                    continue
                if k in allow:
                    cur[k] = v
            by_key[key] = cur
        merged = list(by_key.values())
        return _save(merged)


def summarize(items: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    rows = items if items is not None else _load()
    pending = wins = losses = flats = errors = 0
    total_pnl = 0.0
    pnl_n = 0
    for r in rows:
        oc = str(r.get("outcome") or "pending")
        if oc == "pending":
            pending += 1
        elif oc == "take_profit":
            wins += 1
        elif oc == "stop_loss":
            losses += 1
        elif oc == "flat":
            flats += 1
        else:
            errors += 1
        pnl = _rec_pnl_pct(r)
        if pnl is not None:
            total_pnl += pnl
            pnl_n += 1
    settled = wins + losses
    return {
        "total": len(rows),
        "pending": pending,
        "wins": wins,
        "losses": losses,
        "flats": flats,
        "errors": errors,
        "winRate": (wins / settled) if settled else None,
        "totalPnlPct": round(total_pnl, 2) if pnl_n else None,
        "leverageHint": "BTC/ETH/SOL 100x · 山寨 20x · 默认 ±5% TP/SL",
    }
