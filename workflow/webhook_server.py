"""FastAPI 服务：Webhook + 管理 API。"""
from __future__ import annotations

import asyncio
import json
import logging
import traceback
import urllib.error
import urllib.request
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from config import SETTINGS
from db import DatabaseManager

app = FastAPI(title="OpenClaw Orchestrator Center")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
db = DatabaseManager(SETTINGS.sqlite_db_path)
logger = logging.getLogger("workflow.webhook_server")


class CreateTaskDefinitionRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    task_cycle: str = Field(..., min_length=1, max_length=50)
    category: str = Field(..., min_length=1, max_length=50)
    agent_id: str = Field(..., min_length=1, max_length=50)
    payload: dict[str, Any] = Field(default_factory=dict)
    is_enabled: bool = True


class CreateExecutionRequest(BaseModel):
    task_id: int = Field(..., ge=1)


class TriggerExecutionNowRequest(BaseModel):
    task_id: int = Field(..., ge=1)


class ChatSendRequest(BaseModel):
    agent_id: str = Field(..., min_length=1, max_length=50)
    message: str = Field(..., min_length=1)
    conversation_id: str | None = None
    extra_payload: dict[str, Any] = Field(default_factory=dict)


class HookPayload(BaseModel):
    execution_id: int = Field(..., ge=1)
    status: str = Field(..., pattern="^(success|failed)$")
    result_data: dict[str, Any] | None = None
    error_msg: str | None = None


def _is_authorized(authorization: str | None) -> bool:
    if not authorization:
        return False
    expected_bearer = f"Bearer {SETTINGS.shared_secret}"
    return authorization == SETTINGS.shared_secret or authorization == expected_bearer


def _post_to_openclaw(body: dict[str, Any]) -> dict[str, Any]:
    req = urllib.request.Request(
        url=SETTINGS.openclaw_webhook_url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SETTINGS.shared_secret}",
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


@app.on_event("startup")
async def on_startup() -> None:
    await db.initialize()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await db.close()


@app.get("/api/definitions")
async def list_definitions() -> list[dict[str, Any]]:
    data = await db.list_task_definitions()
    return [d.__dict__ for d in data]


@app.post("/api/definitions")
async def create_definition(payload: CreateTaskDefinitionRequest) -> dict[str, Any]:
    task_id = await db.create_task_definition(
        name=payload.name,
        task_cycle=payload.task_cycle,
        category=payload.category,
        agent_id=payload.agent_id,
        payload=payload.payload,
        is_enabled=payload.is_enabled,
    )
    return {"ok": True, "task_id": task_id}


@app.delete("/api/definitions/{task_id}")
async def delete_definition(task_id: int) -> dict[str, Any]:
    deleted = await db.delete_task_definition(task_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="task definition not found")
    return {"ok": True, "task_id": task_id}


@app.post("/api/executions")
async def create_execution(payload: CreateExecutionRequest) -> dict[str, Any]:
    execution_id = await db.create_execution(payload.task_id)
    return {"ok": True, "execution_id": execution_id}


@app.post("/api/executions/trigger-now")
async def trigger_execution_now(payload: TriggerExecutionNowRequest) -> dict[str, Any]:
    definition = await db.get_task_definition_by_id(payload.task_id)
    if definition is None:
        raise HTTPException(status_code=404, detail="task definition not found")
    if not definition.is_enabled:
        raise HTTPException(status_code=400, detail="task definition is disabled")

    execution_id = await db.create_execution(payload.task_id)
    body = {
        "agentId": definition.agent_id,
        "payload": definition.payload,
        "executionId": execution_id,
    }
    try:
        dispatch_result = await asyncio.to_thread(_post_to_openclaw, body)
        await db.mark_execution_success(execution_id, {"dispatch": dispatch_result, "awaiting_callback": True})
    except Exception as exc:  # noqa: BLE001
        await db.mark_execution_failed(execution_id, str(exc), {"status": "dispatch_error", "error": str(exc)})
        raise HTTPException(status_code=502, detail=f"dispatch failed: {exc}") from exc

    return {"ok": True, "execution_id": execution_id, "status": "running"}


@app.get("/api/executions")
async def list_executions() -> list[dict[str, Any]]:
    return await db.list_executions()


@app.delete("/api/executions/{execution_id}")
async def delete_execution(execution_id: int) -> dict[str, Any]:
    deleted = await db.delete_execution(execution_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="execution not found")
    return {"ok": True, "execution_id": execution_id}


@app.post("/api/chat/send")
async def send_chat(payload: ChatSendRequest) -> dict[str, Any]:
    message_payload = {
        "mode": "chat",
        "message": payload.message,
        "conversationId": payload.conversation_id,
        **payload.extra_payload,
    }
    body = {
        "agentId": payload.agent_id,
        "payload": message_payload,
    }
    try:
        result = await asyncio.to_thread(_post_to_openclaw, body)
    except urllib.error.HTTPError as exc:
        raw = ""
        try:
            raw = exc.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            raw = "<unable to read HTTPError body>"
        logger.error(
            "chat dispatch HTTPError: status=%s reason=%s agent_id=%s conversation_id=%s body=%s traceback=%s",
            exc.code,
            exc.reason,
            payload.agent_id,
            payload.conversation_id,
            raw,
            traceback.format_exc(),
        )
        raise HTTPException(
            status_code=502,
            detail={
                "message": "chat dispatch failed",
                "error_type": "HTTPError",
                "status_code": exc.code,
                "reason": str(exc.reason),
                "response_body": raw,
            },
        ) from exc
    except urllib.error.URLError as exc:
        logger.error(
            "chat dispatch URLError: reason=%s agent_id=%s conversation_id=%s traceback=%s",
            exc.reason,
            payload.agent_id,
            payload.conversation_id,
            traceback.format_exc(),
        )
        raise HTTPException(
            status_code=502,
            detail={
                "message": "chat dispatch failed",
                "error_type": "URLError",
                "reason": str(exc.reason),
            },
        ) from exc
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "chat dispatch unknown error: agent_id=%s conversation_id=%s error=%s traceback=%s",
            payload.agent_id,
            payload.conversation_id,
            exc,
            traceback.format_exc(),
        )
        raise HTTPException(
            status_code=502,
            detail={
                "message": "chat dispatch failed",
                "error_type": exc.__class__.__name__,
                "reason": str(exc),
            },
        ) from exc
    return {"ok": True, "status": "sent", "data": result}


@app.post("/hooks")
async def receive_hook(payload: HookPayload, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not _is_authorized(authorization):
        raise HTTPException(status_code=401, detail="invalid shared secret")

    execution = await db.get_execution_by_id(payload.execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="execution not found")

    if payload.status == "success":
        await db.mark_execution_success(payload.execution_id, payload.result_data or {})
    else:
        await db.mark_execution_failed(
            payload.execution_id,
            payload.error_msg or "openclaw returned failed",
            payload.result_data,
            increment_retry=False,
        )
    return {"ok": True, "execution_id": payload.execution_id, "status": payload.status}
