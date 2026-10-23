"""Dedupe finalized and in-flight cards."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from post_card.schema import TradeCard


def message_id_key(source_type: str, message_id: str) -> str:
    return f"{source_type}:{message_id}"


def composite_dedupe_key(card: TradeCard) -> str:
    sym = (card.symbol or "").upper().replace("USDT", "") + "USDT"
    sym = sym.replace("USDTUSDT", "USDT")
    who = (card.author or "").strip().lower()
    ch = (card.channel or card.source_id or "").strip().lower()
    direction = card.direction or ""
    return f"{card.source_type.value}:{ch}:{who}:{sym}:{direction}"


def content_hash(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:24]


def is_duplicate_message(
    seen_msg_keys: set[str],
    source_type: str,
    message_id: str,
) -> bool:
    k = message_id_key(source_type, message_id)
    if k in seen_msg_keys:
        return True
    seen_msg_keys.add(k)
    return False


def is_duplicate_signal(
    recent: dict[str, datetime],
    card: TradeCard,
    *,
    window_sec: int,
    now: datetime | None = None,
) -> bool:
    """Same source+symbol+direction within window → duplicate."""
    key = composite_dedupe_key(card)
    ts = now or datetime.now(timezone.utc)
    prev = recent.get(key)
    if prev is None:
        return False
    if (ts - prev).total_seconds() <= window_sec:
        return True
    return False


def register_signal_time(recent: dict[str, datetime], card: TradeCard, when: datetime) -> None:
    recent[composite_dedupe_key(card)] = when


def is_stronger_update(existing: TradeCard, incoming: TradeCard) -> bool:
    """Later message only adds TP/SL or refines entry → prefer replace."""
    if existing.symbol and incoming.symbol and existing.symbol.upper() != incoming.symbol.upper():
        return False
    if existing.direction and incoming.direction and existing.direction != incoming.direction:
        return False

    def richness(c: TradeCard) -> int:
        score = 0
        if (c.stop_loss or "").strip():
            score += 2
        if (c.take_profit or "").strip():
            score += 2
        if (c.entry or "").strip():
            score += 1
        score += len(c.raw_texts)
        return score

    return richness(incoming) >= richness(existing)
