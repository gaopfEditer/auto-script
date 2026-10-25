"""
Telegram 群组历史回溯：按时间正序重放消息，复用 TradeCardPusher 与 listen.py 相同的
过滤 / 窗口合并 / #prom / pending / 建卡判定（不实际 POST 卡片 API）。
"""

from __future__ import annotations

import os
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime

from cards_client import signal_to_card_payload
from trade_card_pusher import TradeCardPusher
from trade_signal_detect import (
    is_push_bypass_message,
    is_spam_or_recap_message,
    looks_like_trade_message,
    strip_promotional_lines,
)


MAX_BACKFILL_CARDS = int(os.environ.get("TELEGRAM_BACKFILL_MAX_CARDS", "400") or "400")


@dataclass
class BackfillChatStats:
    message_count: int = 0
    trade_like_count: int = 0
    card_emit_count: int = 0
    symbols: Counter[str] = field(default_factory=Counter)
    samples: list[dict] = field(default_factory=list)
    cards: list[dict] = field(default_factory=list)


class BackfillReplayPusher(TradeCardPusher):
    """与主群建卡同逻辑；_post_card 仅计数、不写 API。"""

    def __init__(self, prior_digests: set[str] | None = None) -> None:
        super().__init__(client=None)
        self.stats = BackfillChatStats()
        self._current_msg_id: int = 0
        if prior_digests:
            self._pushed_digest = set(prior_digests)

    def enabled(self) -> bool:
        return True

    async def _post_card(
        self,
        sig,
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
        body_text = str(payload.get("body") or "")
        digest = self._digest(
            f"{phase}:{body_text}:{payload.get('symbol')}:{payload.get('sourceRef')}"
        )
        if digest in self._pushed_digest and not is_push_bypass_message(body_text):
            return False
        self._pushed_digest.add(digest)
        if len(self._pushed_digest) > 500:
            self._pushed_digest = set(list(self._pushed_digest)[-250:])

        sym = str(payload.get("symbol") or sig.symbol or "").strip().upper()
        pending_sym = "\u5f85\u8865\u5145"
        if sym and sym not in (pending_sym, "?"):
            self.stats.symbols[sym] += 1
        self.stats.card_emit_count += 1

        preview_src = (raw_body or body_text or "").strip()
        s = " ".join(preview_src.split()) if preview_src else ""
        if len(s) > 160:
            s = s[:159] + "…"
        at_iso = ""
        if signal_at is not None:
            at_iso = signal_at.isoformat()
        direction_norm = str(payload.get("direction") or "").strip().lower()
        entry_val = str(payload.get("entry") or sig.entry or "").strip()
        sl_val = str(payload.get("stopLoss") or sig.stop_loss or "").strip()
        targets_raw = payload.get("targets")
        if not isinstance(targets_raw, list):
            targets_raw = []
        targets_list = [str(x).strip() for x in targets_raw if str(x).strip()]
        card_payload = {
            "symbol": payload.get("symbol") or sym,
            "direction": direction_norm or payload.get("direction"),
            "entry": entry_val or None,
            "stopLoss": sl_val or None,
            "targets": targets_list,
            "signalAt": payload.get("signalAt") or at_iso or None,
            "body": body_text[:800] if body_text else None,
            "channelId": str(payload.get("channelId") or chat_id),
            "sourceRef": payload.get("sourceRef"),
        }
        card_row = {
            "digest": digest,
            "msgId": self._current_msg_id or None,
            "phase": phase,
            "symbol": sym or None,
            "direction": sig.direction or None,
            "directionNorm": direction_norm or None,
            "signalAt": at_iso or None,
            "at": at_iso or None,
            "entry": entry_val or None,
            "stopLoss": sl_val or None,
            "targets": targets_list,
            "preview": s or None,
            "cardPayload": card_payload,
        }
        if len(self.stats.cards) < MAX_BACKFILL_CARDS:
            self.stats.cards.append(card_row)
        if len(self.stats.samples) < 8 and s:
            self.stats.samples.append(
                {
                    "phase": phase,
                    "symbol": sym or None,
                    "direction": sig.direction or None,
                    "at": at_iso,
                    "preview": s,
                }
            )
        return {"card": {"id": self.stats.card_emit_count}}


async def replay_chat_messages(
    pusher: BackfillReplayPusher,
    chat_id: int,
    title: str,
    messages: list[tuple[int, str, str, datetime]],
) -> BackfillChatStats:
    """
    messages: (msg_id, sender, text, at) 按时间从旧到新。
    """
    for msg_id, sender, text, at in messages:
        pusher._current_msg_id = int(msg_id)
        body = strip_promotional_lines((text or "").strip())
        if not body:
            continue
        pusher.stats.message_count += 1
        if is_spam_or_recap_message(body):
            continue
        if looks_like_trade_message(body):
            pusher.stats.trade_like_count += 1
        await pusher.on_group_message(
            chat_id,
            msg_id=msg_id,
            sender=sender,
            text=text,
            title=title,
            at=at,
        )
    return pusher.stats
