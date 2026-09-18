"""形态信号胜率共享库：TG 推送时落盘，结算结果回写，多端共用。"""
from __future__ import annotations

import json
import logging
import os
import re
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
_VERIFY_INTERVAL_MS = 15 * 60 * 1000
_DEFAULT_TP_SL_PCT = 3.0
_DEFAULT_SL_PCT = 5.0
_LEV_100 = frozenset({"BTC", "ETH", "SOL"})

_TIME_FILTER_MS: dict[str, int] = {
    "2h": 2 * 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "8h": 8 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "3d": 3 * 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "14d": 14 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "1m": 1 * 30 * 24 * 60 * 60 * 1000,
    "2m": 2 * 30 * 24 * 60 * 60 * 1000,
    "3m": 3 * 30 * 24 * 60 * 60 * 1000,
}

# 固定周期下拉集合（与前端保持一致）
FIXED_INTERVALS = ["15m", "1h", "4h"]

def _interval_in_fixed(iv: str) -> str | None:
    """判断原始 interval 是否落在固定集合中；尝试归一化（w → 7d / m → 30d）。"""
    if not iv:
        return None
    iv = str(iv).strip().lower()
    norm: dict[str, str] = {
        "1h": "1h",
        "1w": "7d",
        "2w": "14d",
        "1mo": "1m",
        "2mo": "2m",
        "3mo": "3m",
        # 兼容后端存的英文别名
        "15min": "15m",
        "30min": "30m",
        "1hour": "1h",
        "4hour": "4h",
        "8hour": "8h",
        "1day": "24h",
        "3day": "3d",
        "1week": "7d",
    }
    if iv in norm:
        iv = norm[iv]
    return iv if iv in FIXED_INTERVALS else None

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


def _rec_base_symbol(rec: dict[str, Any]) -> str:
    raw = str(rec.get("tradeSymbol") or rec.get("symbol") or "")
    return human_base_asset(raw) or raw.strip().upper()


def filter_alert_stats(
    items: list[dict[str, Any]] | None = None,
    *,
    time_filter: str | None = None,
    type_label: str | None = None,
    interval: str | None = None,
    symbol: str | None = None,
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
    needle = (symbol or "").strip().upper()
    if needle and needle != "ALL":
        want = human_base_asset(needle) or needle
        rows = [r for r in rows if _rec_base_symbol(r) == want]
    return rows


def list_interval_options(items: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """周期下拉：固定集合（4h/8h/24h/3d/1w/2w/1m/2m/3m），含胜率、合计盈亏。"""
    rows = items if items is not None else _load()
    # 先按固定顺序把各 bucket 建好
    buckets: dict[str, list[dict[str, Any]]] = {iv: [] for iv in FIXED_INTERVALS}
    for r in rows:
        iv = _interval_in_fixed(str(r.get("interval") or ""))
        if iv:
            buckets[iv].append(r)
    out: list[dict[str, Any]] = []
    for iv in FIXED_INTERVALS:
        bucket = buckets[iv]
        if not bucket:
            continue
        s = summarize(bucket)
        out.append(
            {
                "label": iv,
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
    symbol: str | None = None,
) -> dict[str, Any]:
    """分页列表；typeOptions/intervalOptions 互相联动（选了什么 filter，另一个的 count 就跟着变）。"""
    page = max(1, int(page or 1))
    size = min(100, max(1, int(page_size or _PAGE_SIZE_DEFAULT)))
    # 基础时间筛选（可叠加币种，供图表按币拉取入场点）
    timed = filter_alert_stats(
        time_filter=time_filter, type_label=None, interval=None, symbol=symbol
    )
    # intervalOpts 叠加 type 过滤（联动）
    interval_opts = list_interval_options(
        filter_alert_stats(timed, time_filter=None, type_label=type_label, interval=None)
    )
    # typeOpts 叠加 interval 过滤（联动）
    type_opts = list_type_options(
        filter_alert_stats(timed, time_filter=None, type_label=None, interval=interval)
    )
    # 列表用全部过滤
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

def card_stats_key(card_id: str | int) -> str:
    """TG 交易卡片胜率 key（与前端 settle 核实一致）。"""
    cid = str(card_id or "").strip()
    return f"tg_card:{cid}" if cid else ""


_SHORT_NOISE_RE = re.compile(
    r"清空|空气|空调|空间|太空|空白|空泛|空想|空洞|空仓观望|空仓等待|空仓中|空方力量|多空博弈|多空|空头回补"
)


def _side_from_direction(raw: Any) -> str | None:
    text = str(raw or "").strip()
    if not text:
        return None
    lead = re.match(
        r"^(做多|做空|多单|空单|LONG|SHORT|多|空)(?=$|[\s:：·,，/|（(\[【]|\d)",
        text,
        re.I,
    )
    if lead:
        return "short" if re.search(r"空|SHORT", lead.group(1), re.I) else "long"
    scrub = _SHORT_NOISE_RE.sub("·", text)
    if re.search(r"做空|空单|進空|\bSHORT\b", scrub, re.I):
        return "short"
    if re.search(r"做多|多单|進多|\bLONG\b", scrub, re.I):
        return "long"
    if re.search(r"(^|[^\u4e00-\u9fff])空([^\u4e00-\u9fff]|$)", scrub):
        return "short"
    if re.search(r"(^|[^\u4e00-\u9fff])多([^\u4e00-\u9fff]|$)", scrub):
        return "long"
    if re.search(r"\bsell\b", scrub, re.I) and not re.search(r"\bbuy\b", scrub, re.I):
        return "short"
    if re.search(r"\bbuy\b", scrub, re.I):
        return "long"
    return None


def _entry_from_card(card: dict[str, Any]) -> float | None:
    ex = card.get("execution")
    if not isinstance(ex, dict):
        ex = {}
    planned = ex.get("planned")
    if not isinstance(planned, dict):
        planned = {}
    for k in ("entryPrice", "entry_price", "entry"):
        try:
            n = float(planned.get(k) if k in planned else card.get(k))
        except (TypeError, ValueError):
            continue
        if n > 0:
            return n
    parsed = card.get("parsedJson") or card.get("parsed_json")
    if isinstance(parsed, dict):
        try:
            n = float(parsed.get("entry") or parsed.get("entryPrice"))
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    return None


def record_card_from_archive(card: dict[str, Any]) -> dict[str, Any] | None:
    """Telegram 交易卡片归档后登记待核实信号（分批 TP / Runner 回溯与形态信号同口径）。"""
    if not isinstance(card, dict):
        return None
    card_id = card.get("id") or card.get("cardId") or card.get("card_id")
    if card_id is None or str(card_id).strip() == "":
        return None
    key = card_stats_key(card_id)
    if not key:
        return None

    ex = card.get("execution")
    if not isinstance(ex, dict):
        ex = {}
    direction = ex.get("direction") or card.get("direction")
    parsed = card.get("parsedJson") or card.get("parsed_json")
    if not direction and isinstance(parsed, dict):
        direction = parsed.get("direction")
    side = _side_from_direction(direction)
    if side not in ("long", "short"):
        return None
    entry = _entry_from_card(card)
    if entry is None:
        return None

    sym_raw = str(ex.get("symbol") or card.get("symbol") or "").strip()
    if not sym_raw and isinstance(parsed, dict):
        sym_raw = str(parsed.get("symbol") or "").strip()
    if not sym_raw:
        return None

    signal_raw = (
        card.get("signalAt")
        or card.get("signal_at")
        or card.get("createdAt")
        or card.get("created_at")
    )
    signal_at = _to_ms(signal_raw)
    trade_symbol = normalize_usdt_symbol(sym_raw)
    channel_id = str(card.get("channelId") or card.get("channel_id") or "").strip()
    channel_name = str(card.get("channelName") or card.get("channel_name") or "").strip()
    if not channel_name and isinstance(parsed, dict):
        channel_name = str(parsed.get("channelName") or "").strip()
    type_label = channel_name or channel_id or "TG交易卡"
    dir_cn = "多" if side == "long" else "空"

    with _LOCK:
        items = _load()
        existing = next((r for r in items if r.get("key") == key), None)
        if existing:
            patched = dict(existing)
            changed = False
            if not patched.get("entry") and entry:
                patched["entry"] = entry
                changed = True
            if patched.get("side") not in ("long", "short") and side:
                patched["side"] = side
                patched["dir"] = dir_cn
                changed = True
            if not patched.get("typeLabel") and type_label:
                patched["typeLabel"] = type_label
                changed = True
            if not patched.get("tradeSymbol") and trade_symbol:
                patched["tradeSymbol"] = trade_symbol
                changed = True
            if not patched.get("channelId") and channel_id:
                patched["channelId"] = channel_id
                changed = True
            if changed and str(patched.get("outcome") or "pending") == "pending":
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
            "interval": "15m",
            "source": "telegram_card",
            "cardId": str(card_id),
            "channelId": channel_id,
            "recordedAt": _now_ms(),
        }
        _save([rec, *items])
        logger.info(
            "TG交易卡胜率入库 #%s %s %s @%s",
            card_id,
            rec["symbol"],
            type_label,
            signal_at,
        )
        return rec


def record_alert_from_push(alert: dict[str, Any]) -> dict[str, Any] | None:
    """TG 推送形态/结构卡片时登记一条待核实信号。"""
    if not isinstance(alert, dict):
        return None
    # 彻底屏蔽已停用的 30m 周期和破底翻确认
    iv = str(alert.get("interval") or "").strip()
    kind = str(alert.get("kind") or alert.get("type_label") or "").strip()
    if iv in ("30m", "30min") or kind == "破底翻确认" or kind == "spring_2b":
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
        "lastSettleCheckAt",
        "source",
        "cardId",
        "channelId",
        "typeLabel",
        "entry",
        "side",
        "dir",
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
        "leverageHint": (
            "BTC/ETH/SOL 100x · 山寨 20x · TP 3%/7% 分批 · Runner 跟踪 · 止损 ±5%"
        ),
    }
