"""趋势线贴近 + 形态触发 → 告警 payload。"""
from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.ma144_reversal_signals import enrich_ema144, near_ema144
from oi_mornitor.strategy.candle_signals import closed_bar_index, _ts_sec
from oi_mornitor.strategy.indicators import enrich_strategy_indicators
from oi_mornitor.trendline.lines import TrendLine, detect_trendlines, line_to_dict
from oi_mornitor.trendline.patterns import classify_reversal_at_line
from oi_mornitor.trendline.pivots import mark_swing_pivots
from oi_mornitor.trendline_config import (
    TRENDLINE_BREAKOUT_RETEST_BARS,
    TRENDLINE_CLOSE_VIOLATION_TOL_PCT,
    TRENDLINE_EMA_NEAR_TOL_PCT,
    TRENDLINE_LOOKBACK_BARS,
    TRENDLINE_MAX_LINES_PER_SIDE,
    TRENDLINE_MIN_TOUCHES,
    TRENDLINE_NEAR_ATR_MULT,
    TRENDLINE_NEAR_PCT,
    TRENDLINE_PIVOT_LEFT,
    TRENDLINE_PIVOT_RIGHT,
    TRENDLINE_RSI_OVERSOLD,
    TRENDLINE_SL_BUFFER_MAX_PCT,
    TRENDLINE_SL_BUFFER_MIN_PCT,
    TRENDLINE_SL_BUFFER_PCT,
    TRENDLINE_TOUCH_TOL_PCT,
    TRENDLINE_VOL_MULT,
    TRENDLINE_WICK_VIOLATION_MULT,
)
from oi_mornitor.candle_card_config import volume_ratio_from_row


def enrich_trendline_frame(df: pd.DataFrame) -> pd.DataFrame:
    work = enrich_strategy_indicators(df)
    work = enrich_ema144(work)
    work = mark_swing_pivots(work, left=TRENDLINE_PIVOT_LEFT, right=TRENDLINE_PIVOT_RIGHT)
    if "atr14" not in work.columns:
        tr = pd.concat(
            [
                work["high"] - work["low"],
                (work["high"] - work["close"].shift(1)).abs(),
                (work["low"] - work["close"].shift(1)).abs(),
            ],
            axis=1,
        ).max(axis=1)
        work["atr14"] = tr.rolling(14).mean()
    if "rsi14" not in work.columns:
        delta = work["close"].diff()
        gain = delta.clip(lower=0).rolling(14).mean()
        loss = (-delta.clip(upper=0)).rolling(14).mean()
        rs = gain / loss.replace(0, pd.NA)
        work["rsi14"] = 100 - (100 / (1 + rs))
    return work


def _near_line(row: pd.Series, level: float, atr: float) -> tuple[bool, float, float]:
    if level <= 0:
        return False, 0.0, 0.0
    c = float(row["close"])
    dist = min(abs(float(row["high"]) - level), abs(float(row["low"]) - level), abs(c - level))
    dist_pct = dist / c if c > 0 else 0.0
    dist_atr = dist / atr if atr and atr > 0 else float("inf")
    near = dist_pct <= TRENDLINE_NEAR_PCT or dist_atr <= TRENDLINE_NEAR_ATR_MULT
    return near, dist_pct, dist_atr


def detect_active_lines(
    df: pd.DataFrame,
    *,
    end_idx: int | None = None,
) -> list[dict[str, Any]]:
    work = enrich_trendline_frame(df)
    idx = end_idx if end_idx is not None else len(work) - 1
    if idx < 30:
        return []
    lines = detect_trendlines(
        work,
        end_idx=idx,
        touch_tol_pct=TRENDLINE_TOUCH_TOL_PCT,
        close_viol_tol_pct=TRENDLINE_CLOSE_VIOLATION_TOL_PCT,
        wick_viol_mult=TRENDLINE_WICK_VIOLATION_MULT,
        min_touches=TRENDLINE_MIN_TOUCHES,
        max_per_side=TRENDLINE_MAX_LINES_PER_SIDE,
        lookback_bars=TRENDLINE_LOOKBACK_BARS,
    )
    return [line_to_dict(ln, end_idx=idx, df=work) for ln in lines]


def _htf_tag(htf_df: pd.DataFrame | None) -> str:
    if htf_df is None or htf_df.empty or len(htf_df) < 30:
        return "HTF·未知"
    work = enrich_trendline_frame(htf_df)
    idx = len(work) - 1
    c = float(work.iloc[idx]["close"])
    ema = float(work.iloc[idx].get("ema144") or c)
    if c > ema * 1.002:
        return "HTF·偏多"
    if c < ema * 0.998:
        return "HTF·偏空"
    return "HTF·震荡"


def _sl_tp_plan(
    *,
    side: str,
    entry: float,
    line_price: float,
    pattern_extreme: float,
    opposite_line: float | None,
) -> dict[str, float]:
    buf = max(
        TRENDLINE_SL_BUFFER_MIN_PCT,
        min(TRENDLINE_SL_BUFFER_PCT, TRENDLINE_SL_BUFFER_MAX_PCT),
    )
    if side in ("long", "bull"):
        sl_base = min(line_price, pattern_extreme)
        sl = sl_base * (1 - buf)
        risk = max(entry - sl, entry * 0.001)
        tp1 = entry + risk
        tp2 = entry + 2 * risk
        if opposite_line and opposite_line > entry:
            tp2 = opposite_line
    else:
        sl_base = max(line_price, pattern_extreme)
        sl = sl_base * (1 + buf)
        risk = max(sl - entry, entry * 0.001)
        tp1 = entry - risk
        tp2 = entry - 2 * risk
        if opposite_line and opposite_line < entry:
            tp2 = opposite_line
    step_pct = (risk / entry) * 100 if entry > 0 else 3.0
    return {
        "entry": entry,
        "sl": sl,
        "tp1": tp1,
        "tp2": tp2,
        "step_pct": step_pct,
        "invalid_level": sl,
    }


def evaluate_bar_signal(
    df: pd.DataFrame,
    *,
    end_idx: int,
    asset: str,
    interval: str,
    type_label_prefix: str,
    htf_df: pd.DataFrame | None = None,
    require_ema_confluence: bool = False,
    bb_ema_combo: bool = False,
) -> dict[str, Any] | None:
    work = enrich_trendline_frame(df)
    if end_idx < 30 or end_idx >= len(work):
        return None
    row = work.iloc[end_idx]
    atr = float(row.get("atr14") or 0)
    lines = detect_trendlines(
        work,
        end_idx=end_idx,
        touch_tol_pct=TRENDLINE_TOUCH_TOL_PCT,
        close_viol_tol_pct=TRENDLINE_CLOSE_VIOLATION_TOL_PCT,
        wick_viol_mult=TRENDLINE_WICK_VIOLATION_MULT,
        min_touches=TRENDLINE_MIN_TOUCHES,
        max_per_side=TRENDLINE_MAX_LINES_PER_SIDE,
        lookback_bars=TRENDLINE_LOOKBACK_BARS,
    )
    if not lines:
        return None

    vol_ratio = volume_ratio_from_row(row)
    vol_bonus = vol_ratio is not None and float(vol_ratio) >= TRENDLINE_VOL_MULT
    ema_near = near_ema144(row, tol_pct=TRENDLINE_EMA_NEAR_TOL_PCT)
    rsi = float(row.get("rsi14") or 50)
    oversold = rsi < TRENDLINE_RSI_OVERSOLD
    ema_val = float(row.get("ema144") or 0)
    below_ema = ema_val > 0 and float(row["close"]) < ema_val * 0.99

    best: dict[str, Any] | None = None
    best_score = -1.0

    for line in lines:
        level = line.price_at(end_idx)
        near, dist_pct, dist_atr = _near_line(row, level, atr)
        if not near:
            continue
        pat = classify_reversal_at_line(
            work,
            end_idx,
            line=line,
            touch_tol_pct=TRENDLINE_TOUCH_TOL_PCT,
            breakout_lookback=TRENDLINE_BREAKOUT_RETEST_BARS,
        )
        if not pat:
            continue
        trade_side = pat["trade_side"]
        if require_ema_confluence and not ema_near:
            continue
        if bb_ema_combo:
            at_bb_low = float(row["low"]) <= float(row.get("bb_lower") or row["low"])
            if not (ema_near and at_bb_low and pat["pattern"] in ("hammer", "pin_bar", "inverted_hammer")):
                continue

        score = line.score + (2.0 if vol_bonus else 0.0) + (1.5 if ema_near else 0.0)
        if oversold and trade_side == "long":
            score += 1.0
        if below_ema and trade_side == "long":
            score += 0.5
        if score <= best_score:
            continue

        entry = float(row["close"])
        extreme = float(row["low"] if trade_side == "long" else row["high"])
        opp = None
        for other in lines:
            if other.side != line.side:
                opp = other.price_at(end_idx)
                break
        plan = _sl_tp_plan(
            side=trade_side,
            entry=entry,
            line_price=level,
            pattern_extreme=extreme,
            opposite_line=opp,
        )
        tags: list[str] = [_htf_tag(htf_df)]
        if ema_near:
            tags.append("EMA144共振")
        if vol_bonus:
            tags.append(f"放量{float(vol_ratio):.1f}x")
        if oversold:
            tags.append("超卖RSI")
        if bb_ema_combo and ema_near:
            tags.append("布林+EMA144")

        label = type_label_prefix
        if require_ema_confluence and ema_near:
            label = type_label_prefix.replace("趋势线", "趋势线+EMA144", 1)

        best_score = score
        closed_ts = _ts_sec(int(row["open_time"]))
        best = {
            "asset": asset,
            "interval": interval,
            "line_id": line.line_id,
            "line_side": line.side,
            "line_price": level,
            "distance_pct": dist_pct,
            "distance_atr": dist_atr,
            "pattern": pat["pattern"],
            "side": "bull" if trade_side == "long" else "bear",
            "trade_side": trade_side,
            "type_label": label,
            "vol_ratio": vol_ratio,
            "vol_bonus": vol_bonus,
            "ema144": ema_val if ema_val > 0 else None,
            "ema_near": ema_near,
            "tags": tags,
            "score": score,
            "entry": plan["entry"],
            "sl": plan["sl"],
            "tp1": plan["tp1"],
            "tp2": plan["tp2"],
            "step_pct": plan["step_pct"],
            "invalid_level": plan["invalid_level"],
            "time": closed_ts,
            "kline_open_time": closed_ts,
            "kline_close_time": int(row.get("close_time") or (int(row["open_time"]) + 1)),
            "kind": f"tl_{pat['pattern']}_{line.line_id[:6]}",
        }
    return best


def find_last_closed_trendline_hit(
    df: pd.DataFrame,
    *,
    now_ms: int | None = None,
    asset: str,
    interval: str,
    type_label_prefix: str,
    htf_df: pd.DataFrame | None = None,
    require_ema_confluence: bool = False,
    bb_ema_combo: bool = False,
) -> dict[str, Any] | None:
    work = enrich_trendline_frame(df)
    idx = closed_bar_index(work, now_ms=now_ms)
    return evaluate_bar_signal(
        work,
        end_idx=idx,
        asset=asset,
        interval=interval,
        type_label_prefix=type_label_prefix,
        htf_df=htf_df,
        require_ema_confluence=require_ema_confluence,
        bb_ema_combo=bb_ema_combo,
    )
