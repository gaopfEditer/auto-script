"""
实时监听新消息（events.NewMessage），适合信号/推送场景，避免轮询。

可选环境变量 TELEGRAM_TARGET_CHAT_IDS：逗号分隔的 chat id，仅在这些对话中触发；
未设置则对所有已加入对话生效（流量大时请尽量配置过滤）。

用法:
  cd telegram && python listen.py
"""

from __future__ import annotations

import asyncio
import sys

from telethon import events

from config import get_target_chat_ids
from logging_setup import setup_telethon_logging
from message_format import format_message_console
from session import create_and_start_client


async def main() -> None:
    targets = get_target_chat_ids()
    if targets:
        print(f"[+] 仅监听 chat ids: {targets}", flush=True)

    client, _session_path = await create_and_start_client()

    chats = targets if targets else None

    @client.on(events.NewMessage(chats=chats))
    async def handler(event: events.NewMessage.Event) -> None:
        msg = event.message
        chat = await event.get_chat()
        title = getattr(chat, "title", None) or getattr(chat, "username", "") or str(event.chat_id)
        await format_message_console(
            client,
            msg,
            preview=200,
            prefix=f"[{msg.date}] {title} ({event.chat_id})",
        )

    print("监听中，Ctrl+C 退出…")
    await client.run_until_disconnected()


if __name__ == "__main__":
    setup_telethon_logging()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
