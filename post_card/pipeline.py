"""Post → normalize → dedupe → merge → default TP/SL → emit finalized cards."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from typing import Callable, Iterable

from post_card.config import DEDUPE_WINDOW_SEC, MERGE_WINDOW_SEC
from post_card.dedupe import (
    composite_dedupe_key,
    is_duplicate_message,
    is_duplicate_signal,
    is_stronger_update,
    register_signal_time,
)
from post_card.merge import PendingMergeStore
from post_card.schema import TradeCard
from post_card.tpsl import apply_defaults

EmitCallback = Callable[[TradeCard], None]


class PostCardPipeline:
    def __init__(
        self,
        *,
        merge_window_sec: int = MERGE_WINDOW_SEC,
        dedupe_window_sec: int = DEDUPE_WINDOW_SEC,
        on_emit: EmitCallback | None = None,
    ) -> None:
        self._merge = PendingMergeStore(window_sec=merge_window_sec)
        self._dedupe_window = dedupe_window_sec
        self._seen_msg: set[str] = set()
        self._recent_signal: dict[str, datetime] = {}
        self._on_emit = on_emit

    def _finalize(self, card: TradeCard, now: datetime) -> TradeCard | None:
        if is_duplicate_signal(self._recent_signal, card, window_sec=self._dedupe_window, now=now):
            if self._merge.replace_if_stronger(card):
                return None
            if not is_stronger_update(card, card):
                return None

        finalized, defaulted = apply_defaults(card)
        if defaulted and finalized.tpsl_source != "explicit":
            finalized.tpsl_source = "default"
        finalized = replace(
            finalized,
            dedupe_key=composite_dedupe_key(finalized),
            completed_at=now,
            pending=False,
        )
        register_signal_time(self._recent_signal, finalized, now)
        if self._on_emit:
            self._on_emit(finalized)
        return finalized

    def ingest(self, card: TradeCard, *, now: datetime | None = None) -> list[TradeCard]:
        ts = now or datetime.now(timezone.utc)
        emitted: list[TradeCard] = []

        for mid in card.message_ids:
            if is_duplicate_message(self._seen_msg, card.source_type.value, mid):
                stronger = self._merge.replace_if_stronger(card)
                if stronger and self._on_emit:
                    pass
                return emitted

        expired, immediate = self._merge.ingest(card, ts)
        for e in expired:
            fin = self._finalize(e, ts)
            if fin:
                emitted.append(fin)

        if immediate is not None:
            fin = self._finalize(immediate, ts)
            if fin:
                emitted.append(fin)
        return emitted

    def flush(self, *, now: datetime | None = None) -> list[TradeCard]:
        ts = now or datetime.now(timezone.utc)
        emitted: list[TradeCard] = []
        for card in self._merge.flush_expired(ts):
            fin = self._finalize(card, ts)
            if fin:
                emitted.append(fin)
        return emitted

    def process_many(self, cards: Iterable[TradeCard]) -> list[TradeCard]:
        out: list[TradeCard] = []
        for c in cards:
            out.extend(self.ingest(c))
        out.extend(self.flush())
        return out
