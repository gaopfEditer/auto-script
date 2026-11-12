"""独立策略：严格版流动性反转（liquidity_reversal_strict）。

必须同时具备：Sweep → Reclaim → 明确 CHoCH → 1h 结构确认。
仅有 sweep、或 insufficient 标签，不得作为可交易机会。
自有入场（下一根开盘）、SL（sweep 极值之外）、目标（区间中位、对侧流动性）。
"""
from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.market_regime import (
    SWING_ORDER,
    choch_by_close,
    classify_trend_regime,
    confirmed_swings,
    identify_range,
)
from oi_mornitor.opportunity_score import assess
from oi_mornitor.strategy.sl_profiles import resolve_sl_price

STRATEGY_ID = "liquidity_reversal_strict"
STRATEGY_LABEL = "严格流动性反转"
TIMEOUT_BARS_1H = 24
BATCH_WEIGHTS = (0.40, 0.30, 0.30)
SWEEP_PIERCE_MIN = 0.0005
SWEEP_PIERCE_MAX = 0.02


def _sweep_and_reclaim(
    df: pd.DataFrame,
    *,
    idx: int,
    side: str,
    order: int = SWING_ORDER,
) -> dict[str, Any] | None:
    """side=short：扫前高后收回；side=long：扫前低后收回。收盘必须回到流动性区域内。"""
    if idx < order * 2 + 2:
        return None
    row = df.iloc[idx]
    high, low, close = float(row["high"]), float(row["low"]), float(row["close"])
    if side == "short":
        swings = confirmed_swings(df, end_idx=idx - 1, which="high", order=order)
        if not swings:
            return None
        pi, ph = swings[-1]
        if idx - pi > 30 or ph <= 0:
            return None
        # 影线扫过前高
        if not (high > ph * (1 + SWEEP_PIERCE_MIN) and high <= ph * (1 + SWEEP_PIERCE_MAX)):
            return None
        # 收盘回到前高之下（reclaim）
        if close >= ph:
            return None
        return {"sweepExtreme": high, "liquidityLevel": ph, "sweepBar": idx, "priorSwing": pi}
    swings = confirmed_swings(df, end_idx=idx - 1, which="low", order=order)
    if not swings:
        return None
    pi, pl = swings[-1]
    if idx - pi > 30 or pl <= 0:
        return None
    if not (low < pl * (1 - SWEEP_PIERCE_MIN) and low >= pl * (1 - SWEEP_PIERCE_MAX)):
        return None
    if close <= pl:
        return None
    return {"sweepExtreme": low, "liquidityLevel": pl, "sweepBar": idx, "priorSwing": pi}


def _complete_reversal(
    df: pd.DataFrame,
    *,
    sweep_idx: int,
    side: str,
    max_wait: int = 6,
) -> int | None:
    """Sweep+Reclaim 之后，在后续已收盘柱上出现明确 CHoCH。返回确认柱索引。"""
    prior = "up" if side == "short" else "down"
    n = len(df)
    # 扫掠柱本身若已收盘确认 CHoCH 也可（收盘回到区内且破反向结构）
    for j in range(sweep_idx, min(n, sweep_idx + max_wait + 1)):
        if choch_by_close(df, bar_idx=j, prior_trend=prior):
            return j
    return None


def detect_liquidity_reversal_trades(
    df_1h: pd.DataFrame,
    df_4h: pd.DataFrame | None = None,
    *,
    symbol: str = "",
    sl_profile: str = "structure",
    start_idx: int = 60,
    allow_incomplete: bool = False,
) -> list[dict[str, Any]]:
    """完整三步才可交易。allow_incomplete 仅供研究标签，默认 False 且不产出交易。"""
    if df_1h is None or len(df_1h) < start_idx + 3:
        return []
    trades: list[dict[str, Any]] = []
    n = len(df_1h)
    last_emit = -999
    used: set[int] = set()

    for i in range(start_idx, n - 1):
        if i in used or i - last_emit < 3:
            continue
        for side in ("short", "long"):
            swept = _sweep_and_reclaim(df_1h, idx=i, side=side)
            if not swept:
                continue
            confirm = _complete_reversal(df_1h, sweep_idx=i, side=side)
            complete = confirm is not None
            if not complete:
                if allow_incomplete:
                    # 明确不可交易
                    continue
                continue
            assert confirm is not None
            if confirm + 1 >= n:
                continue
            r1 = classify_trend_regime(df_1h, end_idx=confirm, tf="1h")
            r4 = None
            if df_4h is not None and len(df_4h) and "open_time" in df_1h.columns and "open_time" in df_4h.columns:
                t = int(df_1h.iloc[confirm]["open_time"])
                idx4 = int(df_4h["open_time"].astype(int).searchsorted(t, side="right") - 1)
                idx4 = max(0, min(idx4, len(df_4h) - 1))
                r4 = classify_trend_regime(df_4h, end_idx=idx4, tf="4h")
            elif df_4h is not None and len(df_4h):
                r4 = classify_trend_regime(df_4h, end_idx=len(df_4h) - 1, tf="4h")

            rng = identify_range(df_1h, end_idx=confirm)
            entry = float(df_1h.iloc[confirm + 1]["open"])
            is_short = side == "short"
            extreme = float(swept["sweepExtreme"])
            sl, used_sl = resolve_sl_price(
                entry=entry,
                is_short=is_short,
                structure_level=extreme,
                atr=_atr(df_1h, confirm),
                profile=sl_profile,
            )
            # 目标：区间中位，再对侧流动性
            if rng:
                mid = rng["mid"]
                opposite = rng["low"] if is_short else rng["high"]
            else:
                mid = (entry + extreme) / 2.0 if is_short else (entry + extreme) / 2.0
                # 对侧用最近反向摆动
                from oi_mornitor.market_regime import last_confirmed_swing

                opp = last_confirmed_swing(
                    df_1h, end_idx=confirm, which="low" if is_short else "high"
                )
                opposite = opp[1] if opp else mid
            # 保证 TP 在正确方向
            if is_short:
                tp1, tp2 = min(mid, entry - abs(entry - sl) * 0.8), opposite if opposite < entry else mid
                if tp1 >= entry:
                    tp1 = entry - abs(entry - sl) * 1.0
                if tp2 >= entry:
                    tp2 = entry - abs(entry - sl) * 2.0
            else:
                tp1, tp2 = max(mid, entry + abs(entry - sl) * 0.8), opposite if opposite > entry else mid
                if tp1 <= entry:
                    tp1 = entry + abs(entry - sl) * 1.0
                if tp2 <= entry:
                    tp2 = entry + abs(entry - sl) * 2.0

            oi = _oi(df_1h, confirm)
            opp_a = assess(
                symbol=symbol,
                side_intent=side,
                regime_4h=r4.label if r4 else "unknown",
                regime_1h=r1.label,
                structure_1h="choch",
                oi_status=oi,
                pattern=STRATEGY_ID,
                close_confirmed=True,
                sweep_reclaim_choch=True,
                extra_reasons=["Sweep + Reclaim + CHoCH 完整"],
            )
            trades.append({
                "strategy": STRATEGY_ID,
                "strategyLabel": STRATEGY_LABEL,
                "symbol": symbol,
                "interval": "1h",
                "kind": STRATEGY_ID,
                "typeLabel": STRATEGY_LABEL,
                "side": "bear" if is_short else "bull",
                "bar_index": confirm,
                "entry_bar": confirm + 1,
                "entry_mode": "next_bar_open",
                "entry": entry,
                "defense": extreme,
                "slPrice": sl,
                "slProfile": used_sl,
                "tp1Price": tp1,
                "tp2Price": tp2,
                "batchWeights": list(BATCH_WEIGHTS),
                "timeoutBars": TIMEOUT_BARS_1H,
                "sweepExtreme": extreme,
                "reclaimLevel": swept["liquidityLevel"],
                "chochBar": confirm,
                "complete": True,
                "regime4h": r4.to_dict() if r4 else None,
                "regime1h": r1.to_dict(),
                "oiStatus": oi,
                "opportunity": opp_a.to_dict(),
                "noTradeRules": ["仅 sweep 不可交易", "无 reclaim 不可交易", "无 CHoCH 不可交易"],
            })
            used.add(confirm)
            last_emit = confirm
            break
    return trades


def is_tradable_liquidity_event(flags: dict[str, Any] | None) -> bool:
    """Sweep-only / insufficient 不可交易。"""
    if not isinstance(flags, dict):
        return False
    return bool(flags.get("sweep") and flags.get("reclaim") and flags.get("choch"))


def _atr(df: pd.DataFrame, idx: int, period: int = 14) -> float:
    if idx < period:
        return 0.0
    trs: list[float] = []
    for i in range(max(1, idx - period + 1), idx + 1):
        row, prev = df.iloc[i], df.iloc[i - 1]
        h, l, pc = float(row["high"]), float(row["low"]), float(prev["close"])
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return sum(trs) / len(trs) if trs else 0.0


def _oi(df: pd.DataFrame, idx: int) -> str:
    if "oi" not in df.columns or idx < 1:
        return "oi_unavailable"
    try:
        c, p = float(df.iloc[idx]["oi"]), float(df.iloc[idx - 1]["oi"])
    except (TypeError, ValueError):
        return "oi_unavailable"
    if not (c > 0 and p > 0):
        return "oi_unavailable"
    return "confirmed" if abs(c - p) / p >= 0.005 else "pending"
