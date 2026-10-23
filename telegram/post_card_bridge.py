"""
Optional bridge: unified post_card pipeline → collector card payload.

Does not replace TradeCardPusher; call from experiments or new ingest paths.
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from post_card.adapters import from_telegram_message
from post_card.pipeline import PostCardPipeline
from post_card.schema import TradeCard

from cards_client import signal_to_card_payload
from trade_signal_detect import TradeSignal


def _card_to_trade_signal(card: TradeCard) -> TradeSignal:
    return TradeSignal(
        symbol=(card.symbol or "").replace("USDT", ""),
        direction=TradeCard.cn_from_api(card.direction),
        entry=card.entry,
        take_profit=card.take_profit,
        stop_loss=card.stop_loss,
        sender=card.author,
        msg_ids=[int(x) for x in card.message_ids if str(x).isdigit()],
    )


class TelegramPostCardBridge:
    def __init__(self) -> None:
        self._pipeline = PostCardPipeline()

    def ingest_message(
        self,
        *,
        text: str,
        chat_id: int,
        chat_title: str,
        msg_id: int,
        sender: str,
        at: datetime | None = None,
    ) -> list[dict[str, Any]]:
        card = from_telegram_message(
            text=text,
            chat_id=chat_id,
            chat_title=chat_title,
            msg_id=msg_id,
            sender=sender,
            at=at,
        )
        if not card:
            return []
        finalized = self._pipeline.ingest(card, now=at)
        payloads: list[dict[str, Any]] = []
        for c in finalized:
            sig = _card_to_trade_signal(c)
            payloads.append(
                signal_to_card_payload(
                    sig,
                    chat_id=chat_id,
                    chat_title=chat_title,
                    signal_at=c.opened_at,
                    raw_body="\n".join(c.raw_texts),
                )
            )
        return payloads
