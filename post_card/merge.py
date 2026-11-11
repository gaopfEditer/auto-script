"""Multi-message merge: direction first, TP/SL within merge window."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone

from post_card.env_defaults import MERGE_WINDOW_SEC
from post_card.dedupe import composite_dedupe_key, is_stronger_update
from post_card.schema import TradeCard, TpslSource


def _has_complete_tpsl(card: TradeCard) -> bool:
    return bool((card.stop_loss or "").strip()) and bool((card.take_profit or "").strip())


def _has_partial_tpsl(card: TradeCard) -> bool:
    return bool((card.stop_loss or "").strip()) or bool((card.take_profit or "").strip())


def merge_cards(base: TradeCard, extra: TradeCard) -> TradeCard:
    """Merge two partial cards (same author/channel/symbol)."""
    sl = extra.stop_loss or base.stop_loss
    tp = extra.take_profit or base.take_profit
    entry = extra.entry or base.entry
    if extra.entry and base.entry and extra.entry != base.entry:
        entry = extra.entry if len(extra.entry) >= len(base.entry) else base.entry

    tpsl_src: TpslSource = base.tpsl_source
    merged_sl_tp = replace(base, stop_loss=sl, take_profit=tp)
    if _has_complete_tpsl(merged_sl_tp):
        tpsl_src = "explicit"
    elif _has_partial_tpsl(merged_sl_tp) and tpsl_src != "explicit":
        tpsl_src = ""

    msg_ids = list(dict.fromkeys([*base.message_ids, *extra.message_ids]))
    raw_texts = list(dict.fromkeys([*base.raw_texts, *extra.raw_texts]))
    opened = base.opened_at or extra.opened_at

    return replace(
        base,
        symbol=extra.symbol or base.symbol,
        direction=extra.direction or base.direction,
        entry=entry,
        stop_loss=sl,
        take_profit=tp,
        tpsl_source=tpsl_src,
        message_ids=msg_ids,
        raw_texts=raw_texts,
        opened_at=opened,
        pending=not _has_complete_tpsl(replace(base, stop_loss=sl, take_profit=tp)),
        dedupe_key=composite_dedupe_key(base),
    )


class PendingMergeStore:
    def __init__(self, *, window_sec: int = MERGE_WINDOW_SEC) -> None:
        self.window_sec = window_sec
        self._pending: dict[str, TradeCard] = {}

    def _key(self, card: TradeCard) -> str:
        return composite_dedupe_key(card)

    def flush_expired(self, now: datetime | None = None) -> list[TradeCard]:
        ts = now or datetime.now(timezone.utc)
        out: list[TradeCard] = []
        dead: list[str] = []
        for k, card in self._pending.items():
            opened = card.opened_at or ts
            if (ts - opened).total_seconds() >= self.window_sec:
                dead.append(k)
                out.append(replace(card, pending=False))
        for k in dead:
            self._pending.pop(k, None)
        return out

    def ingest(self, card: TradeCard, now: datetime | None = None) -> tuple[list[TradeCard], TradeCard | None]:
        """
        Returns (expired_ready_cards, immediate_emit_or_none).
        If card still pending after merge, immediate is None.
        """
        ts = now or datetime.now(timezone.utc)
        ready = self.flush_expired(ts)

        if not card.symbol or not card.direction:
            return ready, card

        key = self._key(card)
        pending = self._pending.get(key)

        if pending is not None:
            opened = pending.opened_at or ts
            if (ts - opened).total_seconds() > self.window_sec:
                ready.append(replace(pending, pending=False))
                self._pending.pop(key, None)
                pending = None

        if pending is not None:
            merged = merge_cards(pending, card)
            if _has_complete_tpsl(merged):
                self._pending.pop(key, None)
                return ready, replace(merged, pending=False)
            self._pending[key] = replace(merged, pending=True, opened_at=pending.opened_at or ts)
            return ready, None

        # New direction card
        if _has_complete_tpsl(card):
            return ready, replace(card, pending=False, dedupe_key=key)

        self._pending[key] = replace(
            card,
            pending=True,
            opened_at=card.opened_at or ts,
            dedupe_key=key,
        )
        return ready, None

    def replace_if_stronger(self, card: TradeCard) -> TradeCard | None:
        """Update pending in place when duplicate is stronger (TP/SL only)."""
        key = self._key(card)
        pending = self._pending.get(key)
        if pending and is_stronger_update(pending, card):
            self._pending[key] = merge_cards(pending, card)
            return self._pending[key]
        return None
