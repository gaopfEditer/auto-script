"""资金流本地缓存：REST 短 TTL + 强平事件持久化（供历史回放）。"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

from oi_mornitor.capital_flow_config import CF_CACHE_TTL_SEC
from oi_mornitor.config import PATTERN_STATE_DB
from oi_mornitor.sqlite_util import connect

logger = logging.getLogger(__name__)

_LOCK = threading.RLock()
_MEM_CACHE: dict[str, tuple[float, Any]] = {}


def _db_path() -> Path:
    return Path(PATTERN_STATE_DB).resolve().parent / "capital_flow.db"


def _ensure_schema(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS liquidation_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL,
            event_time_ms INTEGER NOT NULL,
            side TEXT,
            price REAL,
            qty REAL,
            raw_json TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_liq_sym_time ON liquidation_events(symbol, event_time_ms)"
    )
    conn.commit()


def cache_get(key: str) -> Any | None:
    with _LOCK:
        row = _MEM_CACHE.get(key)
        if not row:
            return None
        ts, val = row
        if time.time() - ts > CF_CACHE_TTL_SEC:
            _MEM_CACHE.pop(key, None)
            return None
        return val


def cache_set(key: str, val: Any) -> None:
    with _LOCK:
        _MEM_CACHE[key] = (time.time(), val)


def record_liquidation(
    *,
    symbol: str,
    event_time_ms: int,
    side: str,
    price: float,
    qty: float,
    raw: dict[str, Any] | None = None,
) -> None:
    sym = symbol.strip().upper()
    if not sym or event_time_ms <= 0:
        return
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with connect(path) as conn:
            _ensure_schema(conn)
            conn.execute(
                """
                INSERT INTO liquidation_events(symbol, event_time_ms, side, price, qty, raw_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    sym,
                    int(event_time_ms),
                    side,
                    float(price),
                    float(qty),
                    json.dumps(raw or {}, ensure_ascii=False)[:4000],
                ),
            )
            conn.commit()
    except Exception as exc:  # noqa: BLE001
        logger.debug("强平入库失败 %s: %s", sym, exc)


def liquidations_in_window(
    symbol: str,
    *,
    start_ms: int,
    end_ms: int,
    limit: int = 200,
) -> list[dict[str, Any]]:
    sym = symbol.strip().upper()
    if not sym or end_ms <= start_ms:
        return []
    path = _db_path()
    if not path.is_file():
        return []
    try:
        with connect(path) as conn:
            _ensure_schema(conn)
            rows = conn.execute(
                """
                SELECT event_time_ms, side, price, qty
                FROM liquidation_events
                WHERE symbol = ? AND event_time_ms >= ? AND event_time_ms <= ?
                ORDER BY event_time_ms DESC
                LIMIT ?
                """,
                (sym, int(start_ms), int(end_ms), int(limit)),
            ).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.debug("强平查询失败 %s: %s", sym, exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "eventTimeMs": int(r["event_time_ms"]),
                "side": str(r["side"] or ""),
                "price": float(r["price"] or 0),
                "qty": float(r["qty"] or 0),
            }
        )
    return out
