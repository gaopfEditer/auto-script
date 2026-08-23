"""
每群滚动缓存消息，检测到交易逻辑后推送到目标群。

流程：
1. 缓存最近 N 条（默认 10）
2. 消息含「币种 + 做多/做空」→ 立即推送一版信号
3. 若当时没有止盈/止损：再等最多 3 条新消息，或 5～10 分钟超时；
   窗口内补齐止盈/止损后，再推一条补充消息
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import random
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from trade_context_buffer import TradeContextBuffer, WindowMessage
from trade_notify import push_aggregate_text
from trade_signal_detect import (
    TradeSignal,
    format_signal_push,
    looks_like_trade_message,
    parse_trade_text,
)

if TYPE_CHECKING:
    from telethon import TelegramClient


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass
class PendingFollowUp:
    key: str
    signal: TradeSignal
    msgs_after: int = 0
    deadline_ts: float = 0.0
    task: asyncio.Task[None] | None = field(default=None, repr=False)


class TradeSignalPusher:
    def __init__(self, client: TelegramClient, push_chat_ids: list[int]) -> None:
        self._client = client
        self._push_ids = list(push_chat_ids)
        self._window = max(5, _env_int("TELEGRAM_TRADE_SIGNAL_WINDOW", 10))
        self._follow_msgs = max(1, _env_int("TELEGRAM_TRADE_FOLLOW_MSGS", 3))
        self._wait_min = max(60.0, _env_float("TELEGRAM_TRADE_FOLLOW_WAIT_MIN_SEC", 300))
        self._wait_max = max(self._wait_min, _env_float("TELEGRAM_TRADE_FOLLOW_WAIT_MAX_SEC", 600))
        self._buffer = TradeContextBuffer(max_size=self._window)
        self._pending: dict[str, PendingFollowUp] = {}
        self._pushed_digest: set[str] = set()
        self._lock = asyncio.Lock()

    def enabled(self) -> bool:
        return bool(self._push_ids)

    def _pending_key(self, chat_id: int, sig: TradeSignal) -> str:
        return f"{chat_id}:{sig.symbol}:{sig.direction}"

    def _digest(self, text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:20]

    def _merge_window(
        self,
        messages: list[WindowMessage],
        *,
        prefer_sender: str = "",
    ) -> TradeSignal | None:
        """从窗口由新到旧合并同一交易意图。"""
        merged: TradeSignal | None = None
        # 先同发件人
        ordered = list(reversed(messages))
        if prefer_sender:
            same = [m for m in ordered if (m.sender or "") == prefer_sender]
            rest = [m for m in ordered if (m.sender or "") != prefer_sender]
            ordered = same + rest

        for m in ordered:
            frag = parse_trade_text(m.text, sender=m.sender, msg_id=m.msg_id)
            if frag is None:
                continue
            if merged is None:
                merged = frag
            else:
                # 同币种或尚无币种时才合并碎片
                if (
                    not merged.symbol
                    or not frag.symbol
                    or merged.symbol == frag.symbol
                ):
                    if (
                        not merged.direction
                        or not frag.direction
                        or merged.direction == frag.direction
                    ):
                        merged = merged.merge_from(frag)
        return merged if merged and merged.has_core else None

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
        win = self._buffer.get(chat_id)
        if win is None:
            return

        async with self._lock:
            snap = win.snapshot_for_ai()

            # 1) 用当前窗口刷新已在等待的信号；补齐止盈止损则立刻补推
            await self._refresh_pending_from_window(chat_id, snap)

            # 2) 任意新消息都计入「再等 N 条」
            await self._tick_pending_message_quota(chat_id, snap)

            if not looks_like_trade_message(body):
                return

            current = parse_trade_text(body, sender=sender, msg_id=msg_id)
            merged = self._merge_window(snap, prefer_sender=sender)
            if merged is None and current and current.has_core:
                merged = current
            if merged is None:
                return
            if current and current.has_core and current.symbol == merged.symbol:
                merged = merged.merge_from(current)
            if not merged.sender:
                merged.sender = sender

            key = self._pending_key(chat_id, merged)
            if key in self._pending:
                # 仍在等待同一标的：上面 refresh 已处理 TP/SL
                return

            if merged.has_tpsl:
                await self._push_text(format_signal_push(merged, phase="full"), tag="full")
                return

            ok = await self._push_text(
                format_signal_push(merged, phase="initial"),
                tag="initial",
            )
            if not ok:
                return
            wait_sec = random.uniform(self._wait_min, self._wait_max)
            pf = PendingFollowUp(
                key=key,
                signal=merged,
                msgs_after=0,
                deadline_ts=time.time() + wait_sec,
            )
            self._pending[key] = pf
            pf.task = asyncio.create_task(self._wait_timeout(key, wait_sec))
            print(
                f"    · 已推送先信号 {merged.symbol}做{merged.direction}，"
                f"等待≤{self._follow_msgs}条或 {wait_sec:.0f}s 补止盈止损",
                flush=True,
            )

    async def _refresh_pending_from_window(
        self,
        chat_id: int,
        snap: list[WindowMessage],
    ) -> None:
        prefix = f"{chat_id}:"
        done: list[str] = []
        for key, pf in list(self._pending.items()):
            if not key.startswith(prefix):
                continue
            refreshed = self._merge_window(snap, prefer_sender=pf.signal.sender)
            if refreshed and refreshed.symbol == pf.signal.symbol:
                if (
                    not pf.signal.direction
                    or not refreshed.direction
                    or refreshed.direction == pf.signal.direction
                ):
                    before = pf.signal.has_tpsl
                    pf.signal = pf.signal.merge_from(refreshed)
                    if pf.signal.has_tpsl and not before:
                        await self._push_update(pf)
                        done.append(key)
        for k in done:
            self._clear_pending(k)

    async def _tick_pending_message_quota(
        self,
        chat_id: int,
        snap: list[WindowMessage],
    ) -> None:
        prefix = f"{chat_id}:"
        done: list[str] = []
        for key, pf in list(self._pending.items()):
            if not key.startswith(prefix):
                continue
            pf.msgs_after += 1
            if pf.msgs_after < self._follow_msgs:
                continue
            refreshed = self._merge_window(snap, prefer_sender=pf.signal.sender)
            if refreshed and refreshed.symbol == pf.signal.symbol:
                pf.signal = pf.signal.merge_from(refreshed)
            if pf.signal.has_tpsl:
                await self._push_update(pf)
            else:
                print(
                    f"    · {pf.signal.symbol}做{pf.signal.direction} "
                    f"已过 {self._follow_msgs} 条仍无止盈止损，结束等待",
                    flush=True,
                )
            done.append(key)
        for k in done:
            self._clear_pending(k)

    async def _wait_timeout(self, key: str, wait_sec: float) -> None:
        try:
            await asyncio.sleep(wait_sec)
        except asyncio.CancelledError:
            return
        async with self._lock:
            pf = self._pending.get(key)
            if pf is None:
                return
            chat_id = int(key.split(":", 1)[0])
            win = self._buffer.get(chat_id)
            if win is not None:
                refreshed = self._merge_window(
                    win.snapshot_for_ai(),
                    prefer_sender=pf.signal.sender,
                )
                if refreshed and refreshed.symbol == pf.signal.symbol:
                    pf.signal = pf.signal.merge_from(refreshed)
            if pf.signal.has_tpsl:
                await self._push_update(pf)
            else:
                print(
                    f"    · {pf.signal.symbol}做{pf.signal.direction} "
                    f"等待超时仍无止盈止损，结束",
                    flush=True,
                )
            self._clear_pending(key)

    def _clear_pending(self, key: str) -> None:
        pf = self._pending.pop(key, None)
        if pf and pf.task and not pf.task.done():
            pf.task.cancel()

    async def _push_update(self, pf: PendingFollowUp) -> None:
        text = format_signal_push(pf.signal, phase="update")
        await self._push_text(text, tag="update")

    async def _push_text(self, text: str, *, tag: str) -> bool:
        digest = self._digest(f"{tag}:{text}")
        if digest in self._pushed_digest:
            return False
        ok = await push_aggregate_text(self._client, text, dest_chat_ids=self._push_ids)
        if ok:
            self._pushed_digest.add(digest)
            if len(self._pushed_digest) > 500:
                self._pushed_digest = set(list(self._pushed_digest)[-250:])
            print(f"    → 交易信号已推送({tag}) 至 {ok}", flush=True)
            return True
        return False
