"""特别关注币种（顶栏 mercu-focus · MAIN 白名单基础）。"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from oi_mornitor.config import MAIN_CARD_DEFAULT_SYMBOLS, PATTERN_STATE_DB

logger = logging.getLogger(__name__)

_LOCK = threading.RLock()
_FOCUS_FILE = Path(PATTERN_STATE_DB).resolve().parent / "focus_symbols.json"
_cache: dict[str, Any] | None = None


def normalize_focus_symbol(sym: str) -> str:
    return _normalize(sym)


def _normalize(sym: str) -> str:
    s = str(sym or "").strip().upper()
    if not s:
        return ""
    if s.endswith("USD") and not s.endswith("USDT") and not s.endswith("USDC"):
        s = f"{s}T"
    if not s.endswith(("USDT", "USDC", "BUSD")) and s.isalpha():
        s = f"{s}USDT"
    return s


def _default_symbols() -> list[str]:
    return [_normalize(s) for s in MAIN_CARD_DEFAULT_SYMBOLS if _normalize(s)]


def _prune_temporary(temp: dict[str, Any]) -> dict[str, Any]:
    now_ms = int(time.time() * 1000)
    out: dict[str, Any] = {}
    for sym, meta in temp.items():
        if not isinstance(meta, dict):
            continue
        exp = meta.get("expiresAt")
        try:
            exp_ms = int(exp)
        except (TypeError, ValueError):
            continue
        if exp_ms > now_ms:
            out[_normalize(sym)] = meta
    return out


def _read_store() -> dict[str, Any]:
    global _cache
    with _LOCK:
        if _cache is not None:
            return dict(_cache)
        persistent: list[str] = []
        temporary: dict[str, Any] = {}
        if _FOCUS_FILE.is_file():
            try:
                raw = json.loads(_FOCUS_FILE.read_text(encoding="utf-8"))
                if isinstance(raw, list):
                    persistent = [_normalize(str(x)) for x in raw if _normalize(str(x))]
                elif isinstance(raw, dict):
                    syms = raw.get("symbols") or []
                    if isinstance(syms, list):
                        persistent = [_normalize(str(x)) for x in syms if _normalize(str(x))]
                    temp = raw.get("temporary") or {}
                    if isinstance(temp, dict):
                        temporary = _prune_temporary(temp)
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取特别关注失败: %s", exc)
        if not persistent:
            persistent = _default_symbols()
        else:
            seen = set(persistent)
            for n in _default_symbols():
                if n and n not in seen:
                    persistent.append(n)
                    seen.add(n)
        _cache = {"symbols": persistent, "temporary": temporary}
        return dict(_cache)


def _write_store(persistent: list[str], temporary: dict[str, Any]) -> None:
    global _cache
    with _LOCK:
        cleaned: list[str] = []
        for s in persistent:
            n = _normalize(s)
            if n and n not in cleaned:
                cleaned.append(n)
        temp = _prune_temporary(temporary)
        _cache = {"symbols": cleaned, "temporary": temp}
        try:
            _FOCUS_FILE.parent.mkdir(parents=True, exist_ok=True)
            _FOCUS_FILE.write_text(
                json.dumps({"symbols": cleaned, "temporary": temp}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("写入特别关注失败: %s", exc)


def _merged_symbol_list(store: dict[str, Any]) -> list[str]:
    persistent = list(store.get("symbols") or [])
    temp = store.get("temporary") if isinstance(store.get("temporary"), dict) else {}
    out: list[str] = []
    seen: set[str] = set()
    for s in persistent:
        n = _normalize(str(s))
        if n and n not in seen:
            out.append(n)
            seen.add(n)
    for s in temp.keys():
        n = _normalize(str(s))
        if n and n not in seen:
            out.append(n)
            seen.add(n)
    return out


def list_focus_symbols() -> list[str]:
    store = _read_store()
    return _merged_symbol_list(store)


def list_focus_entries() -> dict[str, dict[str, Any]]:
    """临时 focus 元数据（badge / 过期时间），供顶栏展示。"""
    store = _read_store()
    temp = store.get("temporary") if isinstance(store.get("temporary"), dict) else {}
    out: dict[str, dict[str, Any]] = {}
    for sym, meta in temp.items():
        if not isinstance(meta, dict):
            continue
        n = _normalize(sym)
        if not n:
            continue
        out[n] = {
            "badge": meta.get("badge") or "自动",
            "expiresAt": meta.get("expiresAt"),
            "source": meta.get("source"),
        }
    return out


def focus_payload_for_api() -> dict[str, Any]:
    return {"symbols": list_focus_symbols(), "entries": list_focus_entries()}


def is_focus_symbol(symbol: str) -> bool:
    n = _normalize(symbol)
    return bool(n) and n in set(list_focus_symbols())


def set_focus_symbols(symbols: Iterable[str]) -> list[str]:
    store = _read_store()
    cleaned: list[str] = []
    seen: set[str] = set()
    for s in symbols:
        n = _normalize(str(s))
        if n and n not in seen:
            seen.add(n)
            cleaned.append(n)
    temp = store.get("temporary") if isinstance(store.get("temporary"), dict) else {}
    _write_store(cleaned, temp)
    return list_focus_symbols()


def add_focus_symbol(symbol: str) -> list[str]:
    n = _normalize(symbol)
    store = _read_store()
    persistent = list(store.get("symbols") or [])
    if n and n not in persistent:
        persistent.append(n)
    temp = store.get("temporary") if isinstance(store.get("temporary"), dict) else {}
    _write_store(persistent, temp)
    return list_focus_symbols()


def remove_focus_symbol(symbol: str) -> list[str]:
    n = _normalize(symbol)
    store = _read_store()
    persistent = [s for s in store.get("symbols") or [] if _normalize(str(s)) != n]
    temp = dict(store.get("temporary") or {})
    temp.pop(n, None)
    _write_store(persistent, temp)
    return list_focus_symbols()


def add_temporary_focus(
    symbol: str,
    *,
    ttl_hours: float = 36.0,
    source: str = "auto",
    badge: str = "",
    detail: dict[str, Any] | None = None,
) -> bool:
    """写入临时特别关注；已存在且未过期则刷新 TTL。返回是否新写入/刷新。"""
    n = _normalize(symbol)
    if not n:
        return False
    store = _read_store()
    persistent = list(store.get("symbols") or [])
    temp = dict(store.get("temporary") or {})
    now_ms = int(time.time() * 1000)
    ttl_ms = int(max(1.0, float(ttl_hours)) * 3600 * 1000)
    prev = temp.get(n) if isinstance(temp.get(n), dict) else {}
    temp[n] = {
        "addedAt": prev.get("addedAt") or now_ms,
        "expiresAt": now_ms + ttl_ms,
        "source": source,
        "badge": badge or prev.get("badge") or "自动",
        "detail": detail if detail is not None else prev.get("detail"),
    }
    _write_store(persistent, temp)
    logger.info("临时特别关注 %s · %s · %sh", n, badge or source, ttl_hours)
    return True
