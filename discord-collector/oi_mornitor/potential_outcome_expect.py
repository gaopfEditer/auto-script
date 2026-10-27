"""潜力跟踪 · 窗口终点是否符合预期（可配置、可单测）。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.potential_outcome_config import (
    POTENTIAL_TRACK_EXPECT_MAX_MAE_PCT,
    POTENTIAL_TRACK_EXPECT_MIN_RETURN_PCT,
)


def evaluate_track_expectation(
    *,
    direction: str,
    end_pnl_pct: float | None,
    max_profit_pct: float | None,
    max_drawdown_pct: float | None,
    min_return_pct: float = POTENTIAL_TRACK_EXPECT_MIN_RETURN_PCT,
    max_mae_pct: float = POTENTIAL_TRACK_EXPECT_MAX_MAE_PCT,
) -> dict[str, Any]:
    """
    口径（与实盘方向一致，百分比均为正数表示幅度）：
    - long / short：终点盈亏 >= min_return 且 窗口内最大不利波动 (MAE) <= max_mae
    - neutral：窗口内 MFE (max_profit) >= min_return 且 MAE <= max_mae
    """
    d = str(direction or "long").lower()
    mfe = max_profit_pct if max_profit_pct is not None else None
    mae = max_drawdown_pct if max_drawdown_pct is not None else None
    end = end_pnl_pct

    if mae is None:
        return {
            "met": None,
            "label": "数据不足",
            "rule": "missing_mae",
        }

    if mae > max_mae_pct:
        return {
            "met": False,
            "label": "不符合",
            "rule": "mae_exceeded",
            "detail": f"MAE {mae:.2f}% > {max_mae_pct}%",
        }

    if d == "neutral":
        if mfe is None:
            return {"met": None, "label": "数据不足", "rule": "missing_mfe"}
        ok = mfe >= min_return_pct
        return {
            "met": ok,
            "label": "符合" if ok else "不符合",
            "rule": "neutral_mfe",
            "detail": f"MFE {mfe:.2f}% vs 门槛 {min_return_pct}%",
        }

    if end is None:
        return {"met": None, "label": "数据不足", "rule": "missing_end_pnl"}
    ok = end >= min_return_pct
    return {
        "met": ok,
        "label": "符合" if ok else "不符合",
        "rule": "directional_end_pnl",
        "detail": f"终点 {end:.2f}% vs 门槛 {min_return_pct}%",
    }
