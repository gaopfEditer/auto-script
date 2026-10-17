"""入场价解析：Live 告警价 vs 回测下一根开盘价 + 滑点。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.backtest_trade_config import OI_BT_ENTRY_MODE, OI_BT_SLIPPAGE_PCT
from oi_mornitor.pattern_alert_stats import _entry_from_alert


def entry_from_alert(alert: dict[str, Any]) -> float | None:
    """Live 胜率库口径：确认柱收盘/price 字段。"""
    return _entry_from_alert(alert)


def apply_entry_slippage(price: float, *, side: str, slippage_pct: float) -> float:
    if price <= 0 or slippage_pct <= 0:
        return price
    slip = price * slippage_pct / 100.0
    s = str(side or "").lower()
    if s in ("short", "bear"):
        return price - slip
    return price + slip


def resolve_backtest_entry_price(
    *,
    side: str,
    signal_bar_close: float,
    next_bar_open: float | None,
    mode: str | None = None,
    slippage_pct: float | None = None,
) -> float:
    """回测入场：默认下一根开盘价 + 不利滑点。"""
    m = (mode or OI_BT_ENTRY_MODE).lower()
    slip = slippage_pct if slippage_pct is not None else OI_BT_SLIPPAGE_PCT
    if m == "bar_close":
        base = float(signal_bar_close)
    elif next_bar_open is not None and next_bar_open > 0:
        base = float(next_bar_open)
    else:
        base = float(signal_bar_close)
    return apply_entry_slippage(base, side=side, slippage_pct=slip)


def apply_round_trip_costs(move_pct: float, *, fee_pct: float, slippage_pct: float) -> float:
    """从价格变动 % 扣除双边手续费与开平滑点（近似加在变动上）。"""
    return move_pct - 2.0 * fee_pct - 2.0 * slippage_pct
