"""统一 SignalEvent。"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class SignalEvent:
    symbol: str
    tf: str
    side: str
    family: str
    kind: str
    bar_index: int
    bar_open_ts: int
    bar_close_ts: int
    strength: float
    price_close: float
    exchange: str = "binance_um"
    reject_reason: str | None = None
    tags: dict[str, Any] = field(default_factory=dict)
    features: dict[str, Any] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)

    def to_log_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["price_close"] = self.price_close
        return d
