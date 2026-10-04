"""涨跌榜标签：顺势 / 反转。"""
from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.strategy.ma_confluence import ema_alignment


def tag_board_context(
    *,
    board: str,
    alignment: str,
    family: str,
    side: str,
) -> dict[str, Any]:
    """board: gainer / loser / none。"""
    scene = "unknown"
    if board == "gainer" and side == "long" and alignment == "bull":
        scene = "gainer_trend"
    elif board == "gainer" and side == "short":
        scene = "gainer_reversal"
    elif board == "loser" and side == "long":
        scene = "loser_bounce"
    elif board == "loser" and side == "short" and alignment == "bear":
        scene = "loser_trend"
    return {"board": board, "board_scene": scene, "alignment": alignment}


def rank_from_returns(returns: dict[str, float], *, top_n: int = 15) -> tuple[set[str], set[str]]:
    pos = sorted(((s, r) for s, r in returns.items() if r > 0), key=lambda x: x[1], reverse=True)
    neg = sorted(((s, r) for s, r in returns.items() if r < 0), key=lambda x: x[1])
    return {s for s, _ in pos[:top_n]}, {s for s, _ in neg[:top_n]}


def last_return(df: pd.DataFrame, bars: int) -> float:
    if df is None or len(df) <= bars:
        return 0.0
    a = float(df.iloc[-bars - 1]["close"])
    b = float(df.iloc[-1]["close"])
    if a <= 0:
        return 0.0
    return (b - a) / a


def alignment_from_df(df: pd.DataFrame) -> str:
    if df is None or df.empty:
        return "unknown"
    row = df.iloc[-1]
    return ema_alignment(row)
