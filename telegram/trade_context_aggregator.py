"""滑动窗口 + 防抖 + Ollama 聚合 + 推送。"""

from __future__ import annotations

import asyncio
import hashlib
from typing import TYPE_CHECKING

from config import (
    ai_trade_aggregate_enabled,
    get_trade_context_flush_seconds,
    get_trade_context_window_size,
)
from trade_ai_aggregate import aggregate_window_messages, format_aggregate_telegram
from trade_context_buffer import TradeContextBuffer
from trade_notify import push_aggregate_text

if TYPE_CHECKING:
    from telethon import TelegramClient


class TradeContextAggregator:
    def __init__(self, client: TelegramClient, push_chat_ids: list[int]) -> None:
        self._client = client
        self._push_ids = list(push_chat_ids)
        self._buffer = TradeContextBuffer(max_size=get_trade_context_window_size())
        self._flush_sec = get_trade_context_flush_seconds()
        self._tasks: dict[int, asyncio.Task[None]] = {}
        self._last_hash: dict[int, str] = {}
        self._lock = asyncio.Lock()

    def enabled(self) -> bool:
        return ai_trade_aggregate_enabled() and bool(self._push_ids)

    async def on_group_message(
        self,
        chat_id: int,
        *,
        msg_id: int,
        sender: str,
        text: str,
        title: str,
        at,
    ) -> None:
        if not self.enabled():
            return
        body = (text or "").strip()
        if not body:
            return
        self._buffer.add(
            chat_id,
            msg_id=msg_id,
            sender=sender,
            text=body,
            at=at,
            title=title,
        )
        self._schedule_flush(chat_id)

    def _schedule_flush(self, chat_id: int) -> None:
        old = self._tasks.pop(chat_id, None)
        if old and not old.done():
            old.cancel()

        async def _run() -> None:
            try:
                await asyncio.sleep(self._flush_sec)
                await self.flush(chat_id)
            except asyncio.CancelledError:
                pass

        self._tasks[chat_id] = asyncio.create_task(_run())

    async def flush(self, chat_id: int) -> bool:
        async with self._lock:
            win = self._buffer.get(chat_id)
            if win is None or not win.pending_flush:
                return False
            messages = win.snapshot_for_ai()
            if not messages:
                win.clear_pending()
                return False

            try:
                result = await asyncio.to_thread(
                    aggregate_window_messages,
                    win.title,
                    messages,
                )
            except Exception as e:
                print(f"[!] AI 聚合失败 chat={chat_id}: {e}", flush=True)
                return False

            if not result or not result.get("hasTradeInfo"):
                win.clear_pending()
                return False

            text = format_aggregate_telegram(win.title, result, messages)
            digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
            if self._last_hash.get(chat_id) == digest:
                win.clear_pending()
                return False

            ok = await push_aggregate_text(self._client, text, dest_chat_ids=self._push_ids)
            if ok:
                self._last_hash[chat_id] = digest
                print(
                    f"    → AI 交易摘要已推送至 {ok}（{len(result.get('symbols') or [])} 个标的）",
                    flush=True,
                )
                win.clear_pending()
                return True
            return False
