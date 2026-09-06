"""形态 ticker 滚动条共享库：本机前端合并信号后落盘，生产端只读。"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

from oi_mornitor.config import PATTERN_STATE_DB

logger = logging.getLogger(__name__)

_LOCK = threading.RLock()
_TICKER_FILE = Path(PATTERN_STATE_DB).resolve().parent / "pattern_alert_ticker.json"
# 与前端 PatternAlertTicker TICKER_TTL_MS / TICKER_MAX 对齐（4h）
_TTL_MS = 4 * 60 * 60 * 1000
_MAX_ITEMS = 40

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


def _item_key(row: dict[str, Any]) -> str:
    k = str(row.get("key") or "").strip()
    if k:
        return k
    return str(row.get("id") or "").strip()


def _prune(items: list[dict[str, Any]], now: int | None = None) -> list[dict[str, Any]]:
    now = now or _now_ms()
    cutoff = now - _TTL_MS
    cleaned: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in items:
        if not isinstance(r, dict):
            continue
        key = _item_key(r)
        if not key or key in seen:
            continue
        signal_at = _to_ms(r.get("signalAt"), 0)
        if signal_at <= cutoff:
            continue
        seen.add(key)
        row = dict(r)
        row["key"] = key
        row["signalAt"] = signal_at
        cleaned.append(row)
    cleaned.sort(key=lambda x: int(x.get("signalAt") or 0))
    if len(cleaned) > _MAX_ITEMS:
        cleaned = cleaned[-_MAX_ITEMS:]
    return cleaned


def _load() -> list[dict[str, Any]]:
    global _memory
    with _LOCK:
        if _memory is not None:
            return list(_memory)
        items: list[dict[str, Any]] = []
        if _TICKER_FILE.is_file():
            try:
                raw = json.loads(_TICKER_FILE.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    raw = raw.get("items") or []
                if isinstance(raw, list):
                    items = [x for x in raw if isinstance(x, dict)]
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取形态 ticker 库失败: %s", exc)
        _memory = _prune(items)
        return list(_memory)


def _save(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    global _memory
    with _LOCK:
        cleaned = _prune(items)
        _memory = cleaned
        try:
            _TICKER_FILE.parent.mkdir(parents=True, exist_ok=True)
            _TICKER_FILE.write_text(
                json.dumps(
                    {"items": cleaned, "savedAt": _now_ms()},
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("写入形态 ticker 库失败: %s", exc)
        return list(cleaned)


def _dir_from_alert(alert: dict[str, Any]) -> str:
    side = str(alert.get("side") or "").lower()
    if side in ("bull", "long"):
        return "多"
    if side in ("bear", "short"):
        return "空"
    hint = str(alert.get("side_hint") or "")
    if "多" in hint:
        return "多"
    if "空" in hint:
        return "空"
    label = f"{alert.get('status_label') or ''} {alert.get('type_label') or ''} {alert.get('message') or ''}"
    if any(x in label for x in ("看跌", "做空", "顶部", "射击", "头肩", "M顶")):
        return "空"
    if any(x in label for x in ("看涨", "做多", "底部", "倒锤", "探底", "多头", "扳机")):
        return "多"
    return "—"


def _reason_from_alert(alert: dict[str, Any]) -> str:
    raw = (
        alert.get("type_label")
        or alert.get("pattern_label")
        or alert.get("signal_text")
        or alert.get("status_label")
        or alert.get("message")
        or "信号"
    )
    s = str(raw).strip()
    iv = str(alert.get("interval") or "").strip()
    if iv:
        s = f"{s}·{iv}"
    return s[:40]


def _signal_at_from_alert(alert: dict[str, Any]) -> int:
    for k in ("kline_close_time", "entry_time", "time", "kline_open_time", "scan_ts"):
        v = alert.get(k)
        if v is None or v == "":
            continue
        try:
            n = float(v)
        except (TypeError, ValueError):
            continue
        if n > 0:
            return _to_ms(n)
    return _now_ms()


def _item_key_from_alert(alert: dict[str, Any]) -> str:
    """与前端 PatternAlertTicker.alertKey / stats.alert_stats_key 对齐。"""
    typ = str(alert.get("type") or "")
    sym = str(alert.get("symbol") or "")
    close_t = (
        alert.get("kline_close_time")
        or alert.get("time")
        or alert.get("kline_open_time")
        or ""
    )
    msg = alert.get("message") or alert.get("type_label") or ""
    return f"{typ}:{sym}:{close_t}:{msg}"


def record_ticker_from_alert(alert: dict[str, Any]) -> dict[str, Any] | None:
    """后端扫描出信号时直接写入 ticker（不依赖浏览器打开）。"""
    if not isinstance(alert, dict):
        return None
    sym = str(alert.get("symbol") or "").strip()
    if not sym:
        return None
    key = _item_key_from_alert(alert)
    if not key or key.count(":") < 2:
        return None
    signal_at = _signal_at_from_alert(alert)
    item = {
        "id": f"{key}-{signal_at}",
        "key": key,
        "alert": alert,
        "signalAt": signal_at,
        "dir": _dir_from_alert(alert),
        "reason": _reason_from_alert(alert),
        "detailText": str(
            alert.get("message")
            or alert.get("signal_text")
            or alert.get("type_label")
            or ""
        ),
    }
    upsert_ticker([item])
    return item


def record_ticker_from_alerts(alerts: list[dict[str, Any]] | None) -> int:
    if not alerts:
        return 0
    n = 0
    for a in alerts:
        if record_ticker_from_alert(a):
            n += 1
    return n


def backfill_ticker_from_stats(*, limit: int = 40) -> int:
    """用胜率库近窗信号补 ticker（兼容：旧逻辑只写 stats、未写 ticker）。"""
    try:
        from oi_mornitor.pattern_alert_stats import list_alert_stats
    except Exception:  # noqa: BLE001
        return 0
    now = _now_ms()
    cutoff = now - _TTL_MS
    incoming: list[dict[str, Any]] = []
    for rec in list_alert_stats():
        if not isinstance(rec, dict):
            continue
        key = str(rec.get("key") or "").strip()
        signal_at = _to_ms(rec.get("signalAt"), 0)
        if not key or signal_at <= cutoff:
            continue
        sym = str(rec.get("tradeSymbol") or rec.get("symbol") or "").strip()
        if not sym:
            continue
        type_label = str(rec.get("typeLabel") or "")
        interval = str(rec.get("interval") or "")
        dir_cn = str(rec.get("dir") or "—")
        reason = f"{type_label}·{interval}" if interval and type_label else (type_label or "信号")
        alert = {
            "symbol": sym,
            "type": key.split(":", 1)[0] if ":" in key else "stats",
            "type_label": type_label,
            "interval": interval,
            "message": type_label,
            "kline_close_time": signal_at,
            "scan_ts": signal_at / 1000.0,
        }
        incoming.append(
            {
                "id": f"{key}-{signal_at}",
                "key": key,
                "alert": alert,
                "signalAt": signal_at,
                "dir": dir_cn if dir_cn in ("多", "空") else "—",
                "reason": reason[:40],
                "detailText": type_label,
            }
        )
        if len(incoming) >= limit:
            break
    if not incoming:
        return 0
    before = len(_load())
    upsert_ticker(incoming)
    after = len(_load())
    added = max(0, after - before)
    if added:
        logger.info("形态 ticker 从胜率库回填约 %d 条（现 %d）", added, after)
    return added


_backfill_once = False


def list_ticker() -> list[dict[str, Any]]:
    global _backfill_once
    items = _load()
    if not _backfill_once:
        _backfill_once = True
        # 空库或仅测试脏数据时，用 stats 补近窗信号
        real = [
            r
            for r in items
            if isinstance(r, dict)
            and not str(r.get("key") or "").startswith("test:")
        ]
        if len(real) < 3:
            try:
                backfill_ticker_from_stats()
                items = _load()
            except Exception as exc:  # noqa: BLE001
                logger.warning("ticker 回填失败: %s", exc)
    return items


def upsert_ticker(incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按 key 合并；已有项保留更完整字段，新项追加。"""
    if not incoming:
        return _load()
    with _LOCK:
        by_key: dict[str, dict[str, Any]] = {}
        for r in _load():
            k = _item_key(r)
            if k:
                by_key[k] = dict(r)

        for raw in incoming:
            if not isinstance(raw, dict):
                continue
            key = _item_key(raw)
            if not key:
                continue
            signal_at = _to_ms(raw.get("signalAt"), 0)
            if signal_at <= 0:
                continue
            alert = raw.get("alert")
            if not isinstance(alert, dict):
                alert = {}
            row = {
                "id": str(raw.get("id") or key),
                "key": key,
                "alert": alert,
                "signalAt": signal_at,
                "dir": raw.get("dir") or "—",
                "reason": str(raw.get("reason") or ""),
                "detailText": str(raw.get("detailText") or ""),
            }
            cur = by_key.get(key)
            if not cur:
                by_key[key] = row
                continue
            # 不覆盖更完整字段
            merged = dict(cur)
            for k, v in row.items():
                if k == "key":
                    continue
                if k == "alert":
                    if isinstance(v, dict) and v and (
                        not isinstance(merged.get("alert"), dict) or len(v) >= len(merged.get("alert") or {})
                    ):
                        merged["alert"] = v
                    continue
                if v in (None, "", "—") and merged.get(k) not in (None, "", "—"):
                    continue
                if k == "detailText" and merged.get("detailText") and len(str(merged["detailText"])) > len(str(v)):
                    continue
                merged[k] = v
            by_key[key] = merged

        return _save(list(by_key.values()))
