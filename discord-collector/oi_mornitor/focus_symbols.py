"""特别关注币种（推送到 MAIN_CARD_TELEGRAM_CHAT_ID）。"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Iterable

from oi_mornitor.config import MAIN_CARD_DEFAULT_SYMBOLS, PATTERN_STATE_DB

logger = logging.getLogger(__name__)

_LOCK = threading.RLock()
_FOCUS_FILE = Path(PATTERN_STATE_DB).resolve().parent / "focus_symbols.json"
_symbols: list[str] | None = None


def _normalize(sym: str) -> str:
    s = str(sym or "").strip().upper()
    if not s:
        return ""
    if s.endswith("USD") and not s.endswith("USDT") and not s.endswith("USDC"):
        s = f"{s}T"
    if not s.endswith(("USDT", "USDC", "BUSD")) and s.isalpha():
        s = f"{s}USDT"
    return s


def _load() -> list[str]:
    global _symbols
    with _LOCK:
        if _symbols is not None:
            return list(_symbols)
        out: list[str] = []
        if _FOCUS_FILE.is_file():
            try:
                raw = json.loads(_FOCUS_FILE.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    raw = raw.get("symbols") or []
                if isinstance(raw, list):
                    for x in raw:
                        n = _normalize(str(x))
                        if n and n not in out:
                            out.append(n)
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取特别关注失败: %s", exc)
        if not out:
            out = [_normalize(s) for s in MAIN_CARD_DEFAULT_SYMBOLS if _normalize(s)]
        _symbols = out
        return list(out)


def _save(symbols: list[str]) -> None:
    global _symbols
    with _LOCK:
        cleaned: list[str] = []
        for s in symbols:
            n = _normalize(s)
            if n and n not in cleaned:
                cleaned.append(n)
        _symbols = cleaned
        try:
            _FOCUS_FILE.parent.mkdir(parents=True, exist_ok=True)
            _FOCUS_FILE.write_text(
                json.dumps({"symbols": cleaned}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("写入特别关注失败: %s", exc)


def list_focus_symbols() -> list[str]:
    return _load()


def is_focus_symbol(symbol: str) -> bool:
    n = _normalize(symbol)
    return bool(n) and n in set(_load())


def set_focus_symbols(symbols: Iterable[str]) -> list[str]:
    cleaned = [_normalize(s) for s in symbols]
    cleaned = [s for s in cleaned if s]
    # 去重保序
    seen: set[str] = set()
    out: list[str] = []
    for s in cleaned:
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    _save(out)
    return out


def add_focus_symbol(symbol: str) -> list[str]:
    n = _normalize(symbol)
    cur = _load()
    if n and n not in cur:
        cur = [*cur, n]
        _save(cur)
    return list_focus_symbols()


def remove_focus_symbol(symbol: str) -> list[str]:
    n = _normalize(symbol)
    cur = [s for s in _load() if s != n]
    _save(cur)
    return list_focus_symbols()
