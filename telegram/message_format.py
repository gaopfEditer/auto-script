"""消息行：发送者显示名 + 文本预览 + 图片等媒体说明/可选落盘。"""

from __future__ import annotations

import os
from pathlib import Path

from telethon import TelegramClient
from telethon.tl.types import Channel, Chat, User

_PKG = Path(__file__).resolve().parent


def media_download_enabled() -> bool:
    raw = os.environ.get("TELEGRAM_DOWNLOAD_MEDIA", "0").strip().lower()
    return raw in ("1", "true", "yes", "on")


def media_download_dir() -> Path:
    raw = os.environ.get("TELEGRAM_MEDIA_DIR", "").strip()
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else (_PKG.parent / p).resolve()
    return (_PKG / "media").resolve()


async def sender_display(client: TelegramClient, message) -> str:
    """群内昵称：用户姓名/@username；频道帖子可能带 post_author。"""
    pa = getattr(message, "post_author", None)
    if pa:
        return str(pa).strip() or str(message.sender_id)

    try:
        s = await message.get_sender()
    except Exception:
        return str(message.sender_id)

    if isinstance(s, User):
        fn = (getattr(s, "first_name", None) or "").strip()
        ln = (getattr(s, "last_name", None) or "").strip()
        name = f"{fn} {ln}".strip() or fn or ln
        un = getattr(s, "username", None)
        if un:
            name = f"{name} (@{un})".strip() if name else f"@{un}"
        return name or str(message.sender_id)

    if isinstance(s, Channel):
        title = (getattr(s, "title", None) or "").strip()
        un = getattr(s, "username", None)
        if title and un:
            return f"{title} (@{un})"
        return title or (f"@{un}" if un else str(message.sender_id))

    if isinstance(s, Chat):
        return (getattr(s, "title", None) or "").strip() or str(message.sender_id)

    return str(message.sender_id)


def text_preview(message, preview: int) -> str:
    text = message.message or ""
    if len(text) > preview:
        return text[:preview] + "..."
    return text


def media_type_hint(message) -> str:
    if getattr(message, "photo", None):
        return "[图片]"
    if getattr(message, "video", None):
        return "[视频]"
    if getattr(message, "sticker", None):
        return "[贴纸]"
    if getattr(message, "document", None):
        mime = getattr(message.document, "mime_type", None) or ""
        if mime.startswith("image/"):
            return "[图片文档]"
        return f"[文件 {mime}]" if mime else "[文件]"
    if getattr(message, "voice", None):
        return "[语音]"
    if getattr(message, "video_note", None):
        return "[视频消息]"
    if getattr(message, "poll", None):
        return "[投票]"
    if getattr(message, "media", None):
        return "[媒体]"
    return ""


async def media_download_paths(client: TelegramClient, message) -> list[str]:
    """在 TELEGRAM_DOWNLOAD_MEDIA=1 时把图片类消息存到 TELEGRAM_MEDIA_DIR。"""
    if not media_download_enabled():
        return []
    want = bool(getattr(message, "photo", None)) or bool(getattr(message, "sticker", None))
    if not want and getattr(message, "document", None):
        mime = getattr(message.document, "mime_type", None) or ""
        want = mime.startswith("image/")
    if not want:
        return []

    root = media_download_dir()
    root.mkdir(parents=True, exist_ok=True)
    if getattr(message, "photo", None):
        ext = ".jpg"
    elif getattr(message, "sticker", None):
        ext = ".webp"
    else:
        ext = ".jpg"
    dest = root / f"{message.chat_id}_{message.id}{ext}"
    try:
        path = await client.download_media(message, file=str(dest))
        return [str(path)] if path else []
    except Exception:
        return []


async def format_message_console(
    client: TelegramClient,
    message,
    *,
    preview: int,
    prefix: str,
) -> None:
    """打印一行摘要；若有下载则多打一行路径。"""
    nick = await sender_display(client, message)
    body = text_preview(message, preview)
    hint = media_type_hint(message)
    tail = f"{hint} {body!r}".strip() if (hint or body) else ""
    line = f"{prefix} id={message.id} sender_id={message.sender_id} 昵称={nick}"
    if tail:
        line = f"{line} {tail}"
    print(line, flush=True)

    paths = await media_download_paths(client, message)
    for p in paths:
        print(f"    → 已保存媒体: {p}", flush=True)
