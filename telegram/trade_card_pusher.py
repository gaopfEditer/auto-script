"""
主发车群（main_monitored）：检测到交易信号后写入 discord-collector 卡片 API。

策略（后台 card-signal-merge 负责合并）：
  1. 第一条开仓信号 → 立即建卡（initial）
  2. 第二条止盈止损 → 再建卡，body 拼接窗口内相关原文（带上第一条）
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from dataclasses import dataclass
from datetime import datetime, timezone

from cards_client import post_card, signal_to_card_payload
from config import get_cards_api_key
from trade_context_buffer import TradeContextBuffer, WindowMessage
from trade_signal_detect import (
    TradeSignal,
    looks_like_trade_message,
    parse_trade_text,
)


@dataclass
class PendingCard:
    key: str
    signal: TradeSignal
    chat_id: int
    chat_title: str = ""
    signal_at: datetime | None = None


class TradeCardPusher:
    def __init__(self) -> None:
        raw = os.environ.get("TELEGRAM_TRADE_SIGNAL_WINDOW", "10").strip()
        try:
            window = int(raw)
        except ValueError:
            window = 10
        self._window = max(5, window)
        self._buffer = TradeContextBuffer(max_size=self._window)
        self._pending: dict[str, PendingCard] = {}
        self._pushed_digest: set[str] = set()
        self._lock = asyncio.Lock()

    def enabled(self) -> bool:
        return bool(get_cards_api_key())

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
        merged: TradeSignal | None = None
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
                if not merged.symbol or not frag.symbol or merged.symbol == frag.symbol:
                    if (
                        not merged.direction
                        or not frag.direction
                        or merged.direction == frag.direction
                    ):
                        merged = merged.merge_from(frag)
        return merged if merged and merged.has_core else None

    def _merge_snap_with_current(
        self,
        snap: list[WindowMessage],
        current: TradeSignal | None,
        *,
        prefer_sender: str = "",
    ) -> TradeSignal | None:
        merged = self._merge_window(snap, prefer_sender=prefer_sender)
        if current is None:
            return merged
        if merged is None:
            return current if current.has_core or current.has_tpsl else None
        if current.has_core:
            if not merged.symbol or current.symbol == merged.symbol:
                merged = merged.merge_from(current)
        elif current.has_tpsl or current.entry:
            merged = merged.merge_from(current)
        return merged

    def _combine_raw_for_signal(
        self,
        snap: list[WindowMessage],
        sig: TradeSignal,
        *,
        prefer_sender: str = "",
    ) -> str:
        """第二条建卡时拼接窗口内相关原文（开仓 + 止盈止损）。"""
        msg_ids = set(sig.msg_ids)
        parts: list[str] = []
        seen: set[str] = set()

        ordered = list(snap)
        if prefer_sender:
            same = [m for m in ordered if (m.sender or "") == prefer_sender]
            rest = [m for m in ordered if (m.sender or "") != prefer_sender]
            ordered = same + rest

        for m in ordered:
            t = (m.text or "").strip()
            if not t or t in seen:
                continue
            in_ids = m.msg_id in msg_ids
            if not in_ids and not looks_like_trade_message(t):
                continue
            frag = parse_trade_text(t, sender=m.sender, msg_id=m.msg_id)
            if frag and sig.symbol:
                if frag.symbol and frag.symbol != sig.symbol:
                    continue
                if frag.has_core and frag.symbol and frag.symbol != sig.symbol:
                    continue
            parts.append(t)
            seen.add(t)

        src = (sig.source_text or "").strip()
        if src and src not in seen:
            parts.insert(0, src)

        return "\n\n".join(parts) if parts else src

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

            if not looks_like_trade_message(body):
                return

            current = parse_trade_text(body, sender=sender, msg_id=msg_id)
            merged = self._merge_snap_with_current(snap, current, prefer_sender=sender)
            if merged is None:
                return
            if not merged.sender:
                merged.sender = sender

            signal_at = at if isinstance(at, datetime) else datetime.now(timezone.utc)
            card_key = self._pending_key(chat_id, merged)
            pf = self._pending.get(card_key)

            if merged.has_core and merged.has_tpsl:
                phase = "update" if pf else "full"
                raw_body = self._combine_raw_for_signal(snap, merged, prefer_sender=sender)
                await self._post_card(
                    merged,
                    chat_id=chat_id,
                    title=title,
                    signal_at=signal_at,
                    phase=phase,
                    raw_body=raw_body,
                )
                self._clear_pending(card_key)
                return

            if merged.has_core and not merged.has_tpsl:
                if pf:
                    return
                await self._post_card(
                    merged,
                    chat_id=chat_id,
                    title=title,
                    signal_at=signal_at,
                    phase="initial",
                    raw_body=body,
                )
                self._pending[card_key] = PendingCard(
                    key=card_key,
                    signal=merged,
                    chat_id=chat_id,
                    chat_title=title,
                    signal_at=signal_at,
                )
                print(
                    f"    · 主群已发开仓卡 {merged.symbol}做{merged.direction}，"
                    "等待止盈止损补充",
                    flush=True,
                )

    def _clear_pending(self, key: str) -> None:
        self._pending.pop(key, None)

    async def _post_card(
        self,
        sig: TradeSignal,
        *,
        chat_id: int,
        title: str,
        signal_at: datetime | None,
        phase: str,
        raw_body: str = "",
    ) -> bool:
        payload = signal_to_card_payload(
            sig,
            chat_id=chat_id,
            chat_title=title,
            signal_at=signal_at,
            phase=phase,
            raw_body=raw_body,
        )
        digest = self._digest(
            f"{phase}:{payload.get('body')}:{payload.get('symbol')}:{payload.get('sourceRef')}"
        )
        if digest in self._pushed_digest:
            return False
        try:
            result = await asyncio.to_thread(post_card, payload)
        except Exception as e:
            print(f"[!] 建卡失败 chat={chat_id}: {e}", flush=True)
            return False
        self._pushed_digest.add(digest)
        if len(self._pushed_digest) > 500:
            self._pushed_digest = set(list(self._pushed_digest)[-250:])
        card = (result or {}).get("card") if isinstance(result, dict) else None
        cid = card.get("id") if isinstance(card, dict) else None
        tpsl = "含止盈止损" if sig.has_tpsl else "仅开仓"
        print(
            f"    → 主群已写入卡片({phase}/{tpsl}) {sig.symbol}做{sig.direction}"
            + (f" id={cid}" if cid is not None else ""),
            flush=True,
        )
        return True
