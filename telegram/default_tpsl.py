"""Telegram 信号缺止盈/止损时：默认 ±5% 止损 + 5%/8%/12% 三档止盈（分批 30/30/40）。"""
from __future__ import annotations

import re
from dataclasses import replace
from typing import Any

from trade_signal_detect import TradeSignal, _has_numeric_price

DEFAULT_SL_PCT = 0.05
DEFAULT_TP_PCTS = (0.05, 0.08, 0.12)
DEFAULT_TP_SIZE_PCTS = (30, 30, 40)
DEFAULT_SL_TRAIL = ("entry", "tp1")


def parse_entry_numeric(entry: str) -> float | None:
    s = (entry or "").strip()
    if not s:
        return None
    if re.search(r"市[价價]|现价|market", s, re.I):
        return None
    m = re.search(r"([\d.]+)\s*[-~–—]\s*([\d.]+)", s)
    if m:
        try:
            a = float(m.group(1))
            b = float(m.group(2))
            if a > 0 and b > 0:
                return (a + b) / 2.0
        except (TypeError, ValueError):
            pass
    nums = re.findall(r"[\d.]+", s)
    for raw in nums:
        try:
            n = float(raw)
        except (TypeError, ValueError):
            continue
        if n > 0:
            return n
    return None


def _price_decimals(entry: float) -> int:
    s = f"{entry:.8f}".rstrip("0")
    if "." in s:
        return min(8, max(2, len(s.split(".")[1])))
    return 2


def _fmt_price(price: float, entry: float) -> str:
    dec = _price_decimals(entry)
    n = round(price, dec)
    out = f"{n:.{dec}f}".rstrip("0").rstrip(".")
    return out or "0"


def _level_price(entry: float, pct: float, *, is_long: bool, kind: str) -> float:
    if kind == "sl":
        return entry * (1 - pct) if is_long else entry * (1 + pct)
    return entry * (1 + pct) if is_long else entry * (1 - pct)


def _has_numeric_tp_list(raw: str) -> bool:
    s = (raw or "").strip()
    if not s:
        return False
    parts = re.split(r"[,，/|\s—–-]+", s)
    n = 0
    for p in parts:
        if _has_numeric_price(p):
            n += 1
    return n >= 1


def build_default_exit_plan() -> dict[str, Any]:
    return {
        "takeProfitSizePcts": list(DEFAULT_TP_SIZE_PCTS),
        "slTrailAfterTp": list(DEFAULT_SL_TRAIL),
        "defaultApplied": True,
        "slPct": DEFAULT_SL_PCT * 100,
        "tpPcts": [round(x * 100, 2) for x in DEFAULT_TP_PCTS],
    }


def apply_default_tpsl_if_needed(sig: TradeSignal) -> tuple[TradeSignal, bool, dict[str, Any] | None]:
    """
    缺数值化止盈或止损时，按 5% SL + 5/8/12% 三档 TP 补全。
    返回 (signal, changed, exit_plan)。
    """
    if sig.direction not in ("多", "空"):
        return sig, False, None
    entry = parse_entry_numeric(sig.entry)
    if entry is None or entry <= 0:
        return sig, False, None

    need_sl = not _has_numeric_price(sig.stop_loss)
    need_tp = not _has_numeric_tp_list(sig.take_profit)
    if not need_sl and not need_tp:
        return sig, False, None

    is_long = sig.direction == "多"
    out = sig
    changed = False

    if need_sl:
        sl = _level_price(entry, DEFAULT_SL_PCT, is_long=is_long, kind="sl")
        out = replace(out, stop_loss=_fmt_price(sl, entry))
        changed = True

    if need_tp:
        tps = [
            _fmt_price(_level_price(entry, pct, is_long=is_long, kind="tp"), entry)
            for pct in DEFAULT_TP_PCTS
        ]
        out = replace(out, take_profit="—".join(tps))
        changed = True

    if not changed:
        return sig, False, None
    return out, True, build_default_exit_plan()
