"""OI → Telegram 形态/结构推送运行时开关（Debug 页可改，落盘持久化）。

env 默认仍生效；本文件覆盖 env，重启后保留。
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

from oi_mornitor.config import (
    CANDLE_CARD_TELEGRAM,
    CANDLE_CARD_TELEGRAM_CHAT_ID,
    MAIN_CARD_TELEGRAM_CHAT_ID,
    PATTERN_STATE_DB,
    STRUCTURE_CARD_TELEGRAM,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_SEND_URL,
)

logger = logging.getLogger(__name__)

_LOCK = threading.RLock()
_FILE = Path(PATTERN_STATE_DB).resolve().parent / "telegram_push_toggles.json"

# None = 未覆盖，跟 env；bool = 显式覆盖
_overrides: dict[str, bool | None] | None = None

_KEYS = ("candle", "structure", "main")


def _defaults() -> dict[str, bool]:
    return {
        "candle": bool(CANDLE_CARD_TELEGRAM),
        "structure": bool(STRUCTURE_CARD_TELEGRAM),
        # MAIN 群：有 chat id 则默认开（仅特别关注币）
        "main": bool(MAIN_CARD_TELEGRAM_CHAT_ID),
    }


def _load_overrides() -> dict[str, bool | None]:
    global _overrides
    with _LOCK:
        if _overrides is not None:
            return dict(_overrides)
        out: dict[str, bool | None] = {k: None for k in _KEYS}
        if _FILE.is_file():
            try:
                raw = json.loads(_FILE.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    for k in _KEYS:
                        if k in raw and isinstance(raw[k], bool):
                            out[k] = raw[k]
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取 telegram_push_toggles 失败: %s", exc)
        _overrides = out
        return dict(out)


def _save_overrides(data: dict[str, bool | None]) -> None:
    global _overrides
    with _LOCK:
        _overrides = {k: data.get(k) for k in _KEYS}
        try:
            _FILE.parent.mkdir(parents=True, exist_ok=True)
            payload = {k: _overrides[k] for k in _KEYS if _overrides[k] is not None}
            _FILE.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("写入 telegram_push_toggles 失败: %s", exc)


def get_telegram_push_toggles() -> dict[str, Any]:
    """当前生效开关 + 配置摘要（供 Debug / API）。"""
    ov = _load_overrides()
    defaults = _defaults()
    effective = {
        k: defaults[k] if ov.get(k) is None else bool(ov[k]) for k in _KEYS
    }
    gateway = bool(TELEGRAM_SEND_URL)
    bot = bool(TELEGRAM_BOT_TOKEN)
    return {
        "ok": True,
        "toggles": effective,
        "overrides": {k: ov.get(k) for k in _KEYS},
        "envDefaults": defaults,
        "chatIds": {
            "candle": CANDLE_CARD_TELEGRAM_CHAT_ID or "",
            "main": MAIN_CARD_TELEGRAM_CHAT_ID or "",
        },
        "transport": {
            "gateway": gateway,
            "botToken": bot,
            "ready": gateway or bot,
        },
        "hint": (
            "形态卡片推送由 oi_mornitor 扫描触发（collect:ui 自动守护 / pnpm run oi:start）。"
            " candle → OI_CANDLE_CARD_TELEGRAM_CHAT_ID；"
            " main → 特别关注币另推 MAIN_CARD_TELEGRAM_CHAT_ID。"
        ),
    }


def set_telegram_push_toggles(partial: dict[str, Any]) -> dict[str, Any]:
    ov = _load_overrides()
    for k in _KEYS:
        if k not in partial:
            continue
        v = partial[k]
        if v is None:
            ov[k] = None
        elif isinstance(v, bool):
            ov[k] = v
        elif isinstance(v, (int, float)):
            ov[k] = bool(v)
        elif isinstance(v, str):
            s = v.strip().lower()
            if s in ("", "default", "env", "reset"):
                ov[k] = None
            else:
                ov[k] = s in ("1", "true", "yes", "on")
    _save_overrides(ov)
    return get_telegram_push_toggles()


def is_candle_push_enabled() -> bool:
    return bool(get_telegram_push_toggles()["toggles"]["candle"])


def is_structure_push_enabled() -> bool:
    return bool(get_telegram_push_toggles()["toggles"]["structure"])


def is_main_push_enabled() -> bool:
    return bool(get_telegram_push_toggles()["toggles"]["main"])
