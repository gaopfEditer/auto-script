"""向 discord-collector 开放建卡 API 发交易信号。"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import (
    get_cards_api_base_url,
    get_cards_api_key,
    resolve_channel_profile,
    telegram_avatar_dir,
)
from trade_signal_detect import TradeSignal, format_signal_push


def _split_targets(raw: str) -> list[str]:
    if not raw:
        return []
    parts: list[str] = []
    normalized = (
        (raw or "")
        .replace("，", ",")
        .replace("/", ",")
        .replace("|", ",")
        .replace("｜", ",")
    )
    for chunk in re.split(r"[,，\s]+", normalized):
        chunk = chunk.strip()
        if not chunk:
            continue
        for sub in re.split(r"(?<=\d)-(?=\d)", chunk):
            t = sub.strip()
            if t:
                parts.append(t)
    return parts


def _channel_avatar_for_api(resolved: str) -> str:
    """
    本地 telegram/avatar 文件 → collector 静态 URL（/telegram-avatars/…）；
    已是 http(s)/data 则原样返回。
    """
    s = (resolved or "").strip()
    if not s:
        return ""
    if s.startswith(("http://", "https://", "data:")):
        return s
    p = Path(s)
    if not p.is_file():
        return ""
    try:
        p.resolve().relative_to(telegram_avatar_dir())
    except ValueError:
        # 非 avatar 目录下的本地文件：仍尝试用文件名走静态路由
        pass
    return f"{get_cards_api_base_url()}/telegram-avatars/{p.name}"


def signal_to_card_payload(
    sig: TradeSignal,
    *,
    chat_id: int,
    chat_title: str = "",
    signal_at: datetime | None = None,
    phase: str = "full",
    raw_body: str = "",
) -> dict[str, Any]:
    profile = resolve_channel_profile(chat_id, fallback_title=chat_title or sig.sender)
    direction = ""
    if sig.direction == "多":
        direction = "long"
    elif sig.direction == "空":
        direction = "short"

    at = signal_at or datetime.now(timezone.utc)
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    iso = at.isoformat().replace("+00:00", "Z")

    formatted = format_signal_push(sig, phase=phase if phase != "update" else "full")
    body = (raw_body or "").strip() or formatted
    note_parts = []
    if sig.note:
        note_parts.append(sig.note)
    if phase == "update":
        note_parts.append("补充止盈/止损")
    if sig.sender:
        note_parts.append(f"发言人:{sig.sender}")
    note_parts.append(f"来源:telegram:{chat_id}")

    avatar = _channel_avatar_for_api(profile.get("avatar") or "")
    payload: dict[str, Any] = {
        "channelId": profile["channelId"],
        "channelName": profile["name"],
        "channelAvatar": avatar,
        "body": body,
        "symbol": sig.symbol,
        "entry": sig.entry or "",
        "targets": _split_targets(sig.take_profit),
        "stopLoss": sig.stop_loss or "",
        "direction": direction,
        "signalAt": iso,
        "note": " · ".join(note_parts),
        "source": "telegram",
        "sourceRef": f"tg:{chat_id}:{','.join(str(x) for x in sig.msg_ids[:5])}",
    }
    if sig.sender:
        payload["authorKey"] = sig.sender.strip()
        payload["sender"] = sig.sender.strip()
    if not payload["channelAvatar"]:
        payload.pop("channelAvatar", None)
    return payload


def post_card(payload: dict[str, Any]) -> dict[str, Any]:
    """同步 POST /api/v1/cards；成功返回 JSON，失败抛异常。"""
    key = get_cards_api_key()
    if not key:
        raise RuntimeError("未配置 CARDS_API_KEY（请在 discord-collector/.env 或根 .env 设置）")
    url = f"{get_cards_api_base_url()}/api/v1/cards"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "X-Cards-Api-Key": key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            body = json.loads(raw) if raw else {}
            if resp.status >= 400:
                raise RuntimeError(f"HTTP {resp.status}: {raw[:300]}")
            if isinstance(body, dict) and body.get("ok") is False:
                raise RuntimeError(str(body.get("error") or body))
            return body if isinstance(body, dict) else {"ok": True, "raw": body}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"HTTP {e.code}: {err_body}") from e
