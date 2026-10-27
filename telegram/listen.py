"""
实时监听新消息（events.NewMessage），适合信号/推送场景，避免轮询。

监听与建卡来源：
  - channel_profiles.json → send 白名单
  - channel_profiles.json → 含 only_names 的群（按发言人模糊匹配后建卡推 TG）

推送目标：
  - discord-collector 归档卡片 → TELEGRAM_PUSH_CHAT_ID（collect:ui）
  - CDP 发布仍仅 send 白名单群

覆盖与例外：
  - TELEGRAM_TARGET_CHAT_IDS：非空时只监听其中 id（须落在上述来源内）
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
)
from logging_setup import setup_telethon_logging
from message_format import download_message_images, format_message_console, sender_display
from session import create_and_start_client
from signal_pipeline_log import log_pipeline
from trade_card_pusher import TradeCardPusher
from trade_signal_detect import looks_like_trade_message, strip_promotional_lines
from ui_feed_pusher import (
    UiFeedPusher,
    get_profile_meta,
    load_card_route_chat_ids,
    load_cdp_send_chat_ids,
    load_only_names_chat_ids,
    parse_only_names_patterns,
    sender_filter_patterns,
)


def _resolve_listen_targets(route_ids: list[int]) -> tuple[list[int] | None, str]:
    """监听 chat 列表；建卡范围与 route_ids 一致。"""
    override = get_target_chat_ids()
    # 未设置 TELEGRAM_TARGET_CHAT_IDS 时 get_target_chat_ids() 返回 []，不能当作 override
    if override:
        allowed = set(route_ids)
        filtered = [cid for cid in override if cid in allowed]
        skipped = [cid for cid in override if cid not in allowed]
        if skipped:
            print(
                f"[!] TELEGRAM_TARGET_CHAT_IDS 中不在监听来源，已忽略: {skipped}",
                flush=True,
            )
        if not filtered:
            print(
                "[!] TELEGRAM_TARGET_CHAT_IDS 与监听来源无交集，"
                "已回退为 send ∪ only_names",
                flush=True,
            )
            return route_ids, "card_route(fallback)"
        return sorted(filtered), "TELEGRAM_TARGET_CHAT_IDS∩route"
    if os.environ.get("TELEGRAM_LISTEN_ALL", "").strip().lower() in ("1", "true", "yes", "on"):
        return None, "TELEGRAM_LISTEN_ALL"
    return route_ids, "send∪only_names"


async def main() -> None:
    send_ids = load_cdp_send_chat_ids()
    only_names_ids = load_only_names_chat_ids()
    route_ids = load_card_route_chat_ids()
    targets, source = _resolve_listen_targets(route_ids)
    listen_all = targets is None and source == "TELEGRAM_LISTEN_ALL"

    if listen_all:
        print(
            "[!] 监听范围: TELEGRAM_LISTEN_ALL（全部已加入对话；建卡仍仅 send∪only_names）",
            flush=True,
        )
    elif not route_ids:
        print(
            "[!] 未配置监听来源。\n"
            "  请在 channel_profiles.json 配置 send 和/或 only_names 群。",
            flush=True,
        )
        raise SystemExit(2)
    elif not targets:
        raise SystemExit(2)
    else:
        print(f"[+] 信号来源（{source}）: {targets}", flush=True)
        if only_names_ids:
            extra = sorted(set(only_names_ids) - set(send_ids))
            if extra:
                print(f"[+] only_names 群（发言人过滤后建卡推 TG）: {extra}", flush=True)
        if send_ids:
            print(f"[+] send 白名单（建卡 + TG + CDP）: {sorted(send_ids)}", flush=True)

    send_set = set(send_ids)
    card_route_ids = set(route_ids)

    for cid in sorted(card_route_ids):
        profile = get_profile_meta(cid)
        name = profile.get("name") or str(cid)
        patterns = sender_filter_patterns(profile)
        line = f"    · chat={cid}「{name}」"
        if parse_only_names_patterns(profile.get("only_names")):
            line += f" only_names 过滤: {patterns}"
        elif patterns:
            line += f" main 过滤发言人: {patterns}"
        if cid in send_set:
            line += " [CDP]"
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
    if ui_feed.enabled() and card_route_ids:
        print(
            f"[+] UI 实时推送 → {get_cards_api_base_url()}/api/telegram/live/ingest "
            f"（send∪only_names 群；前端 /telegram）",
            flush=True,
        )
    elif card_route_ids:
        print("[!] 监听来源已配置，但 CARDS API base 无效，UI 实时推送关闭", flush=True)

    if card_route_ids:
        card_pusher = TradeCardPusher(client=client)
        if card_pusher.enabled():
            print(
                f"[+] 建卡 API: {get_cards_api_base_url()}/api/v1/cards "
                f"（send∪only_names → 归档 → TG；CDP 仅 send）",
                flush=True,
            )
        else:
            print(
                "[!] 监听来源已配置，但未设置 CARDS_API_KEY，不会建卡/推送/CDP",
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

        text = strip_promotional_lines((msg.message or "").strip())

        if chat_id in card_route_ids:
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

        if chat_id in card_route_ids and text:
            log_pipeline(
                "received",
                chat_id=chat_id,
                msg_id=int(msg.id),
                sender=nick,
                body=text,
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
