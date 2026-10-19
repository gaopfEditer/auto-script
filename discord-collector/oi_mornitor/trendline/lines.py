"""趋势线：连接 pivot，打分并保留每侧 top N。"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Literal

import numpy as np
import pandas as pd

from oi_mornitor.trendline.pivots import swing_high_indices, swing_low_indices

Side = Literal["support", "resistance"]


@dataclass(frozen=True)
class TrendLine:
    side: Side
    idx_a: int
    idx_b: int
    price_a: float
    price_b: float
    slope: float
    touches: int
    violations: int
    score: float
    line_id: str

    def price_at(self, bar_idx: int) -> float:
        return float(self.price_a + self.slope * (bar_idx - self.idx_a))


def _line_id(side: str, idx_a: int, idx_b: int) -> str:
    raw = f"{side}:{idx_a}:{idx_b}"
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def _count_touches_and_violations(
    df: pd.DataFrame,
    *,
    side: Side,
    idx_a: int,
    idx_b: int,
    price_a: float,
    slope: float,
    touch_tol_pct: float,
    close_viol_tol_pct: float,
    wick_viol_mult: float,
    end_idx: int,
) -> tuple[int, int]:
    start = min(idx_a, idx_b)
    if start > end_idx or end_idx < 0:
        return 0, 0
    end_idx = min(end_idx, len(df) - 1)
    ixs = np.arange(start, end_idx + 1, dtype=np.int64)
    levels = price_a + slope * (ixs - idx_a)
    valid = levels > 0
    if not np.any(valid):
        return 0, 0
    ixs = ixs[valid]
    levels = levels[valid]
    highs = df["high"].to_numpy(dtype=float)[ixs]
    lows = df["low"].to_numpy(dtype=float)[ixs]
    closes = df["close"].to_numpy(dtype=float)[ixs]
    opens = df["open"].to_numpy(dtype=float)[ixs]
    tol = levels * touch_tol_pct
    dist = np.minimum(
        np.abs(highs - levels),
        np.minimum(np.abs(lows - levels), np.abs(closes - levels)),
    )
    touches = int(np.sum(dist <= tol))
    viol_tol = levels * close_viol_tol_pct
    if side == "support":
        close_viol = closes < levels - viol_tol
        wick_only = (lows < levels - tol) & (closes >= levels - viol_tol)
        violations = int(np.sum(close_viol & ~wick_only))
    else:
        close_viol = closes > levels + viol_tol
        wick_only = (highs > levels + tol) & (closes <= levels + viol_tol)
        violations = int(np.sum(close_viol & ~wick_only))
    return touches, violations


def _rising_lows_ok(df: pd.DataFrame, i: int, j: int) -> bool:
    p_i = float(df.iloc[i]["low"])
    p_j = float(df.iloc[j]["low"])
    return p_j >= p_i * 0.998


def _falling_highs_ok(df: pd.DataFrame, i: int, j: int) -> bool:
    p_i = float(df.iloc[i]["high"])
    p_j = float(df.iloc[j]["high"])
    return p_j <= p_i * 1.002


def build_candidate_lines(
    df: pd.DataFrame,
    *,
    side: Side,
    end_idx: int,
    touch_tol_pct: float,
    close_viol_tol_pct: float,
    wick_viol_mult: float,
    min_touches: int,
    lookback_bars: int,
) -> list[TrendLine]:
    start_idx = max(0, end_idx - lookback_bars)
    if side == "support":
        pivots = [i for i in swing_low_indices(df) if start_idx <= i <= end_idx]
        price_key = "low"
        ok_pair = _rising_lows_ok
    else:
        pivots = [i for i in swing_high_indices(df) if start_idx <= i <= end_idx]
        price_key = "high"
        ok_pair = _falling_highs_ok

    if len(pivots) < 2:
        return []

    candidates: list[TrendLine] = []
    for a in range(len(pivots)):
        for b in range(a + 1, len(pivots)):
            i, j = pivots[a], pivots[b]
            if j - i < 3:
                continue
            if not ok_pair(df, i, j):
                continue
            p_i = float(df.iloc[i][price_key])
            p_j = float(df.iloc[j][price_key])
            slope = (p_j - p_i) / (j - i)
            touches, violations = _count_touches_and_violations(
                df,
                side=side,
                idx_a=i,
                idx_b=j,
                price_a=p_i,
                slope=slope,
                touch_tol_pct=touch_tol_pct,
                close_viol_tol_pct=close_viol_tol_pct,
                wick_viol_mult=wick_viol_mult,
                end_idx=end_idx,
            )
            if touches < min_touches:
                continue
            recency = (j / max(end_idx, 1)) * 2.0 + (end_idx - j) * -0.001
            score = touches * 3.0 + recency - violations * 4.0
            candidates.append(
                TrendLine(
                    side=side,
                    idx_a=i,
                    idx_b=j,
                    price_a=p_i,
                    price_b=p_j,
                    slope=slope,
                    touches=touches,
                    violations=violations,
                    score=score,
                    line_id=_line_id(side, i, j),
                )
            )
    return candidates


def select_top_lines(
    candidates: list[TrendLine],
    *,
    max_per_side: int,
) -> list[TrendLine]:
    if not candidates:
        return []
    ranked = sorted(candidates, key=lambda x: x.score, reverse=True)
    out: list[TrendLine] = []
    used: set[str] = set()
    for line in ranked:
        if line.line_id in used:
            continue
        out.append(line)
        used.add(line.line_id)
        if len(out) >= max_per_side:
            break
    return out


def detect_trendlines(
    df: pd.DataFrame,
    *,
    end_idx: int,
    touch_tol_pct: float,
    close_viol_tol_pct: float,
    wick_viol_mult: float,
    min_touches: int,
    max_per_side: int,
    lookback_bars: int,
) -> list[TrendLine]:
    sup = build_candidate_lines(
        df,
        side="support",
        end_idx=end_idx,
        touch_tol_pct=touch_tol_pct,
        close_viol_tol_pct=close_viol_tol_pct,
        wick_viol_mult=wick_viol_mult,
        min_touches=min_touches,
        lookback_bars=lookback_bars,
    )
    res = build_candidate_lines(
        df,
        side="resistance",
        end_idx=end_idx,
        touch_tol_pct=touch_tol_pct,
        close_viol_tol_pct=close_viol_tol_pct,
        wick_viol_mult=wick_viol_mult,
        min_touches=min_touches,
        lookback_bars=lookback_bars,
    )
    return select_top_lines(sup, max_per_side=max_per_side) + select_top_lines(
        res, max_per_side=max_per_side
    )


def line_to_dict(line: TrendLine, *, end_idx: int, df: pd.DataFrame) -> dict:
    level = line.price_at(end_idx)
    return {
        "line_id": line.line_id,
        "side": line.side,
        "price_now": level,
        "slope": line.slope,
        "touches": line.touches,
        "violations": line.violations,
        "score": line.score,
        "idx_a": line.idx_a,
        "idx_b": line.idx_b,
        "open_time_a": int(df.iloc[line.idx_a]["open_time"]) if len(df) else 0,
        "open_time_b": int(df.iloc[line.idx_b]["open_time"]) if len(df) else 0,
    }
