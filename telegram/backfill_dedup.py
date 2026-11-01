"""回溯建卡列表：同 symbol+方向+阶段，时间窗内只保留最早一条。"""
from __future__ import annotations

import os
from datetime import datetime, timezone

DEFAULT_WINDOW_MS = int(os.environ.get("TELEGRAM_BACKFILL_DEDUP_WINDOW_MS", str(20 * 60 * 1000)))


def _parse_ms(card: dict) -> int | None:
    raw = str(card.get("signalAt") or card.get("at") or "").strip()
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


def dedup_key(card: dict) -> str:
    sym = str(card.get("symbol") or "").strip().upper()
    dir_norm = str(card.get("directionNorm") or card.get("direction") or "").strip().lower()
    phase = str(card.get("phase") or "full").strip().lower()
    return f"{sym}|{dir_norm}|{phase}"


def dedupe_cards(cards: list[dict], window_ms: int = DEFAULT_WINDOW_MS) -> list[dict]:
    if len(cards) < 2:
        return list(cards)

    def sort_key(c: dict) -> tuple[int, str]:
        ms = _parse_ms(c)
        return (ms if ms is not None else 2**62, str(c.get("digest") or ""))

    sorted_cards = sorted(cards, key=sort_key)
    out: list[dict] = []
    cluster_start: dict[str, int] = {}

    for card in sorted_cards:
        key = dedup_key(card)
        t = _parse_ms(card)
        if t is None:
            out.append(card)
            continue
        start = cluster_start.get(key)
        if start is not None and t - start < window_ms:
            continue
        cluster_start[key] = t
        out.append(card)
    return out
