"""Telegram 信号全链路日志：从收消息 → 解析 → 建卡 API。"""

from __future__ import annotations

TAG = "[signal-pipeline]"


def _preview(text: str, limit: int = 120) -> str:
    s = (text or "").replace("\n", " ").strip()
    if len(s) > limit:
        return s[:limit] + "…"
    return s


def log_pipeline(stage: str, **fields: object) -> None:
    """stage: received | parsed | skip | card_post | card_ok | card_fail | dedup | pending"""
    parts: list[str] = [TAG, f"stage={stage}"]
    for key in (
        "chat_id",
        "msg_id",
        "sender",
        "symbol",
        "direction",
        "phase",
        "card_id",
        "source_ref",
        "reason",
        "detail",
        "url",
    ):
        val = fields.get(key)
        if val is None or val == "":
            continue
        parts.append(f"{key}={val!r}" if key in ("sender", "reason", "detail") else f"{key}={val}")
    body = fields.get("body")
    if body:
        parts.append(f"body={_preview(str(body))!r}")
    print(" ".join(parts), flush=True)
