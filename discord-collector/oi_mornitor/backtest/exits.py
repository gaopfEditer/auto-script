"""按周期配置的出场规则 + 手续费/滑点/杠杆。"""
from __future__ import annotations

import os
from dataclasses import dataclass

from oi_mornitor.strategy.params import SLIPPAGE_PCT, TAKER_FEE_PCT

MAJOR_LEVERAGE = {"BTCUSDT": 100.0, "ETHUSDT": 100.0, "SOLUSDT": 100.0}
DEFAULT_LEVERAGE = 20.0

HOLD_BARS = {
    "15m": int(os.getenv("OI_BT_HOLD_15M", "16")),
    "1h": int(os.getenv("OI_BT_HOLD_1H", "12")),
    "4h": int(os.getenv("OI_BT_HOLD_4H", "6")),
    "1d": int(os.getenv("OI_BT_HOLD_1D", "5")),
}
SL_ATR = {
    "15m": float(os.getenv("OI_BT_SL_ATR_15M", "1.2")),
    "1h": float(os.getenv("OI_BT_SL_ATR_1H", "1.5")),
    "4h": float(os.getenv("OI_BT_SL_ATR_4H", "2.0")),
    "1d": float(os.getenv("OI_BT_SL_ATR_1D", "2.0")),
}
TP_R = {
    "15m": float(os.getenv("OI_BT_TP_R_15M", "2.0")),
    "1h": float(os.getenv("OI_BT_TP_R_1H", "2.0")),
    "4h": float(os.getenv("OI_BT_TP_R_4H", "2.0")),
    "1d": float(os.getenv("OI_BT_TP_R_1D", "2.0")),
}


def leverage_for(symbol: str) -> float:
    return MAJOR_LEVERAGE.get(symbol.upper(), DEFAULT_LEVERAGE)


@dataclass
class ExitConfig:
    hold_bars: int
    sl_atr: float
    tp_r: float
    taker_fee_pct: float = TAKER_FEE_PCT
    slippage_pct: float = SLIPPAGE_PCT


def exit_config(tf: str) -> ExitConfig:
    return ExitConfig(
        hold_bars=HOLD_BARS.get(tf, 12),
        sl_atr=SL_ATR.get(tf, 1.5),
        tp_r=TP_R.get(tf, 2.0),
    )


def simulate_trade(
    bars: list[dict],
    *,
    side: str,
    entry_idx: int,
    atr: float,
    symbol: str,
    tf: str,
    cfg: ExitConfig | None = None,
) -> dict:
    """从 entry_idx 的收盘入场，下一根开始检查；等额保证金口径。"""
    cfg = cfg or exit_config(tf)
    if entry_idx < 0 or entry_idx >= len(bars) - 1:
        return {"exit_reason": "no_bar", "pnl_pct": 0.0, "pnl_r": 0.0}
    raw = float(bars[entry_idx]["close"])
    slip = cfg.slippage_pct / 100.0
    sign = 1.0 if side == "long" else -1.0
    entry = raw * (1 + slip * sign)
    atr = atr if atr and atr > 0 else raw * 0.01
    sl = entry - sign * cfg.sl_atr * atr
    risk = abs(entry - sl)
    tp = entry + sign * cfg.tp_r * risk
    mfe = 0.0
    mae = 0.0
    exit_price = entry
    reason = "time"
    held = 0
    end = min(len(bars) - 1, entry_idx + cfg.hold_bars)
    for j in range(entry_idx + 1, end + 1):
        held = j - entry_idx
        hi = float(bars[j]["high"])
        lo = float(bars[j]["low"])
        cl = float(bars[j]["close"])
        if side == "long":
            mfe = max(mfe, (hi - entry) / entry)
            mae = min(mae, (lo - entry) / entry)
            if lo <= sl:
                exit_price = sl
                reason = "sl"
                break
            if hi >= tp:
                exit_price = tp
                reason = "tp"
                break
        else:
            mfe = max(mfe, (entry - lo) / entry)
            mae = min(mae, (entry - hi) / entry)
            if hi >= sl:
                exit_price = sl
                reason = "sl"
                break
            if lo <= tp:
                exit_price = tp
                reason = "tp"
                break
        exit_price = cl
    exit_price *= 1 - slip * sign
    price_ret = (exit_price - entry) / entry * sign
    lev = leverage_for(symbol)
    fee_margin_pct = 2.0 * cfg.taker_fee_pct * lev  # taker_fee_pct 为 0.05 表示 0.05%
    pnl_pct = price_ret * lev * 100.0 - fee_margin_pct
    pnl_r = (price_ret * entry / risk) if risk > 0 else 0.0
    return {
        "exit_price": exit_price,
        "exit_reason": reason,
        "bars_held": held,
        "pnl_pct": pnl_pct,
        "pnl_r": pnl_r,
        "mfe_pct": mfe * 100.0,
        "mae_pct": mae * 100.0,
        "mfe_r": (mfe * entry / risk) if risk > 0 else 0.0,
        "mae_r": (mae * entry / risk) if risk > 0 else 0.0,
        "leverage": lev,
        "fee_pct": fee_margin_pct,
        "entry": entry,
        "sl": sl,
        "tp": tp,
    }
