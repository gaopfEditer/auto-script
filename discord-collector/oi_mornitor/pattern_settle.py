"""形态信号 3h ±5% 纸面结算（对齐前端 patternAlertWinRate.ts）。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.pattern_alert_stats import _DEFAULT_TP_SL_PCT, _rec_pnl_pct
from oi_mornitor.symbol_aliases import human_base_asset

_VERIFY_DELAY_MS = 3 * 60 * 60 * 1000


def price_move_pct(entry: float, price: float, *, is_short: bool) -> float:
    if entry <= 0:
        return 0.0
    if is_short:
        return (entry - price) / entry * 100.0
    return (price - entry) / entry * 100.0


def _align_factor(ref: float, entry: float) -> float:
    if not (ref > 0 and entry > 0):
        return 1.0
    ratio = ref / entry
    if ratio > 50 or ratio < 0.02:
        p = 10 ** round(__import__("math").log10(ratio))
        return p if abs(ratio / p - 1) < abs(ratio - 1) else ratio
    return 1.0


def _align_bars(bars: list[dict[str, float]], entry: float) -> list[dict[str, float]]:
    if not bars or entry <= 0:
        return bars
    samples = sorted(b["close"] for b in bars[:8] if b["close"] > 0)
    if not samples:
        return bars
    mid = samples[len(samples) // 2]
    factor = _align_factor(mid, entry)
    if factor == 1.0:
        return bars
    return [
        {"ts": b["ts"], "high": b["high"] * factor, "low": b["low"] * factor, "close": b["close"] * factor}
        for b in bars
    ]


def settle_signal_by_5m_bars(
    *,
    side: str,
    entry: float,
    symbol: str,
    signal_at_ms: int,
    bars_5m: list[dict[str, float]],
    step_pct: float = _DEFAULT_TP_SL_PCT,
    verify_delay_ms: int = _VERIFY_DELAY_MS,
    now_ms: int | None = None,
) -> dict[str, Any]:
    """返回 outcome / movePct / exitPrice / pnlPct 等。"""
    is_short = side in ("short", "bear")
    step = step_pct / 100.0
    tp = entry * (1 - step) if is_short else entry * (1 + step)
    sl = entry * (1 + step) if is_short else entry * (1 - step)
    verify_at = signal_at_ms + verify_delay_ms
    now = verify_at if now_ms is None else min(now_ms, verify_at)

    aligned = _align_bars(bars_5m, entry)
    sorted_bars = [
        b
        for b in sorted(aligned, key=lambda x: x["ts"])
        if signal_at_ms - 1 <= b["ts"] <= now + 60_000
    ]

    def _finish(outcome: str, *, exit_price: float, move: float, hit_at: int | None = None) -> dict[str, Any]:
        rec = {
            "outcome": outcome,
            "exitPrice": exit_price,
            "movePct": move,
            "hitAt": hit_at,
            "verifiedAt": now,
            "stepPct": step_pct,
            "side": "short" if is_short else "long",
            "entry": entry,
            "symbol": human_base_asset(symbol) or symbol,
            "tradeSymbol": symbol,
        }
        rec["pnlPct"] = _rec_pnl_pct(rec)
        return rec

    for k in sorted_bars:
        if is_short:
            if k["high"] >= sl:
                move = price_move_pct(entry, sl, is_short=True)
                return _finish("stop_loss", exit_price=sl, move=move, hit_at=int(k["ts"]))
            if k["low"] <= tp:
                move = price_move_pct(entry, tp, is_short=True)
                return _finish("take_profit", exit_price=tp, move=move, hit_at=int(k["ts"]))
        else:
            if k["low"] <= sl:
                move = price_move_pct(entry, sl, is_short=False)
                return _finish("stop_loss", exit_price=sl, move=move, hit_at=int(k["ts"]))
            if k["high"] >= tp:
                move = price_move_pct(entry, tp, is_short=False)
                return _finish("take_profit", exit_price=tp, move=move, hit_at=int(k["ts"]))

    if now < verify_at:
        return {"outcome": "pending", "entry": entry, "symbol": symbol, "pnlPct": None}

    if not sorted_bars:
        return {"outcome": "error", "error": "no_klines", "entry": entry, "symbol": symbol, "pnlPct": None}

    last = sorted_bars[-1]
    move = price_move_pct(entry, last["close"], is_short=is_short)
    if abs(move) < 1e-4:
        return _finish("flat", exit_price=last["close"], move=move, hit_at=int(last["ts"]))
    outcome = "take_profit" if move > 0 else "stop_loss"
    return _finish(outcome, exit_price=last["close"], move=move, hit_at=int(last["ts"]))
