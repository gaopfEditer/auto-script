"""
遍历已加入的群组/频道，并打印最近若干条消息。

须使用「用户账号」手机号登录；若用 Bot token 登录，Telegram 不允许调用 iter_dialogs（会报 BotMethodInvalidError）。

用法（在 telegram 目录或设置 PYTHONPATH）:
  cd telegram && python list_groups.py
"""

from __future__ import annotations

import asyncio
import os
import sys

from logging_setup import setup_telethon_logging
from message_format import format_message_console
from session import create_and_start_client

# 每条消息预览最大字符数
_PREVIEW = int(os.environ.get("TELEGRAM_MESSAGE_PREVIEW_LEN", "120"))


async def main() -> None:
    limit = int(os.environ.get("TELEGRAM_RECENT_MESSAGES", "10"))

    client, session_path = await create_and_start_client()

    me = await client.get_me()
    if getattr(me, "bot", False):
        print(
            "[!] 当前 .session 是 Bot 账号：本脚本要调用 iter_dialogs（列出对话），"
            "官方不允许 Bot 使用该接口，因此会报 BotMethodInvalidError。\n"
            "处理办法（二选一）：\n"
            "  A）改用用户号：删除或移走会话文件后，用手机号重新登录\n"
            f"      {session_path}（及同名的 .session-journal 若有）\n"
            "  B）保留 Bot：在 .env 另设 TELEGRAM_SESSION_NAME=例如 user_reader，"
            "再运行本脚本，在提示处输入手机号完成用户登录；Bot 与用户各占一个 .session。\n"
            "若只需 Bot 在已知群里收消息，可改用 listen.py 并配置 TELEGRAM_TARGET_CHAT_IDS。",
            flush=True,
        )
        await client.disconnect()
        raise SystemExit(2)

    async for dialog in client.iter_dialogs():
        if not (dialog.is_channel or dialog.is_group):
            continue
        print(f"群组/频道: {dialog.name} (id={dialog.id})")
        async for message in client.iter_messages(dialog, limit=limit):
            await format_message_console(
                client,
                message,
                preview=_PREVIEW,
                prefix=f"  [{message.date}]",
            )
        print()

    await client.disconnect()


if __name__ == "__main__":
    setup_telethon_logging()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
