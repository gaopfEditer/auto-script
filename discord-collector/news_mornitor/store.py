"""简单 JSON 缓存。"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from news_mornitor.settings import DATA_DIR, HOT_FILE, MACRO_FILE

logger = logging.getLogger("news.store")


def _ensure() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _read(path: Path, default: Any) -> Any:
    try:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("读缓存失败 %s: %s", path.name, e)
        return default


def _write(path: Path, data: Any) -> None:
    _ensure()
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _split_legacy_macro(items: list[dict]) -> dict[str, list[dict]]:
    economy: list[dict] = []
    crypto: list[dict] = []
    for e in items:
        src = str(e.get("source") or "")
        if src == "panews":
            crypto.append(e)
        else:
            economy.append(e)
    return {"economy": economy, "crypto": crypto}


def load_macro() -> dict[str, list[dict]]:
    """返回 {economy, crypto}；兼容旧版纯 list 缓存。"""
    data = _read(MACRO_FILE, {"economy": [], "crypto": []})
    if isinstance(data, list):
        return _split_legacy_macro(data)
    if isinstance(data, dict):
        if "economy" in data or "crypto" in data:
            return {
                "economy": list(data.get("economy") or []),
                "crypto": list(data.get("crypto") or []),
            }
        # 旧 {items: [...]}
        return _split_legacy_macro(list(data.get("items") or []))
    return {"economy": [], "crypto": []}


def save_macro(payload: dict[str, list[dict]] | list[dict]) -> None:
    if isinstance(payload, list):
        payload = _split_legacy_macro(payload)
    _write(
        MACRO_FILE,
        {
            "economy": list(payload.get("economy") or []),
            "crypto": list(payload.get("crypto") or []),
        },
    )


def load_hot() -> dict:
    data = _read(HOT_FILE, {})
    return data if isinstance(data, dict) else {}


def save_hot(payload: dict) -> None:
    _write(HOT_FILE, payload)
