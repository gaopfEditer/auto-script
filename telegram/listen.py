"""
实时监听新消息（events.NewMessage），适合信号/推送场景，避免轮询。

默认仅监听与 poll_groups 相同的列表：telegram/monitored_groups.txt
及环境变量 TELEGRAM_MONITORED_GROUP_IDS（见 config.get_monitored_group_ids）。

默认推送（monitored_groups.txt 配 push_chat + sender_keywords）：
  - 发件人展示名包含任一关键词时，原样 forward 到 push_chat 群

可选 AI 交易聚合（TELEGRAM_AI_TRADE_AGGREGATE=1 时）：
  - 滑动窗口 + Ollama 提取交易摘要后推送（不逐条转发闲聊）

覆盖与例外：
  - TELEGRAM_TARGET_CHAT_IDS：非空时只监听其中 id（优先级最高）
  - TELEGRAM_LISTEN_ALL=1：恢复监听所有已加入对话（流量大，慎用）

用法:
  cd telegram && python listen.py
"""

from __future__ import annotations

import asyncio
import os
import sys

from telethon import events
from telethon.errors import FloodWaitError

from config import (
    ai_trade_aggregate_enabled,
    get_monitored_group_ids,
    get_notify_forward_config,
    get_target_chat_ids,
    get_trade_context_flush_seconds,
    get_trade_context_window_size,
    monitored_groups_file_default,
)
from logging_setup import setup_telethon_logging
from message_format import format_message_console, sender_display
from session import create_and_start_client
from trade_context_aggregator import TradeContextAggregator


def _resolve_listen_chat_ids() -> tuple[list[int] | None, str]:
    """
    返回 (chats 列表或 None 表示全部, 人类可读说明)。
    """
    if os.environ.get("TELEGRAM_LISTEN_ALL", "").strip().lower() in ("1", "true", "yes", "on"):
        return None, "TELEGRAM_LISTEN_ALL=1（所有已加入对话）"
    env = get_target_chat_ids()
    if env:
        return env, "TELEGRAM_TARGET_CHAT_IDS"
    file_ids = get_monitored_group_ids()
    if file_ids:
        return file_ids, "monitored_groups.txt / TELEGRAM_MONITORED_GROUP_IDS"
    return [], ""


async def main() -> None:
    targets, source = _resolve_listen_chat_ids()
    if targets is not None and not targets:
        default_file = monitored_groups_file_default()
        print(
            "[!] 未配置要监听的群。\n"
            f"  请编辑 {default_file}：monitored=-100xxx,... 或每行纯 id；或设置 TELEGRAM_MONITORED_GROUP_IDS，\n"
            "  或设置 TELEGRAM_TARGET_CHAT_IDS。\n"
            "  若确需监听全部已加入对话，可设 TELEGRAM_LISTEN_ALL=1。",
            flush=True,
        )
        raise SystemExit(2)

    if targets is None:
        print(f"[!] 监听范围: {source}", flush=True)
    else:
        print(f"[+] 监听范围（{source}）: {targets}", flush=True)

    client, _session_path = await create_and_start_client()

    chats = targets
    notify_kw, push_ids = get_notify_forward_config()
    use_ai_aggregate = ai_trade_aggregate_enabled() and bool(push_ids)
    aggregator: TradeContextAggregator | None = None
    if use_ai_aggregate:
        aggregator = TradeContextAggregator(client, push_ids)
        print(
            f"[+] AI 交易聚合推送: 窗口={get_trade_context_window_size()} 条, "
            f"防抖={get_trade_context_flush_seconds()}s → push_chat={push_ids}",
            flush=True,
        )
    elif notify_kw and push_ids:
        print(
            f"[+] 关键词原样转发: 子串={notify_kw!r} → 推送 chat(s)={push_ids}",
            flush=True,
        )
    elif notify_kw or push_ids:
        print(
            "[*] 推送未完全配置（需 push_chat + sender_keywords；或设 TELEGRAM_AI_TRADE_AGGREGATE=1 走 AI 聚合）",
            flush=True,
        )

    @client.on(events.NewMessage(chats=chats))
    async def handler(event: events.NewMessage.Event) -> None:
        msg = event.message
        chat = await event.get_chat()
        title = getattr(chat, "title", None) or getattr(chat, "username", "") or str(event.chat_id)
        nick = await sender_display(client, msg)
        await format_message_console(
            client,
            msg,
            preview=200,
            prefix=f"[{msg.date}] {title} (chat={event.chat_id}) 发件人={nick}",
            omit_sender=True,
        )

        text = (msg.message or "").strip()
        if aggregator is not None and text:
            await aggregator.on_group_message(
                int(event.chat_id),
                msg_id=int(msg.id),
                sender=nick,
                text=text,
                title=str(title),
                at=msg.date,
            )
            return

        if (
            push_ids
            and notify_kw
            and event.chat_id not in push_ids
            and any(s in nick for s in notify_kw)
        ):
            from_peer = await event.get_input_chat()
            for dest in push_ids:
                if dest == event.chat_id:
                    continue
                try:
                    await client.forward_messages(dest, msg, from_peer=from_peer)
                    print(f"    → 已转发至 chat={dest}", flush=True)
                except FloodWaitError as e:
                    print(f"[!] 转发至 {dest} FloodWait {e.seconds}s，跳过", flush=True)
                except Exception as e:
                    print(f"[!] 转发至 {dest} 失败: {type(e).__name__}: {e}", flush=True)

    print("监听中，Ctrl+C 退出…")
    await client.run_until_disconnected()


if __name__ == "__main__":
    setup_telethon_logging()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
