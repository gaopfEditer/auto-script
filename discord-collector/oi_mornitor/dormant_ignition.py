"""沉寂池 → 三阶段漏斗点火（1h）；兼容旧 scan_dormant_breakout_* 入口。"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.dormant_funnel import evaluate_dormant_funnel_df


def _attach_oi(df: pd.DataFrame, oi_map: dict[int, float] | None) -> pd.DataFrame:
    if not oi_map or df.empty:
        out = df.copy()
        out["open_interest"] = np.nan
        return out
    out = df.copy()
    out["open_interest"] = [
        oi_map.get(int(ot // 1000), float("nan")) for ot in out["open_time"].tolist()
    ]
    return out


def scan_dormant_breakout_df(
    df: pd.DataFrame,
    *,
    funding_rate_pct: float | None = None,
) -> dict[str, Any]:
    """输入 1h OHLCV + open_interest（可选），建议 ≥750 根。"""
    ev = evaluate_dormant_funnel_df(df, funding_rate_pct=funding_rate_pct)
    if ev.get("signal"):
        detail = ev.get("detail") if isinstance(ev.get("detail"), dict) else {}
        return {
            "status": "IGNITION_SIGNAL",
            "confidence": ev.get("confidence"),
            "score": ev.get("score"),
            "detail": detail,
        }
    if ev.get("stage") == "CANDIDATE":
        return {"status": "CANDIDATE", **ev}
    return {"status": "NORMAL", **ev}


def scan_dormant_breakout_klines(
    klines: list[list[Any]],
    *,
    oi_map: dict[int, float] | None = None,
    funding_rate_pct: float | None = None,
) -> dict[str, Any]:
    df = klines_to_df(klines)
    df = _attach_oi(df, oi_map)
    return scan_dormant_breakout_df(df, funding_rate_pct=funding_rate_pct)
