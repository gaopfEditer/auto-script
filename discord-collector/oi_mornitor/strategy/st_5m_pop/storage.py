"""POP 实盘观察留存：JSONL + 状态去重。"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()

_DATA_ROOT = Path(__file__).resolve().parents[2] / "data" / "st_5m_pop_live"


def campaign_dir(campaign_id: str) -> Path:
    p = _DATA_ROOT / campaign_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def append_event(campaign_id: str, event: dict[str, Any], *, kind: str = "signal") -> Path:
    d = campaign_dir(campaign_id)
    path = d / "events.jsonl"
    row = {
        "kind": kind,
        "loggedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        **event,
    }
    with _LOCK:
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return path


def load_state(campaign_id: str) -> dict[str, Any]:
    path = campaign_dir(campaign_id) / "state.json"
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_state(campaign_id: str, state: dict[str, Any]) -> None:
    path = campaign_dir(campaign_id) / "state.json"
    with _LOCK:
        path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")