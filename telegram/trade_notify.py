"""将聚合摘要发往 Telegram（HTTP API 或 Telethon）。"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import TYPE_CHECKING

from config import get_telegram_push_chat_ids, get_telegram_send_url

if TYPE_CHECKING:
    from telethon import TelegramClient


def send_text_via_http(chat_id: int, text: str) -> None:
    url = get_telegram_send_url()
    if not url:
        raise RuntimeError("未配置 TELEGRAM_SEND_URL")
    body = json.dumps({"chat_id": chat_id, "text": text}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        if resp.status >= 400:
            raise RuntimeError(f"HTTP {resp.status}: {raw[:200]}")


async def send_text_via_client(client: TelegramClient, chat_id: int, text: str) -> None:
    await client.send_message(chat_id, text, link_preview=False)


async def push_aggregate_text(
    client: TelegramClient | None,
    text: str,
    *,
    dest_chat_ids: list[int] | None = None,
) -> list[int]:
    """发送到配置的推送群；返回成功送达的 chat id。"""
    targets = dest_chat_ids if dest_chat_ids is not None else get_telegram_push_chat_ids()
    if not targets:
        return []
    ok: list[int] = []
    use_http = bool(get_telegram_send_url())
    for cid in targets:
        try:
            if use_http:
                import asyncio

                await asyncio.to_thread(send_text_via_http, cid, text)
            elif client is not None:
                await send_text_via_client(client, cid, text)
            else:
                raise RuntimeError("需要 TELEGRAM_SEND_URL 或 Telethon client")
            ok.append(cid)
        except (urllib.error.URLError, OSError, RuntimeError) as e:
            print(f"[!] 推送至 {cid} 失败: {e}", flush=True)
        except Exception as e:
            print(f"[!] 推送至 {cid} 失败: {type(e).__name__}: {e}", flush=True)
    return ok
