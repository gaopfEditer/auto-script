"""成交模型：下一根开盘 + 不利滑点；超过滑点上限则视为未成交并跳过。

不假设仅用收盘价成交。现货 K 线只是合约价格代理（见 params.PRICE_PROXY_NOTE）。
复用 pattern_entry.apply_entry_slippage / resolve_backtest_entry_price。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from oi_mornitor.backtest_trade_config import OI_BT_FEE_PCT, OI_BT_SLIPPAGE_PCT
from oi_mornitor.pattern_entry import apply_entry_slippage, apply_round_trip_costs, resolve_backtest_entry_price
from oi_mornitor.strategy.short_term_v1.params import MAX_SLIPPAGE_PCT, PRICE_PROXY_NOTE


@dataclass
class FillResult:
    requested: float
    filled: float | None
    side: str
    slippage_pct: float
    fee_pct: float
    unfilled: bool = False
    reason: str | None = None
    note: str = PRICE_PROXY_NOTE

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def apply_entry_fill(
    next_open: float,
    *,
    side: str,
    slippage_pct: float | None = None,
    fee_pct: float | None = None,
    max_slippage_pct: float = MAX_SLIPPAGE_PCT,
    signal_close: float | None = None,
    mode: str = "next_bar_open",
) -> FillResult:
    """下一根开盘不利滑点成交。滑点（或点差近似）超过上限 → 未成交，保守跳过。"""
    slip = OI_BT_SLIPPAGE_PCT if slippage_pct is None else float(slippage_pct)
    fee = OI_BT_FEE_PCT if fee_pct is None else float(fee_pct)
    if next_open is None or next_open <= 0:
        return FillResult(
            requested=0.0,
            filled=None,
            side=side,
            slippage_pct=slip,
            fee_pct=fee,
            unfilled=True,
            reason="missing_next_open",
        )
    if slip > max_slippage_pct:
        return FillResult(
            requested=float(next_open),
            filled=None,
            side=side,
            slippage_pct=slip,
            fee_pct=fee,
            unfilled=True,
            reason="slippage_over_cap",
        )
    # 用现有入口：默认 next_bar_open + 不利滑点（多更高、空更低，对开仓更差）。
    filled = resolve_backtest_entry_price(
        side=side,
        signal_bar_close=float(signal_close if signal_close and signal_close > 0 else next_open),
        next_bar_open=float(next_open),
        mode=mode,
        slippage_pct=slip,
    )
    return FillResult(
        requested=float(next_open),
        filled=float(filled),
        side=side,
        slippage_pct=slip,
        fee_pct=fee,
        unfilled=False,
    )


def net_price_move(move_pct: float, *, fee_pct: float | None = None, slippage_pct: float | None = None) -> float:
    fee = OI_BT_FEE_PCT if fee_pct is None else float(fee_pct)
    slip = OI_BT_SLIPPAGE_PCT if slippage_pct is None else float(slippage_pct)
    return apply_round_trip_costs(move_pct, fee_pct=fee, slippage_pct=slip)


# 供文档与审计引用，避免「只用收盘成交」的误解。
FILL_RULES_ZH = (
    "入场：信号柱收盘确认后，下一根开盘价加不利滑点。"
    f"默认滑点 {OI_BT_SLIPPAGE_PCT:g}%/边、手续费 {OI_BT_FEE_PCT:g}%/边。"
    f"若设定滑点超过 {MAX_SLIPPAGE_PCT:g}% 上限，视为无法成交并跳过（不按更差价格强行成交）。"
    "同柱先止损再止盈。现货 K 线仅作永续价格代理。"
    "限价未成交没有订单簿回放时，采用该保守跳过，而不是假设全部成交。"
)
