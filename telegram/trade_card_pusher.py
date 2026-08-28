"""
主发车群（main_monitored）：检测到交易信号后写入 discord-collector 卡片 API。

策略：
  1. #prom + 方向（如「#prom 市价多」）→ 立即建卡；10 分钟内同 key 补充消息再 POST，靠后台合并更新同一张卡
  2. 普通开仓信号 → 立即建卡（initial）；补齐止盈止损 → 再建卡（update）
  3. 后台 card-signal-merge：#prom 默认 10 分钟窗口，其它 30 分钟
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta

from cards_client import post_card, signal_to_card_payload
from config import get_cards_api_key
from trade_context_buffer import TradeContextBuffer, WindowMessage
from trade_signal_detect import (
    TradeSignal,
    looks_like_trade_message,
    parse_trade_text,
)

# #prom 开仓后允许补充止盈/止损/币种的窗口
_PROM_MERGE_WINDOW = timedelta(minutes=10)


@dataclass
class PendingCard:
    key: str
    signal: TradeSignal
    chat_id: int
    chat_title: str = ""
    signal_at: datetime | None = None
    card_id: int | None = None
    is_prom: bool = False
    opened_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


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
        # #prom 尚无币种时用方向+发言人占位，避免与其它币种混卡
        sym = (sig.symbol or ("PROM" if sig.is_prom else "")).upper()
        who = (sig.sender or "").strip().lower() or "_"
        return f"{chat_id}:{sym}:{sig.direction}:{who}"

    def _digest(self, text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:20]

    def _expire_pending(self, now: datetime) -> None:
        dead = [
            k
            for k, p in self._pending.items()
            if p.is_prom and now - p.opened_at > _PROM_MERGE_WINDOW
        ]
        for k in dead:
            self._pending.pop(k, None)

    def _find_prom_pending(
        self, chat_id: int, sig: TradeSignal, now: datetime
    ) -> PendingCard | None:
        """同群同发言人、#prom 窗口内：允许币种从空补全后仍命中 pending。"""
        who = (sig.sender or "").strip().lower() or "_"
        for p in self._pending.values():
            if not p.is_prom or p.chat_id != chat_id:
                continue
            if now - p.opened_at > _PROM_MERGE_WINDOW:
                continue
            p_who = (p.signal.sender or "").strip().lower() or "_"
            if p_who != who:
                continue
            if p.signal.direction and sig.direction and p.signal.direction != sig.direction:
                continue
            if (
                p.signal.symbol
                and sig.symbol
                and p.signal.symbol.upper() != sig.symbol.upper()
            ):
                continue
            return p
        return None

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
        if merged and (merged.has_core or merged.has_prom_open or merged.has_tpsl):
            return merged
        return None

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
            return (
                current
                if current.has_core or current.has_prom_open or current.has_tpsl
                else None
            )
        if current.has_core or current.has_prom_open:
            if not merged.symbol or not current.symbol or current.symbol == merged.symbol:
                merged = merged.merge_from(current)
        elif current.has_tpsl or current.entry or current.is_prom:
            merged = merged.merge_from(current)
        return merged

    def _combine_raw_for_signal(
        self,
        snap: list[WindowMessage],
        sig: TradeSignal,
        *,
        prefer_sender: str = "",
    ) -> str:
        """建卡/更新时拼接窗口内相关原文（开仓 + 止盈止损）。"""
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
            now = datetime.now(timezone.utc)
            self._expire_pending(now)
            snap = win.snapshot_for_ai()

            if not looks_like_trade_message(body):
                return

            current = parse_trade_text(body, sender=sender, msg_id=msg_id)
            merged = self._merge_snap_with_current(snap, current, prefer_sender=sender)
            if merged is None:
                return
            if not merged.sender:
                merged.sender = sender

            signal_at = at if isinstance(at, datetime) else now
            if signal_at.tzinfo is None:
                signal_at = signal_at.replace(tzinfo=timezone.utc)

            # —— #prom 路径：立即建卡，10 分钟内任意补充都再 POST 合并 ——
            if merged.is_prom or self._find_prom_pending(chat_id, merged, now):
                await self._handle_prom(
                    merged,
                    chat_id=chat_id,
                    title=title,
                    signal_at=signal_at,
                    snap=snap,
                    sender=sender,
                    now=now,
                    current_body=body,
                )
                return

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
                    is_prom=False,
                    opened_at=now,
                )
                print(
                    f"    · 主群已发开仓卡 {merged.symbol}做{merged.direction}，"
                    "等待止盈止损补充",
                    flush=True,
                )

    async def _handle_prom(
        self,
        merged: TradeSignal,
        *,
        chat_id: int,
        title: str,
        signal_at: datetime,
        snap: list[WindowMessage],
        sender: str,
        now: datetime,
        current_body: str,
    ) -> None:
        merged.is_prom = True
        pf = self._find_prom_pending(chat_id, merged, now)
        if pf:
            merged = pf.signal.merge_from(merged)
            merged.is_prom = True
            if not merged.sender:
                merged.sender = sender

        # 尚无币种：仅开仓意图时先本地 pending，等同窗口补币种再发；
        # 若已有方向且用户约定「马上发卡」，用占位符号 PROM 建卡（后续合并更新真实币种需同 channel+author）
        if not merged.symbol:
            if not merged.direction:
                return
            # 仍无 pending：记下等待币种
            if not pf:
                key = self._pending_key(chat_id, merged)
                self._pending[key] = PendingCard(
                    key=key,
                    signal=merged,
                    chat_id=chat_id,
                    chat_title=title,
                    signal_at=signal_at,
                    is_prom=True,
                    opened_at=now,
                )
                print(
                    f"    · #prom 已见方向「{merged.direction}」，等待币种后建卡（10 分钟内）",
                    flush=True,
                )
                return
            # 有 pending 但仍无币种：只刷新窗口正文，不重复 POST
            pf.signal = merged
            return

        raw_body = self._combine_raw_for_signal(snap, merged, prefer_sender=sender)
        if not raw_body:
            raw_body = current_body

        if pf is None:
            # 首次：立即建卡
            result = await self._post_card(
                merged,
                chat_id=chat_id,
                title=title,
                signal_at=signal_at,
                phase="initial",
                raw_body=raw_body,
                merge_window_ms=int(_PROM_MERGE_WINDOW.total_seconds() * 1000),
            )
            card_id = None
            if isinstance(result, dict):
                card = result.get("card")
                if isinstance(card, dict) and card.get("id") is not None:
                    try:
                        card_id = int(card["id"])
                    except (TypeError, ValueError):
                        card_id = None
            key = self._pending_key(chat_id, merged)
            self._pending[key] = PendingCard(
                key=key,
                signal=merged,
                chat_id=chat_id,
                chat_title=title,
                signal_at=signal_at,
                card_id=card_id,
                is_prom=True,
                opened_at=now,
            )
            print(
                f"    · #prom 已建卡 {merged.symbol}做{merged.direction}"
                + (f" id={card_id}" if card_id else "")
                + "，10 分钟内补充消息将合并更新",
                flush=True,
            )
            return

        # 窗口内更新：再 POST，服务端按 10 分钟窗口合并
        # 若币种刚补上，key 可能变化，迁移 pending
        old_key = pf.key
        await self._post_card(
            merged,
            chat_id=chat_id,
            title=title,
            signal_at=signal_at,
            phase="update",
            raw_body=raw_body,
            merge_window_ms=int(_PROM_MERGE_WINDOW.total_seconds() * 1000),
        )
        new_key = self._pending_key(chat_id, merged)
        pf.signal = merged
        pf.key = new_key
        if new_key != old_key:
            self._pending.pop(old_key, None)
            self._pending[new_key] = pf
        if merged.has_tpsl:
            print(
                f"    · #prom 已合并止盈止损 → {merged.symbol}做{merged.direction}",
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
        merge_window_ms: int | None = None,
    ) -> dict | bool:
        payload = signal_to_card_payload(
            sig,
            chat_id=chat_id,
            chat_title=title,
            signal_at=signal_at,
            phase=phase,
            raw_body=raw_body,
            merge_window_ms=merge_window_ms,
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
        tag = "#prom " if sig.is_prom else ""
        print(
            f"    → 主群已写入卡片({tag}{phase}/{tpsl}) {sig.symbol or '?'}做{sig.direction}"
            + (f" id={cid}" if cid is not None else ""),
            flush=True,
        )
        return result if isinstance(result, dict) else True
