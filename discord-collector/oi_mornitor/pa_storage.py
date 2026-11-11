"""Append-only PA analysis records (effective_from + algo_version)."""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)
_LOCK = threading.Lock()
_DATA = Path(__file__).resolve().parent / "data" / "pa_analysis"


def append_pa_record(symbol: str, timeframe: str, record: dict[str, Any]) -> None:
    """Write one JSONL line; never mutates prior lines."""
    sym = str(symbol or "").upper().replace("/", "")
    tf = str(timeframe or "15m").strip().lower()
    if not sym or not record:
        return
    line = json.dumps(
        {
            "symbol": sym,
            "timeframe": tf,
            **record,
        },
        ensure_ascii=False,
    )
    with _LOCK:
        _DATA.mkdir(parents=True, exist_ok=True)
        path = _DATA / f"{sym}_{tf}.jsonl"
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
