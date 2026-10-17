"""最近一次检测到的趋势线（供 JSON API）。"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from oi_mornitor.config import PATTERN_STATE_DB

_LOCK = threading.RLock()
_FILE = Path(PATTERN_STATE_DB).resolve().parent / "trendline_lines_snapshot.json"
_state: dict[str, Any] = {
    "updated_at": 0,
    "series": {},
}


def _load() -> dict[str, Any]:
    global _state
    with _LOCK:
        if _FILE.is_file():
            try:
                raw = json.loads(_FILE.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    _state = raw
            except Exception:
                pass
        return _state


def update_series(key: str, payload: dict[str, Any]) -> None:
    with _LOCK:
        st = _load()
        series = dict(st.get("series") or {})
        series[key] = payload
        st["series"] = series
        st["updated_at"] = int(time.time())
        _FILE.parent.mkdir(parents=True, exist_ok=True)
        _FILE.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")


def get_snapshot() -> dict[str, Any]:
    return _load()
