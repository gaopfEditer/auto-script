"""Unified trade card schema shared across channel adapters."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum
from typing import Any, Literal


class SourceType(str, Enum):
    TELEGRAM = "telegram"
    DISCORD = "discord"
    TWITTER = "twitter"


DirectionApi = Literal["long", "short", ""]
TpslSource = Literal["explicit", "default", ""]


@dataclass
class TradeCard:
    source_type: SourceType
    source_id: str
    message_ids: list[str] = field(default_factory=list)
    author: str = ""
    channel: str = ""
    symbol: str = ""
    direction: DirectionApi = ""
    entry: str = ""
    stop_loss: str = ""
    take_profit: str = ""
    tpsl_source: TpslSource = ""
    opened_at: datetime | None = None
    completed_at: datetime | None = None
    dedupe_key: str = ""
    raw_texts: list[str] = field(default_factory=list)
    pending: bool = False
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["source_type"] = self.source_type.value
        if self.opened_at:
            d["opened_at"] = self.opened_at.isoformat()
        if self.completed_at:
            d["completed_at"] = self.completed_at.isoformat()
        return d

    @staticmethod
    def direction_from_cn(d: str) -> DirectionApi:
        s = (d or "").strip()
        if s in ("多", "long", "LONG", "做多"):
            return "long"
        if s in ("空", "short", "SHORT", "做空"):
            return "short"
        return ""

    @staticmethod
    def cn_from_api(d: DirectionApi) -> str:
        if d == "long":
            return "多"
        if d == "short":
            return "空"
        return ""
