"""Thin input adapters → TradeCard."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from post_card.schema import TradeCard, SourceType

_TELEGRAM_DIR = Path(__file__).resolve().parents[1] / "telegram"
if _TELEGRAM_DIR.is_dir() and str(_TELEGRAM_DIR) not in sys.path:
    sys.path.insert(0, str(_TELEGRAM_DIR))

try:
    from trade_signal_detect import parse_trade_text, TradeSignal  # type: ignore
except ImportError:
    parse_trade_text = None  # type: ignore
    TradeSignal = None  # type: ignore


def _normalize_symbol(sym: str) -> str:
    s = (sym or "").strip().upper()
    if not s:
        return ""
    if not s.endswith("USDT"):
        s = f"{s}USDT"
    return s


def _signal_to_card(
    sig: Any,
    *,
    source_type: SourceType,
    source_id: str,
    channel: str,
    message_id: str,
    raw_text: str,
    at: datetime | None,
) -> TradeCard | None:
    if sig is None:
        return None
    direction = TradeCard.direction_from_cn(getattr(sig, "direction", "") or "")
    symbol = _normalize_symbol(getattr(sig, "symbol", "") or "")
    if not symbol and not direction:
        return None
    ts = at or datetime.now(timezone.utc)
    return TradeCard(
        source_type=source_type,
        source_id=source_id,
        message_ids=[message_id] if message_id else [],
        author=(getattr(sig, "sender", "") or "").strip(),
        channel=channel,
        symbol=symbol,
        direction=direction,
        entry=getattr(sig, "entry", "") or "",
        stop_loss=getattr(sig, "stop_loss", "") or "",
        take_profit=getattr(sig, "take_profit", "") or "",
        tpsl_source="explicit" if (getattr(sig, "stop_loss", "") or getattr(sig, "take_profit", "")) else "",
        opened_at=ts,
        raw_texts=[raw_text] if raw_text else [],
    )


def from_telegram_message(
    *,
    text: str,
    chat_id: int | str,
    chat_title: str = "",
    msg_id: int | str,
    sender: str = "",
    at: datetime | None = None,
) -> TradeCard | None:
    if parse_trade_text is None:
        return None
    sig = parse_trade_text(text, sender=sender, msg_id=int(msg_id) if str(msg_id).isdigit() else None)
    return _signal_to_card(
        sig,
        source_type=SourceType.TELEGRAM,
        source_id=str(chat_id),
        channel=chat_title or str(chat_id),
        message_id=str(msg_id),
        raw_text=text,
        at=at,
    )


def from_discord_message(
    *,
    text: str,
    author: str,
    channel_id: str,
    channel_name: str = "",
    message_id: str,
    at: datetime | None = None,
) -> TradeCard | None:
    """Discord: reuse telegram text parser (shared KOL wording)."""
    if parse_trade_text is None:
        return None
    sig = parse_trade_text(text, sender=author)
    return _signal_to_card(
        sig,
        source_type=SourceType.DISCORD,
        source_id=channel_id,
        channel=channel_name or channel_id,
        message_id=message_id,
        raw_text=text,
        at=at,
    )


def from_twitter_post(
    *,
    text: str,
    author: str,
    post_id: str,
    at: datetime | None = None,
) -> TradeCard | None:
    if parse_trade_text is None:
        return None
    sig = parse_trade_text(text, sender=author)
    return _signal_to_card(
        sig,
        source_type=SourceType.TWITTER,
        source_id=author,
        channel=author,
        message_id=post_id,
        raw_text=text,
        at=at,
    )


def from_twitter_json(obj: dict[str, Any]) -> TradeCard | None:
    """Fixture path: { \"id\", \"text\", \"author\", \"created_at\" }."""
    text = str(obj.get("text") or obj.get("full_text") or "")
    author = str(obj.get("author") or obj.get("username") or "")
    post_id = str(obj.get("id") or obj.get("post_id") or "")
    at_raw = obj.get("created_at") or obj.get("ts")
    at: datetime | None = None
    if at_raw:
        try:
            if isinstance(at_raw, (int, float)):
                at = datetime.fromtimestamp(float(at_raw) / (1000 if float(at_raw) > 1e12 else 1), tz=timezone.utc)
            else:
                at = datetime.fromisoformat(str(at_raw).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            at = None
    return from_twitter_post(text=text, author=author, post_id=post_id, at=at)
