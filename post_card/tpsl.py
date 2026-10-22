"""Apply default TP/SL (5% SL, 10% TP) to unified cards."""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

from post_card.config import DEFAULT_SL_PCT, DEFAULT_TP_PCT
from post_card.schema import TradeCard

# Reuse telegram numeric helpers when available
_TELEGRAM_DIR = Path(__file__).resolve().parents[1] / "telegram"
if _TELEGRAM_DIR.is_dir() and str(_TELEGRAM_DIR) not in sys.path:
    sys.path.insert(0, str(_TELEGRAM_DIR))

try:
    from default_tpsl import (  # type: ignore
        apply_default_tpsl_if_needed,
        parse_entry_numeric,
        _has_numeric_price,
    )
    from trade_signal_detect import TradeSignal  # type: ignore
except ImportError:
    apply_default_tpsl_if_needed = None  # type: ignore
    parse_entry_numeric = None  # type: ignore
    TradeSignal = None  # type: ignore


def _card_to_signal(card: TradeCard):
    assert TradeSignal is not None
    return TradeSignal(
        symbol=card.symbol.replace("USDT", "") if card.symbol else "",
        direction=TradeCard.cn_from_api(card.direction),
        entry=card.entry,
        take_profit=card.take_profit,
        stop_loss=card.stop_loss,
        sender=card.author,
        msg_ids=[int(x) for x in card.message_ids if str(x).isdigit()],
    )


def _fallback_entry_numeric(entry: str) -> float | None:
    import re

    s = (entry or "").strip()
    if not s or re.search(r"市[价價]|market", s, re.I):
        return None
    m = re.search(r"([\d.]+)", s)
    if m:
        try:
            n = float(m.group(1))
            return n if n > 0 else None
        except ValueError:
            return None
    return None


def apply_defaults(card: TradeCard) -> tuple[TradeCard, bool]:
    if _has_explicit_tpsl(card):
        return replace(card, tpsl_source="explicit"), False

    entry_fn = parse_entry_numeric or _fallback_entry_numeric
    entry = entry_fn(card.entry)
    if entry is None or entry <= 0:
        return card, False

    is_long = card.direction == "long"
    sl_pct = DEFAULT_SL_PCT
    tp_pct = DEFAULT_TP_PCT

    if apply_default_tpsl_if_needed is not None:
        sig = _card_to_signal(card)
        out_sig, changed, _plan = apply_default_tpsl_if_needed(sig)
        if changed:
            return (
                replace(
                    card,
                    stop_loss=out_sig.stop_loss,
                    take_profit=out_sig.take_profit,
                    tpsl_source="default",
                    pending=False,
                ),
                True,
            )
        return card, False

    # Pure-python fallback (no telegram on path)
    if is_long:
        sl = entry * (1 - sl_pct)
        tp = entry * (1 + tp_pct)
    else:
        sl = entry * (1 + sl_pct)
        tp = entry * (1 - tp_pct)

    return (
        replace(
            card,
            stop_loss=f"{sl:.8f}".rstrip("0").rstrip("."),
            take_profit=f"{tp:.8f}".rstrip("0").rstrip("."),
            tpsl_source="default",
            pending=False,
        ),
        True,
    )


def _has_explicit_tpsl(card: TradeCard) -> bool:
    return bool((card.stop_loss or "").strip()) or bool((card.take_profit or "").strip())
