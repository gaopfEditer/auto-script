"""Telegram 卡片推送去重（跨进程重启持久化）。"""
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
_FILE = Path(PATTERN_STATE_DB).resolve().parent / "telegram_push_dedupe.json"
_MAX_KEYS = 8000
_TTL_SEC = 90 * 86400

_store: dict[str, float] | None = None


def alert_push_dedupe_key(alert: dict[str, Any]) -> str:
    """同一根 K 线、同一信号类型只推一次（与 pattern_monitor _card_seen 对齐）。"""
    sym = str(alert.get("symbol") or "").strip().upper()
    iv = str(alert.get("interval") or "").strip().lower()
    kind = str(
        alert.get("kind") or alert.get("signal_kind") or alert.get("type") or ""
    ).strip()
    t = alert.get("kline_open_time") or alert.get("time") or 0
    try:
        ts = int(t)
    except (TypeError, ValueError):
        ts = 0
    card_type = str(alert.get("type") or "")
    label = str(alert.get("type_label") or alert.get("status_label") or "").strip()
    if card_type == "structure_pattern_card":
        return f"{sym}:{iv}:struct:{kind}:{ts}"
    if card_type == "candle_pattern_card":
        return f"{sym}:{iv}:{kind}:{ts}"
    if card_type == "volume_price_card":
        vp_kind = str(alert.get("vp_type") or kind or "vp")
        return f"{sym}:{iv}:vp:{vp_kind}:{label}:{ts}"
    if label:
        return f"{sym}:{iv}:vp:{label}:{ts}"
    return f"{sym}:{iv}:{kind}:{ts}"


def _chat_key(chat_id: str, dedupe: str) -> str:
    return f"{str(chat_id).strip()}:{dedupe}"


def _load() -> dict[str, float]:
    global _store
    with _LOCK:
        if _store is not None:
            return _store
        out: dict[str, float] = {}
        if _FILE.is_file():
            try:
                raw = json.loads(_FILE.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    keys = raw.get("keys") if "keys" in raw else raw
                    if isinstance(keys, dict):
                        now = time.time()
                        for k, v in keys.items():
                            try:
                                ts = float(v)
                            except (TypeError, ValueError):
                                continue
                            if now - ts <= _TTL_SEC:
                                out[str(k)] = ts
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取 telegram_push_dedupe 失败: %s", exc)
        _store = out
        return out


def _save(data: dict[str, float]) -> None:
    global _store
    with _LOCK:
        trimmed = dict(sorted(data.items(), key=lambda x: x[1])[-_MAX_KEYS:])
        _store = trimmed
        try:
            _FILE.parent.mkdir(parents=True, exist_ok=True)
            _FILE.write_text(
                json.dumps({"keys": trimmed}, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("写入 telegram_push_dedupe 失败: %s", exc)


def was_telegram_push_sent(chat_id: str, dedupe: str) -> bool:
    if not chat_id or not dedupe:
        return False
    data = _load()
    key = _chat_key(chat_id, dedupe)
    ts = data.get(key)
    if ts is None:
        return False
    if time.time() - ts > _TTL_SEC:
        return False
    return True


def mark_telegram_push_sent(chat_id: str, dedupe: str) -> None:
    if not chat_id or not dedupe:
        return
    data = _load()
    data[_chat_key(chat_id, dedupe)] = time.time()
    if len(data) > _MAX_KEYS:
        data = dict(sorted(data.items(), key=lambda x: x[1])[-_MAX_KEYS:])
    _save(data)


def try_claim_telegram_push(chat_id: str, dedupe: str) -> bool:
    """原子占位：已成功占位或已发送则返回 False。"""
    if not chat_id or not dedupe:
        return False
    with _LOCK:
        data = _load()
        key = _chat_key(chat_id, dedupe)
        ts = data.get(key)
        now = time.time()
        if ts is not None and now - ts <= _TTL_SEC:
            return False
        data[key] = now
        _save(data)
        return True


def release_telegram_push_claim(chat_id: str, dedupe: str) -> None:
    """发送失败时释放占位，便于下轮扫描重试。"""
    if not chat_id or not dedupe:
        return
    with _LOCK:
        data = _load()
        data.pop(_chat_key(chat_id, dedupe), None)
        _save(data)
