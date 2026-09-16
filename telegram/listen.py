"""
实时监听新消息（events.NewMessage），适合信号/推送场景，避免轮询。

监听与建卡来源（唯一）：
  - channel_profiles.json → send 白名单

推送目标（唯一）：
  - discord-collector 归档卡片 → TELEGRAM_PUSH_CHAT_ID（collect:ui）

不再使用 monitored_groups.txt 的 main_monitored / monitored / push_chat 做监听或推送。

覆盖与例外：
  - TELEGRAM_TARGET_CHAT_IDS：非空时只监听其中 id（须落在 send 白名单内）
  - TELEGRAM_LISTEN_ALL=1：恢复监听所有已加入对话（流量大，慎用）

用法:
  cd telegram && python listen.py
"""

from __future__ import annotations

import asyncio
import os
import sys

from telethon import events

from config import (
    get_cards_api_base_url,
    get_target_chat_ids,
    load_cdp_send_chat_ids,
    resolve_channel_profile,
)
from logging_setup import setup_telethon_logging
from message_format import download_message_images, format_message_console, sender_display
from session import create_and_start_client
from trade_card_pusher import TradeCardPusher
from trade_signal_detect import looks_like_trade_message
from ui_feed_pusher import (
    UiFeedPusher,
    parse_main_sender_patterns,
)


def _resolve_listen_targets(send_ids: list[int]) -> tuple[list[int] | None, str]:
    """监听 chat 列表；建卡仍仅限 send 白名单。"""
    override = get_target_chat_ids()
    if override is not None:
        allowed = set(send_ids)
        filtered = [cid for cid in override if cid in allowed]
        skipped = [cid for cid in override if cid not in allowed]
        if skipped:
            print(
                f"[!] TELEGRAM_TARGET_CHAT_IDS 中不在 send 白名单，已忽略: {skipped}",
                flush=True,
            )
        if not filtered:
            print(
                "[!] TELEGRAM_TARGET_CHAT_IDS 与 send 白名单无交集，"
                "请检查 channel_profiles.json → send",
                flush=True,
            )
            return [], "TELEGRAM_TARGET_CHAT_IDS∩send"
        return sorted(filtered), "TELEGRAM_TARGET_CHAT_IDS∩send"
    if os.environ.get("TELEGRAM_LISTEN_ALL", "").strip().lower() in ("1", "true", "yes", "on"):
        return None, "TELEGRAM_LISTEN_ALL"
    return send_ids, "channel_profiles.send"


async def main() -> None:
    send_ids = load_cdp_send_chat_ids()
    targets, source = _resolve_listen_targets(send_ids)
    listen_all = targets is None and source == "TELEGRAM_LISTEN_ALL"

    if listen_all:
        print("[!] 监听范围: TELEGRAM_LISTEN_ALL（全部已加入对话；建卡仍仅 send 白名单）", flush=True)
    elif not send_ids:
        print(
            "[!] 未配置 send 白名单。\n"
            "  请在 channel_profiles.json 的 \"send\" 数组中填写来源群 id。",
            flush=True,
        )
        raise SystemExit(2)
    elif not targets:
        raise SystemExit(2)
    else:
        print(f"[+] 信号来源（{source}）: {targets}", flush=True)

    send_set = set(send_ids)
    card_route_ids = send_set

    for cid in sorted(send_set):
        profile = resolve_channel_profile(cid)
        name = profile.get("name") or str(cid)
        main_raw = (profile.get("main") or "").strip()
        patterns = parse_main_sender_patterns(main_raw)
        line = f"    · chat={cid}「{name}」"
        if patterns:
            line += f" main 过滤发言人: {patterns}"
        print(line, flush=True)

    push_chat = os.environ.get("TELEGRAM_PUSH_CHAT_ID", "").strip()
    if push_chat:
        print(
            f"[+] Telegram 推送目标: TELEGRAM_PUSH_CHAT_ID={push_chat} "
            f"（collect:ui 归档卡片后推送）",
            flush=True,
        )
    else:
        print(
            "[!] 未设置 TELEGRAM_PUSH_CHAT_ID（discord-collector/.env），"
            "建卡后不会推送到 Telegram 群",
            flush=True,
        )

    client, _session_path = await create_and_start_client()

    chats = targets
    card_pusher: TradeCardPusher | None = None
    ui_feed = UiFeedPusher()
    if ui_feed.enabled() and send_set:
        print(
            f"[+] UI 实时推送 → {get_cards_api_base_url()}/api/telegram/live/ingest "
            f"（仅 send 白名单群；前端 /telegram）",
            flush=True,
        )
    elif send_set:
        print("[!] send 白名单已配置，但 CARDS API base 无效，UI 实时推送关闭", flush=True)

    if card_route_ids:
        card_pusher = TradeCardPusher(client=client)
        if card_pusher.enabled():
            print(
                f"[+] 建卡 API: {get_cards_api_base_url()}/api/v1/cards "
                f"（仅 channel_profiles.send → 归档 → TG + CDP）",
                flush=True,
            )
        else:
            print(
                "[!] send 白名单已配置，但未设置 CARDS_API_KEY，不会建卡/推送/CDP",
                flush=True,
            )
            card_pusher = None

    @client.on(events.NewMessage(chats=chats))
    async def handler(event: events.NewMessage.Event) -> None:
        msg = event.message
        chat = await event.get_chat()
        title = getattr(chat, "title", None) or getattr(chat, "username", "") or str(event.chat_id)
        nick = await sender_display(client, msg)
        chat_id = int(event.chat_id)
        if not nick or str(nick).strip().lower() in ("none", "null"):
            nick = str(title) or f"TG {chat_id}"
        await format_message_console(
            client,
            msg,
            preview=200,
            prefix=f"[{msg.date}] {title} (chat={event.chat_id}) 发件人={nick}",
            omit_sender=True,
        )

        text = (msg.message or "").strip()

        if chat_id in send_set:
            image_paths: list[str] = []
            if getattr(msg, "media", None):
                image_paths = await download_message_images(client, msg)
            body = text
            if not body and not image_paths:
                if getattr(msg, "media", None):
                    body = "[media]"
            if body or image_paths:
                await asyncio.to_thread(
                    ui_feed.push_message,
                    chat_id=chat_id,
                    msg_id=int(msg.id),
                    sender=nick,
                    text=body,
                    title=str(title),
                    at=msg.date,
                    image_paths=image_paths,
                )

        if not text or chat_id not in card_route_ids:
            return

        if card_pusher is not None:
            await card_pusher.on_group_message(
                chat_id,
                msg_id=int(msg.id),
                sender=nick,
                text=text,
                title=str(title),
                at=msg.date,
            )
        elif looks_like_trade_message(text):
            print(
                "[!] send 白名单群有交易信号但未建卡：请配置 CARDS_API_KEY（discord-collector/.env）"
                "、TRADE_SIGNAL_AI_PUBLISH=1，并确保 collect:ui 在运行",
                flush=True,
            )

    print("监听中，Ctrl+C 退出…")
    await client.run_until_disconnected()


if __name__ == "__main__":
    setup_telethon_logging()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
