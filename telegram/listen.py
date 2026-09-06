"""
实时监听新消息（events.NewMessage），适合信号/推送场景，避免轮询。

监听范围（monitored_groups.txt + channel_profiles.json）：
  - main_monitored：主要发车群（发车占比高）→ 写入 discord-collector 卡片 API
  - monitored：次要闲聊群（发车占比低）→ 规则整理后发到 push_chat
  - channel_profiles.json：UI「Telegram 实时」页展示的群（合并进监听，并 POST /api/telegram/live/ingest）

默认推送规则（两类群共用检测逻辑）：
  - 每群滚动缓存约 10 条消息
  - 检测到「币种 + 做多/做空」时触发
  - 先只有信号、尚无止盈止损：先发一版；再等最多 3 条或 5～10 分钟，补齐后再发

可选 AI 交易聚合（TELEGRAM_AI_TRADE_AGGREGATE=1）：仅对次要群生效，覆盖 push_chat 规则推送。

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

from config import (
    ai_trade_aggregate_enabled,
    get_cards_api_base_url,
    get_main_monitored_group_ids,
    get_monitored_group_ids,
    get_notify_forward_config,
    get_trade_context_flush_seconds,
    get_trade_context_window_size,
    monitored_groups_file_default,
    resolve_channel_profile,
    resolve_listen_chat_ids,
)
from logging_setup import setup_telethon_logging
from message_format import download_message_images, format_message_console, sender_display
from session import create_and_start_client
from trade_card_pusher import TradeCardPusher
from trade_context_aggregator import TradeContextAggregator
from trade_signal_detect import looks_like_trade_message
from trade_signal_pusher import TradeSignalPusher
from ui_feed_pusher import (
    UiFeedPusher,
    load_profile_chat_ids,
    parse_main_sender_patterns,
)


def _resolve_listen_chat_ids() -> tuple[list[int] | None, str]:
    return resolve_listen_chat_ids()


async def main() -> None:
    targets, source = _resolve_listen_chat_ids()
    profile_ids = load_profile_chat_ids()
    profile_set = set(profile_ids)

    # UI 实时页需要 channel_profiles 内的群；合并进监听集合
    if profile_ids:
        if targets is None:
            # 监听全部对话时无需改 targets
            pass
        else:
            merged = sorted(set(targets) | profile_set)
            if len(merged) != len(targets):
                print(
                    f"[+] 合并 channel_profiles → 监听 +{len(merged) - len(targets)} 个群",
                    flush=True,
                )
            targets = merged
            source = f"{source}+channel_profiles"

    if targets is not None and not targets:
        default_file = monitored_groups_file_default()
        print(
            "[!] 未配置要监听的群。\n"
            f"  请编辑 {default_file}：main_monitored= / monitored= …；或设置 TELEGRAM_*_GROUP_IDS，\n"
            "  或设置 TELEGRAM_TARGET_CHAT_IDS；或填写 channel_profiles.json。\n"
            "  若确需监听全部已加入对话，可设 TELEGRAM_LISTEN_ALL=1。",
            flush=True,
        )
        raise SystemExit(2)

    main_ids = set(get_main_monitored_group_ids())
    secondary_ids = set(get_monitored_group_ids())

    if targets is None:
        print(f"[!] 监听范围: {source}", flush=True)
    else:
        print(f"[+] 监听范围（{source}）: {targets}", flush=True)
    if main_ids:
        print(f"[+] 主发车群 → 卡片 API: {sorted(main_ids)}", flush=True)
    if secondary_ids:
        print(f"[+] 次要闲聊群 → push_chat: {sorted(secondary_ids)}", flush=True)
    if profile_ids:
        print(f"[+] UI 实时页群（channel_profiles）: {sorted(profile_ids)}", flush=True)
        for cid in sorted(profile_ids):
            main_raw = (resolve_channel_profile(cid).get("main") or "").strip()
            patterns = parse_main_sender_patterns(main_raw)
            if patterns:
                print(
                    f"    · chat={cid} main 过滤发言人: {patterns}",
                    flush=True,
                )

    client, _session_path = await create_and_start_client()

    chats = targets
    _notify_kw, push_ids = get_notify_forward_config()
    use_ai_aggregate = ai_trade_aggregate_enabled() and bool(push_ids)

    aggregator: TradeContextAggregator | None = None
    signal_pusher: TradeSignalPusher | None = None
    card_pusher: TradeCardPusher | None = None
    ui_feed = UiFeedPusher()
    if ui_feed.enabled() and profile_ids:
        print(
            f"[+] UI 实时推送 → {get_cards_api_base_url()}/api/telegram/live/ingest "
            f"（需 collect:ui；前端 /telegram）",
            flush=True,
        )
    elif profile_ids:
        print("[!] channel_profiles 已配置，但 CARDS API base 无效，UI 实时推送关闭", flush=True)

    if main_ids:
        card_pusher = TradeCardPusher()
        if card_pusher.enabled():
            print(
                f"[+] 主群建卡: {get_cards_api_base_url()}/api/v1/cards "
                f"（名称/头像见 channel_profiles.json，可后补）",
                flush=True,
            )
        else:
            print(
                "[!] 已配置 main_monitored，但未设置 CARDS_API_KEY，主群不会建卡",
                flush=True,
            )
            card_pusher = None

    if use_ai_aggregate:
        aggregator = TradeContextAggregator(client, push_ids)
        print(
            f"[+] 次要群 AI 聚合推送: 窗口={get_trade_context_window_size()} 条, "
            f"防抖={get_trade_context_flush_seconds()}s → push_chat={push_ids}",
            flush=True,
        )
    elif push_ids and secondary_ids:
        signal_pusher = TradeSignalPusher(client, push_ids)
        print(
            "[+] 次要群规则推送: 滚动窗口≈10 条 → push_chat="
            f"{push_ids}",
            flush=True,
        )
    elif secondary_ids and not push_ids:
        print("[*] 已配置 monitored 次要群，但未配置 push_chat，次要群仅打印", flush=True)

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
        chat_id = int(event.chat_id)

        # 配置在 channel_profiles 的群 → 推到 /telegram 实时页（含图片）
        if chat_id in profile_set:
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

        if not text or chat_id in push_ids:
            return

        if chat_id in main_ids:
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
                    "[!] 主群交易信号但未建卡：请配置 CARDS_API_KEY（discord-collector/.env）"
                    "并确保 collect:ui 在运行",
                    flush=True,
                )
            return

        if chat_id not in secondary_ids and targets is not None:
            # TELEGRAM_TARGET_CHAT_IDS / channel_profiles 扩展监听：默认按次要群处理
            pass

        if aggregator is not None:
            await aggregator.on_group_message(
                chat_id,
                msg_id=int(msg.id),
                sender=nick,
                text=text,
                title=str(title),
                at=msg.date,
            )
            return

        if signal_pusher is not None:
            await signal_pusher.on_group_message(
                chat_id,
                msg_id=int(msg.id),
                sender=nick,
                text=text,
                title=str(title),
                at=msg.date,
            )

    print("监听中，Ctrl+C 退出…")
    await client.run_until_disconnected()


if __name__ == "__main__":
    setup_telethon_logging()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
