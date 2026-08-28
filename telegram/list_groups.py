"""
监听 monitored_groups.txt 中配置的群组/频道，打印最近消息并持续接收新消息。

默认仅 main_monitored ∪ monitored（与 listen.py 一致），不会打印其他已加入群。
若需监听全部对话，可设 TELEGRAM_LISTEN_ALL=1。

与 listen.py 的区别：本脚本只打印到终端，不建卡、不推送到 push_chat。
#prom 发车建卡 / 10 分钟合并请用 listen.py（TradeCardPusher → POST /api/v1/cards）。
前端检查群 id、时间范围与回测：discord-collector UI → /telegram。

须使用「用户账号」手机号登录；若用 Bot token 登录，Telegram 不允许调用 iter_dialogs（会报 BotMethodInvalidError）。
Bot 在配置了明确 chat id 时可仅做实时监听（设 TELEGRAM_RECENT_MESSAGES=0 跳过历史拉取）。

用法（在 telegram 目录或设置 PYTHONPATH）:
  cd telegram && python list_groups.py
"""

from __future__ import annotations

import asyncio
import os
import sys

from telethon import events

from config import (
    get_main_monitored_group_ids,
    monitored_groups_file_default,
    resolve_listen_chat_ids,
)
from logging_setup import setup_telethon_logging
from message_format import format_message_console, sender_display
from session import create_and_start_client
from trade_signal_detect import looks_like_trade_message

# 每条消息预览最大字符数
_PREVIEW = int(os.environ.get("TELEGRAM_MESSAGE_PREVIEW_LEN", "120"))


async def _print_recent_messages(client, chat_id: int, limit: int) -> None:
    try:
        entity = await client.get_entity(chat_id)
    except Exception as e:
        print(f"[!] 无法访问 id={chat_id}: {e}", flush=True)
        return
    title = getattr(entity, "title", None) or getattr(entity, "username", "") or str(chat_id)
    print(f"群组/频道: {title} (id={chat_id})")
    async for message in client.iter_messages(entity, limit=limit):
        await format_message_console(
            client,
            message,
            preview=_PREVIEW,
            prefix=f"  [{message.date}]",
        )
    print()


async def main() -> None:
    limit = int(os.environ.get("TELEGRAM_RECENT_MESSAGES", "10"))
    targets, source = resolve_listen_chat_ids()

    if targets is not None and not targets:
        default_file = monitored_groups_file_default()
        print(
            "[!] 未配置要监听的群。\n"
            f"  请编辑 {default_file}：main_monitored= / monitored= …；或设置 TELEGRAM_TARGET_CHAT_IDS。\n"
            "  若确需监听全部已加入对话，可设 TELEGRAM_LISTEN_ALL=1。",
            flush=True,
        )
        raise SystemExit(2)

    client, session_path = await create_and_start_client()

    me = await client.get_me()
    is_bot = bool(getattr(me, "bot", False))
    if is_bot and targets is None:
        print(
            "[!] 当前 .session 是 Bot 账号：监听全部对话需 iter_dialogs，"
            "官方不允许 Bot 使用该接口，因此会报 BotMethodInvalidError。\n"
            "处理办法（二选一）：\n"
            "  A）改用用户号：删除或移走会话文件后，用手机号重新登录\n"
            f"      {session_path}（及同名的 .session-journal 若有）\n"
            "  B）保留 Bot：在 .env 另设 TELEGRAM_SESSION_NAME=例如 user_reader，"
            "再运行本脚本，在提示处输入手机号完成用户登录；Bot 与用户各占一个 .session。\n"
            "若只需 Bot 在已知群里收消息，可配置 monitored_groups.txt 或 TELEGRAM_TARGET_CHAT_IDS。",
            flush=True,
        )
        await client.disconnect()
        raise SystemExit(2)

    if targets is None:
        print(f"[+] 监听范围: {source}", flush=True)
    else:
        print(f"[+] 仅监听（{source}）: {sorted(targets)}", flush=True)

    main_ids = set(get_main_monitored_group_ids())
    if main_ids:
        print(
            "[!] 当前是 list_groups.py：只打印消息，不会建卡、不会推送到 push_chat。\n"
            "    主群 main_monitored 要写入卡片 API，请改跑: python listen.py",
            flush=True,
        )

    if limit > 0:
        print(f"[*] 先拉取各群最近 {limit} 条历史…", flush=True)
        if targets is None and not is_bot:
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
        elif targets is not None:
            for chat_id in sorted(targets):
                await _print_recent_messages(client, chat_id, limit)
    else:
        print("[*] TELEGRAM_RECENT_MESSAGES=0，跳过历史拉取", flush=True)

    chats = targets

    @client.on(events.NewMessage(chats=chats))
    async def handler(event: events.NewMessage.Event) -> None:
        msg = event.message
        chat = await event.get_chat()
        title = getattr(chat, "title", None) or getattr(chat, "username", "") or str(event.chat_id)
        nick = await sender_display(client, msg)
        await format_message_console(
            client,
            msg,
            preview=_PREVIEW,
            prefix=f"[{msg.date}] {title} (chat={event.chat_id}) 发件人={nick}",
            omit_sender=True,
        )
        chat_id = int(event.chat_id)
        text = (msg.message or "").strip()
        if chat_id in main_ids and text and looks_like_trade_message(text):
            print(
                "    [!] 主群交易信号（list_groups 不会建卡）→ 请运行 python listen.py",
                flush=True,
            )

    print("监听中，Ctrl+C 退出…", flush=True)
    await client.run_until_disconnected()


if __name__ == "__main__":
    setup_telethon_logging()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
