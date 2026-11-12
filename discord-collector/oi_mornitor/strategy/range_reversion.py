"""独立策略：震荡区间均值回归（range_mean_reversion）。

真正的区间识别（上沿/下沿/中位），只在边缘交易，假突破收回后反向确认。
有效突破后停止均值回归。趋势行情不得标成震荡。
"""
from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.market_regime import (
    at_range_edge,
    classify_trend_regime,
    close_confirms_break,
    identify_range,
    near_range_mid,
    range_valid_break,
    wick_only_break,
)
from oi_mornitor.opportunity_score import assess
from oi_mornitor.strategy.sl_profiles import resolve_sl_price, tp_prices

STRATEGY_ID = "range_mean_reversion"
STRATEGY_LABEL = "震荡区间均值回归"
TIMEOUT_BARS_1H = 16
BATCH_WEIGHTS = (0.50, 0.50, 0.0)


def detect_range_reversion_trades(
    df_1h: pd.DataFrame,
    df_4h: pd.DataFrame | None = None,
    *,
    symbol: str = "",
    sl_profile: str = "structure",
    start_idx: int = 60,
) -> list[dict[str, Any]]:
    if df_1h is None or len(df_1h) < start_idx + 3:
        return []
    trades: list[dict[str, Any]] = []
    n = len(df_1h)
    last_emit = -999

    for i in range(start_idx, n - 1):
        if i - last_emit < 4:
            continue
        # 4h 明确趋势时不做震荡回归（防止把趋势当震荡）
        r4 = None
        if df_4h is not None and len(df_4h):
            if "open_time" in df_1h.columns and "open_time" in df_4h.columns:
                t = int(df_1h.iloc[i]["open_time"])
                idx4 = int(df_4h["open_time"].astype(int).searchsorted(t, side="right") - 1)
                idx4 = max(0, min(idx4, len(df_4h) - 1))
            else:
                idx4 = len(df_4h) - 1
            r4 = classify_trend_regime(df_4h, end_idx=idx4, tf="4h")
            if r4.label in ("trend_up", "trend_down"):
                continue

        r1 = classify_trend_regime(df_1h, end_idx=i, tf="1h")
        if r1.label in ("trend_up", "trend_down"):
            continue
        rng = r1.range_high and {
            "high": r1.range_high,
            "low": r1.range_low,
            "mid": r1.range_mid,
        }
        if not rng:
            rng = identify_range(df_1h, end_idx=i)
        if not rng:
            continue
        if range_valid_break(df_1h, bar_idx=i, rng=rng):
            continue

        row = df_1h.iloc[i]
        close = float(row["close"])
        high, low = float(row["high"]), float(row["low"])
        if near_range_mid(close, rng):
            continue

        side = ""
        # 下沿：扫流动性后收回，做多；上沿对称做空
        if at_range_edge(close, rng, side="long") or (
            wick_only_break(df_1h, bar_idx=i, level=rng["low"], side="short")
            and close_confirms_break(row, rng["low"], side="long") is False
            and close >= rng["low"]
        ):
            # 假突破下沿（影线刺破、收盘收回）或收在下沿区内
            if low < rng["low"] and close >= rng["low"]:
                side = "long"
            elif close <= rng["low"] + (rng["high"] - rng["low"]) * 0.28 and close >= rng["low"]:
                if close > float(row["open"]):
                    side = "long"
        if not side and (
            at_range_edge(close, rng, side="short")
            or (high > rng["high"] and close <= rng["high"])
        ):
            if high > rng["high"] and close <= rng["high"]:
                side = "short"
            elif close >= rng["high"] - (rng["high"] - rng["low"]) * 0.28 and close <= rng["high"]:
                if close < float(row["open"]):
                    side = "short"
        if not side:
            continue
        if near_range_mid(close, rng):
            continue

        entry = float(df_1h.iloc[i + 1]["open"])
        is_short = side == "short"
        extreme = low if side == "long" else high
        sl, used_sl = resolve_sl_price(
            entry=entry,
            is_short=is_short,
            structure_level=extreme,
            atr=_atr(df_1h, i),
            profile=sl_profile,
        )
        mid = rng["mid"]
        opposite = rng["high"] if side == "long" else rng["low"]
        # TP1 中位、TP2 对侧
        if is_short:
            tp1, tp2 = (mid if mid < entry else entry - abs(entry - sl)), (
                opposite if opposite < entry else mid
            )
        else:
            tp1, tp2 = (mid if mid > entry else entry + abs(entry - sl)), (
                opposite if opposite > entry else mid
            )
        opp = assess(
            symbol=symbol,
            side_intent=side,
            regime_4h=r4.label if r4 else "unknown",
            regime_1h="range",
            structure_1h="none",
            pattern=STRATEGY_ID,
            at_range_edge=True,
            close_confirmed=True,
            extra_reasons=["区间边缘", "中位不追", "有效突破后停止"],
        )
        trades.append({
            "strategy": STRATEGY_ID,
            "strategyLabel": STRATEGY_LABEL,
            "symbol": symbol,
            "interval": "1h",
            "kind": STRATEGY_ID,
            "typeLabel": STRATEGY_LABEL,
            "side": "bear" if is_short else "bull",
            "bar_index": i,
            "entry_bar": i + 1,
            "entry_mode": "next_bar_open",
            "entry": entry,
            "defense": extreme,
            "slPrice": sl,
            "slProfile": used_sl,
            "tp1Price": tp1,
            "tp2Price": tp2,
            "batchWeights": list(BATCH_WEIGHTS),
            "timeoutBars": TIMEOUT_BARS_1H,
            "rangeHigh": rng["high"],
            "rangeLow": rng["low"],
            "rangeMid": rng["mid"],
            "regime4h": r4.to_dict() if r4 else None,
            "regime1h": r1.to_dict(),
            "opportunity": opp.to_dict(),
            "noTradeRules": ["趋势行情不做回归", "接近中位不追", "有效突破后停止均值回归"],
        })
        last_emit = i
    return trades


def _atr(df: pd.DataFrame, idx: int, period: int = 14) -> float:
    if idx < period:
        return 0.0
    trs: list[float] = []
    for i in range(max(1, idx - period + 1), idx + 1):
        row, prev = df.iloc[i], df.iloc[i - 1]
        h, l, pc = float(row["high"]), float(row["low"]), float(prev["close"])
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return sum(trs) / len(trs) if trs else 0.0
