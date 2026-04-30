"""Orchestrator：轮询 pending 执行并发到 OpenClaw，失败自动重试。"""
from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from typing import Any

from config import SETTINGS
from db import DatabaseManager, TaskDefinition, TaskExecution


def _post_json(url: str, token: str, body: dict[str, Any]) -> dict[str, Any]:
    req = urllib.request.Request(
        url=url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=SETTINGS.webhook_timeout_seconds) as resp:
        raw = resp.read().decode("utf-8")
        if not raw.strip():
            return {"status": "accepted", "http_status": resp.status}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"status": "accepted", "http_status": resp.status, "raw": raw}


async def send_webhook_to_openclaw(agent_id: str, payload: dict[str, Any], execution_id: int) -> dict[str, Any]:
    body = {
        "agentId": agent_id,
        "payload": payload,
        "executionId": execution_id,
    }
    return await asyncio.to_thread(
        _post_json,
        SETTINGS.openclaw_webhook_url,
        SETTINGS.shared_secret,
        body,
    )


async def process_single_execution(db: DatabaseManager, execution: TaskExecution, definition: TaskDefinition) -> None:
    try:
        dispatch_result = await send_webhook_to_openclaw(definition.agent_id, definition.payload, execution.id)
        await db.mark_execution_success(execution.id, {"dispatch": dispatch_result, "awaiting_callback": True})
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        error_result = {
            "status": "dispatch_error",
            "error": str(exc),
            "execution_id": execution.id,
            "retry_count": execution.retry_count,
        }
        if execution.retry_count + 1 >= SETTINGS.max_retry_count:
            await db.mark_execution_failed(execution.id, str(exc), error_result, increment_retry=True)
        else:
            await db.requeue_execution(execution.id, str(exc), error_result)
    except Exception as exc:  # noqa: BLE001
        error_result = {
            "status": "unknown_error",
            "error": str(exc),
            "execution_id": execution.id,
            "retry_count": execution.retry_count,
        }
        if execution.retry_count + 1 >= SETTINGS.max_retry_count:
            await db.mark_execution_failed(execution.id, str(exc), error_result, increment_retry=True)
        else:
            await db.requeue_execution(execution.id, str(exc), error_result)


async def orchestrator_loop(db: DatabaseManager, stop_event: asyncio.Event | None = None) -> None:
    if stop_event is None:
        stop_event = asyncio.Event()

    while not stop_event.is_set():
        claimed = await db.claim_next_pending_execution()
        if claimed is None:
            await asyncio.sleep(SETTINGS.poll_interval_seconds)
            continue

        execution, definition = claimed
        await process_single_execution(db, execution, definition)


async def main() -> None:
    db = DatabaseManager(SETTINGS.sqlite_db_path)
    await db.initialize()
    try:
        await orchestrator_loop(db)
    finally:
        await db.close()


if __name__ == "__main__":
    asyncio.run(main())
