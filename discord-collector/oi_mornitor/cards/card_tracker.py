"""卡片订单 SQLite（仅 card_orders 表）。"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from oi_mornitor.config import SANDBOX_STATE_DB


class CardTracker:
    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = Path(db_path or SANDBOX_STATE_DB)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS card_orders (
                    card_id TEXT PRIMARY KEY,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    status TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    position_id INTEGER,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_card_orders_status ON card_orders(status);
                """
            )

    def upsert_card_order(self, order: dict[str, Any]) -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO card_orders (
                    card_id, symbol, side, status, payload_json, position_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(card_id) DO UPDATE SET
                    symbol=excluded.symbol,
                    side=excluded.side,
                    status=excluded.status,
                    payload_json=excluded.payload_json,
                    position_id=excluded.position_id,
                    updated_at=excluded.updated_at
                """,
                (
                    str(order["card_id"]).upper(),
                    str(order["symbol"]).upper(),
                    str(order["side"]).upper(),
                    str(order["status"]),
                    json.dumps(order.get("payload") or order, ensure_ascii=False),
                    order.get("position_id"),
                    float(order.get("created_at") or now),
                    now,
                ),
            )

    def get_card_order(self, card_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM card_orders WHERE card_id = ?",
                (str(card_id).upper(),),
            ).fetchone()
        return self._row_to_card(row) if row else None

    def list_card_orders(self, *, status: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if status:
                rows = conn.execute(
                    """
                    SELECT * FROM card_orders WHERE status = ?
                    ORDER BY updated_at DESC LIMIT ?
                    """,
                    (status, int(limit)),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM card_orders
                    ORDER BY updated_at DESC LIMIT ?
                    """,
                    (int(limit),),
                ).fetchall()
        return [self._row_to_card(r) for r in rows]

    def list_active_card_orders(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM card_orders
                WHERE status IN ('watching', 'near', 'ordered', 'filled')
                ORDER BY updated_at DESC
                """
            ).fetchall()
        return [self._row_to_card(r) for r in rows]

    @staticmethod
    def _row_to_card(row: sqlite3.Row) -> dict[str, Any]:
        try:
            payload = json.loads(row["payload_json"] or "{}")
        except (TypeError, json.JSONDecodeError):
            payload = {}
        flat = {
            k: v
            for k, v in payload.items()
            if k not in ("card_id", "symbol", "side", "created_at", "updated_at", "payload")
        }
        return {
            "card_id": str(row["card_id"]),
            "symbol": str(row["symbol"]),
            "side": str(row["side"]),
            "status": str(row["status"]),
            "position_id": row["position_id"],
            "created_at": float(row["created_at"] or 0),
            "updated_at": float(row["updated_at"] or 0),
            "payload": payload,
            **flat,
        }
