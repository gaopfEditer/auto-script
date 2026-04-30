"""SQLite 数据层：任务定义 + 执行记录（线程安全 + asyncio 友好）。"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


@dataclass
class TaskDefinition:
    id: int
    name: str
    task_cycle: str
    category: str
    agent_id: str
    payload: dict[str, Any]
    is_enabled: bool
    created_at: str


@dataclass
class TaskExecution:
    id: int
    task_id: int
    status: str
    started_at: str
    finished_at: str | None
    result_data: dict[str, Any] | None
    error_msg: str | None
    retry_count: int
    created_at: str
    updated_at: str


class DatabaseManager:
    def __init__(self, db_path: str) -> None:
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._thread_lock = threading.RLock()
        self._async_lock = asyncio.Lock()

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    async def initialize(self) -> None:
        await asyncio.to_thread(self._initialize_sync)

    def _initialize_sync(self) -> None:
        with self._thread_lock:
            self._conn.execute("PRAGMA foreign_keys = ON")
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS task_definitions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    task_cycle TEXT NOT NULL,
                    category TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    payload TEXT,
                    is_enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS task_executions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id INTEGER NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('pending','running','success','failed')),
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    result_data TEXT,
                    error_msg TEXT,
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (task_id) REFERENCES task_definitions(id) ON DELETE CASCADE
                )
                """
            )
            self._conn.commit()

    async def create_task_definition(
        self,
        name: str,
        task_cycle: str,
        category: str,
        agent_id: str,
        payload: dict[str, Any] | None,
        is_enabled: bool = True,
    ) -> int:
        return await asyncio.to_thread(
            self._create_task_definition_sync,
            name,
            task_cycle,
            category,
            agent_id,
            payload or {},
            is_enabled,
        )

    def _create_task_definition_sync(
        self,
        name: str,
        task_cycle: str,
        category: str,
        agent_id: str,
        payload: dict[str, Any],
        is_enabled: bool,
    ) -> int:
        now = self._now_iso()
        with self._thread_lock:
            cur = self._conn.execute(
                """
                INSERT INTO task_definitions (name, task_cycle, category, agent_id, payload, is_enabled, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (name, task_cycle, category, agent_id, json.dumps(payload, ensure_ascii=False), 1 if is_enabled else 0, now),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    async def list_task_definitions(self) -> list[TaskDefinition]:
        return await asyncio.to_thread(self._list_task_definitions_sync)

    def _list_task_definitions_sync(self) -> list[TaskDefinition]:
        with self._thread_lock:
            rows = self._conn.execute("SELECT * FROM task_definitions ORDER BY id DESC").fetchall()
        return [self._row_to_definition(dict(r)) for r in rows]

    async def get_task_definition_by_id(self, task_id: int) -> TaskDefinition | None:
        return await asyncio.to_thread(self._get_task_definition_by_id_sync, task_id)

    def _get_task_definition_by_id_sync(self, task_id: int) -> TaskDefinition | None:
        with self._thread_lock:
            row = self._conn.execute("SELECT * FROM task_definitions WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            return None
        return self._row_to_definition(dict(row))

    async def delete_task_definition(self, task_id: int) -> bool:
        return await asyncio.to_thread(self._delete_task_definition_sync, task_id)

    def _delete_task_definition_sync(self, task_id: int) -> bool:
        with self._thread_lock:
            cur = self._conn.execute("DELETE FROM task_definitions WHERE id = ?", (task_id,))
            self._conn.commit()
            return cur.rowcount > 0

    async def create_execution(self, task_id: int) -> int:
        return await asyncio.to_thread(self._create_execution_sync, task_id)

    def _create_execution_sync(self, task_id: int) -> int:
        now = self._now_iso()
        with self._thread_lock:
            cur = self._conn.execute(
                """
                INSERT INTO task_executions (task_id, status, started_at, finished_at, result_data, error_msg, retry_count, created_at, updated_at)
                VALUES (?, 'pending', ?, NULL, NULL, NULL, 0, ?, ?)
                """,
                (task_id, now, now, now),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    async def claim_next_pending_execution(self) -> tuple[TaskExecution, TaskDefinition] | None:
        async with self._async_lock:
            return await asyncio.to_thread(self._claim_next_pending_execution_sync)

    def _claim_next_pending_execution_sync(self) -> tuple[TaskExecution, TaskDefinition] | None:
        now = self._now_iso()
        with self._thread_lock:
            self._conn.execute("BEGIN IMMEDIATE")
            row = self._conn.execute(
                """
                SELECT
                    e.id AS execution_id,
                    e.task_id,
                    e.status AS execution_status,
                    e.started_at,
                    e.finished_at,
                    e.result_data,
                    e.error_msg,
                    e.retry_count,
                    e.created_at AS execution_created_at,
                    e.updated_at AS execution_updated_at,
                    d.id AS definition_id,
                    d.name,
                    d.task_cycle,
                    d.category,
                    d.agent_id,
                    d.payload,
                    d.is_enabled,
                    d.created_at AS definition_created_at
                FROM task_executions e
                JOIN task_definitions d ON d.id = e.task_id
                WHERE e.status = 'pending' AND d.is_enabled = 1
                ORDER BY e.id ASC
                LIMIT 1
                """
            ).fetchone()
            if row is None:
                self._conn.commit()
                return None

            self._conn.execute(
                "UPDATE task_executions SET status='running', updated_at=? WHERE id=?",
                (now, row["execution_id"]),
            )
            self._conn.commit()

            execution = TaskExecution(
                id=int(row["execution_id"]),
                task_id=int(row["task_id"]),
                status="running",
                started_at=row["started_at"],
                finished_at=row["finished_at"],
                result_data=json.loads(row["result_data"]) if row["result_data"] else None,
                error_msg=row["error_msg"],
                retry_count=int(row["retry_count"]),
                created_at=row["execution_created_at"],
                updated_at=now,
            )
            definition = TaskDefinition(
                id=int(row["definition_id"]),
                name=row["name"],
                task_cycle=row["task_cycle"],
                category=row["category"],
                agent_id=row["agent_id"],
                payload=json.loads(row["payload"]) if row["payload"] else {},
                is_enabled=bool(row["is_enabled"]),
                created_at=row["definition_created_at"],
            )
            return execution, definition

    async def mark_execution_success(self, execution_id: int, result_data: dict[str, Any]) -> None:
        await asyncio.to_thread(self._mark_execution_success_sync, execution_id, result_data)

    def _mark_execution_success_sync(self, execution_id: int, result_data: dict[str, Any]) -> None:
        now = self._now_iso()
        with self._thread_lock:
            self._conn.execute(
                """
                UPDATE task_executions
                SET status='success', result_data=?, finished_at=?, updated_at=?, error_msg=NULL
                WHERE id=?
                """,
                (json.dumps(result_data, ensure_ascii=False), now, now, execution_id),
            )
            self._conn.commit()

    async def mark_execution_failed(
        self,
        execution_id: int,
        error_msg: str,
        result_data: dict[str, Any] | None = None,
        *,
        increment_retry: bool = True,
    ) -> None:
        await asyncio.to_thread(self._mark_execution_failed_sync, execution_id, error_msg, result_data, increment_retry)

    def _mark_execution_failed_sync(
        self,
        execution_id: int,
        error_msg: str,
        result_data: dict[str, Any] | None,
        increment_retry: bool,
    ) -> None:
        now = self._now_iso()
        with self._thread_lock:
            if increment_retry:
                self._conn.execute(
                    """
                    UPDATE task_executions
                    SET status='failed', error_msg=?, result_data=?, retry_count=retry_count+1, finished_at=?, updated_at=?
                    WHERE id=?
                    """,
                    (error_msg, json.dumps(result_data, ensure_ascii=False) if result_data is not None else None, now, now, execution_id),
                )
            else:
                self._conn.execute(
                    """
                    UPDATE task_executions
                    SET status='failed', error_msg=?, result_data=?, finished_at=?, updated_at=?
                    WHERE id=?
                    """,
                    (error_msg, json.dumps(result_data, ensure_ascii=False) if result_data is not None else None, now, now, execution_id),
                )
            self._conn.commit()

    async def requeue_execution(self, execution_id: int, error_msg: str, result_data: dict[str, Any] | None = None) -> None:
        await asyncio.to_thread(self._requeue_execution_sync, execution_id, error_msg, result_data)

    def _requeue_execution_sync(self, execution_id: int, error_msg: str, result_data: dict[str, Any] | None) -> None:
        now = self._now_iso()
        with self._thread_lock:
            self._conn.execute(
                """
                UPDATE task_executions
                SET status='pending', error_msg=?, result_data=?, retry_count=retry_count+1, updated_at=?
                WHERE id=?
                """,
                (error_msg, json.dumps(result_data, ensure_ascii=False) if result_data is not None else None, now, execution_id),
            )
            self._conn.commit()

    async def get_execution_by_id(self, execution_id: int) -> TaskExecution | None:
        return await asyncio.to_thread(self._get_execution_by_id_sync, execution_id)

    def _get_execution_by_id_sync(self, execution_id: int) -> TaskExecution | None:
        with self._thread_lock:
            row = self._conn.execute("SELECT * FROM task_executions WHERE id=?", (execution_id,)).fetchone()
        if row is None:
            return None
        return self._row_to_execution(dict(row))

    async def list_executions(self) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._list_executions_sync)

    def _list_executions_sync(self) -> list[dict[str, Any]]:
        with self._thread_lock:
            rows = self._conn.execute(
                """
                SELECT
                    e.id,
                    e.task_id,
                    d.name AS task_name,
                    e.status,
                    e.started_at,
                    e.finished_at,
                    e.result_data,
                    e.error_msg,
                    e.retry_count,
                    e.created_at,
                    e.updated_at
                FROM task_executions e
                JOIN task_definitions d ON d.id = e.task_id
                ORDER BY e.id DESC
                """
            ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["result_data"] = json.loads(item["result_data"]) if item["result_data"] else None
            out.append(item)
        return out

    async def delete_execution(self, execution_id: int) -> bool:
        return await asyncio.to_thread(self._delete_execution_sync, execution_id)

    def _delete_execution_sync(self, execution_id: int) -> bool:
        with self._thread_lock:
            cur = self._conn.execute("DELETE FROM task_executions WHERE id = ?", (execution_id,))
            self._conn.commit()
            return cur.rowcount > 0

    async def close(self) -> None:
        await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> None:
        with self._thread_lock:
            self._conn.close()

    @staticmethod
    def _row_to_definition(row: dict[str, Any]) -> TaskDefinition:
        return TaskDefinition(
            id=int(row["id"]),
            name=row["name"],
            task_cycle=row["task_cycle"],
            category=row["category"],
            agent_id=row["agent_id"],
            payload=json.loads(row["payload"]) if row.get("payload") else {},
            is_enabled=bool(row["is_enabled"]),
            created_at=row["created_at"],
        )

    @staticmethod
    def _row_to_execution(row: dict[str, Any]) -> TaskExecution:
        return TaskExecution(
            id=int(row["id"]),
            task_id=int(row["task_id"]),
            status=row["status"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            result_data=json.loads(row["result_data"]) if row.get("result_data") else None,
            error_msg=row["error_msg"],
            retry_count=int(row.get("retry_count", 0)),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
