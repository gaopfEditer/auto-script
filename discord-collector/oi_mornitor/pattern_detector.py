"""
形态图表指标与 K 线标注（BB / Vegas / MACD / 蜡烛形态）。

注：旧 LH→HL→带量突破扳机状态机已移除，仅保留图表渲染与蜡烛扫描所需指标。
"""
from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.config import (
    PATTERN_BB_LENGTH,
    PATTERN_BB_MULT,
    PATTERN_PIVOT_WINDOW,
    PATTERN_WICK_RATIO,
    STRATEGY_VEGAS_FILTER,
    STRATEGY_VEGAS_PERIODS,
)
from oi_mornitor.strategy.candle_signals import collect_candle_signal_markers
from oi_mornitor.strategy.sweep_momentum import evaluate_sweep_momentum_from_df

STATUS_SEARCHING = "SEARCHING_TOP"
STATUS_EXPIRED = "EXPIRED"

STATUS_LABELS: dict[str, str] = {
    STATUS_SEARCHING: "监听中",
    STATUS_EXPIRED: "已过期",
}


def enrich_indicators(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["bb_basis"] = out["close"].rolling(PATTERN_BB_LENGTH).mean()
    out["bb_std"] = out["close"].rolling(PATTERN_BB_LENGTH).std(ddof=0)
    out["bb_upper"] = out["bb_basis"] + PATTERN_BB_MULT * out["bb_std"]
    out["bb_lower"] = out["bb_basis"] - PATTERN_BB_MULT * out["bb_std"]

    ema12 = out["close"].ewm(span=12, adjust=False).mean()
    ema26 = out["close"].ewm(span=26, adjust=False).mean()
    out["macd"] = ema12 - ema26
    out["macd_signal"] = out["macd"].ewm(span=9, adjust=False).mean()
    out["macd_hist"] = out["macd"] - out["macd_signal"]
    out["vol_sma20"] = out["volume"].rolling(20).mean()

    # Vegas 双通道：过滤线 12 + A组 144/169 + B组 576/676
    out["vegas_filter"] = out["close"].ewm(span=STRATEGY_VEGAS_FILTER, adjust=False).mean()
    for i, period in enumerate(STRATEGY_VEGAS_PERIODS, start=1):
        out[f"vegas_e{i}"] = out["close"].ewm(span=period, adjust=False).mean()

    win = PATTERN_PIVOT_WINDOW
    out["is_pivot_high"] = out["high"] == out["high"].rolling(win, center=True).max()
    out["is_pivot_low"] = out["low"] == out["low"].rolling(win, center=True).min()
    out["is_pivot_high"] = out["is_pivot_high"].fillna(False)
    out["is_pivot_low"] = out["is_pivot_low"].fillna(False)
    return out


def _bb_upper_wick(row: pd.Series) -> bool:
    body = abs(float(row["close"]) - float(row["open"]))
    upper_wick = float(row["high"]) - max(float(row["open"]), float(row["close"]))
    if float(row["high"]) <= float(row["bb_upper"]):
        return False
    if float(row["close"]) >= float(row["bb_upper"]):
        return False
    if upper_wick <= 0:
        return False
    return body == 0 or upper_wick / body >= PATTERN_WICK_RATIO


def _macd_top_weak(df: pd.DataFrame) -> bool:
    if len(df) < 3:
        return False
    last = df.iloc[-1]
    prev = df.iloc[-2]
    death_cross = float(last["macd"]) < float(last["macd_signal"])
    hist_shrink = (
        float(last["macd_hist"]) > 0
        and float(last["macd_hist"]) < float(prev["macd_hist"])
    )
    return death_cross or hist_shrink


def _macd_bull_filter(df: pd.DataFrame) -> bool:
    if len(df) < 2:
        return False
    last = df.iloc[-1]
    prev = df.iloc[-2]
    golden = float(last["macd"]) > float(last["macd_signal"])
    hist_grow = float(last["macd_hist"]) > float(prev["macd_hist"])
    return golden and hist_grow


def _ts_sec(open_time_ms: int) -> int:
    return int(open_time_ms // 1000)


def _safe_float(val: Any, default: float = 0.0) -> float:
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def _sort_series_by_time(items: list[dict[str, Any]], key: str = "time") -> list[dict[str, Any]]:
    return sorted(items, key=lambda x: x[key])


def _dedupe_candles(candles: list[dict[str, float | int]]) -> list[dict[str, float | int]]:
    seen: set[int] = set()
    out: list[dict[str, float | int]] = []
    for c in sorted(candles, key=lambda x: int(x["time"])):
        t = int(c["time"])
        if t in seen:
            continue
        seen.add(t)
        out.append(c)
    return out


def build_pattern_chart_payload(
    klines: list[list],
    *,
    state: dict[str, Any] | None = None,
    oi_by_time: dict[int, float] | None = None,
    derivatives_ctx: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    构建 K 线 + 形态拐点标注数据，供前端图表渲染。
    oi_by_time: open_time 秒 → 持仓量，用于 (oi异动) 标注与 OI 曲线。
    derivatives_ctx: 资金费率 / OI 共振 / 多周期 / 清算区。
    """
    state = state or {}
    df = klines_to_df(klines)
    if df.empty:
        return {
            "candles": [],
            "markers": [],
            "price_lines": [],
            "analysis": {},
            "bb": {"upper": [], "mid": [], "lower": []},
            "vegas": {"filter": [], "a1": [], "a2": [], "b1": [], "b2": []},
            "macd": {"line": [], "signal": [], "hist": []},
            "oi": [],
        }

    df = enrich_indicators(df)
    if oi_by_time:
        df["oi"] = [
            oi_by_time.get(_ts_sec(int(ot)), float("nan"))
            for ot in df["open_time"].tolist()
        ]
    candles: list[dict[str, float | int]] = []
    bb_upper: list[dict[str, float | int]] = []
    bb_mid: list[dict[str, float | int]] = []
    bb_lower: list[dict[str, float | int]] = []
    macd_line: list[dict[str, float | int]] = []
    macd_signal: list[dict[str, float | int]] = []
    macd_hist: list[dict[str, float | int]] = []
    oi_series: list[dict[str, float | int]] = []
    vegas: dict[str, list[dict[str, float | int]]] = {
        "filter": [],
        "a1": [],
        "a2": [],
        "b1": [],
        "b2": [],
    }
    vegas_keys = list(vegas.keys())
    vegas_cols = ["vegas_filter"] + [f"vegas_e{i}" for i in range(1, len(STRATEGY_VEGAS_PERIODS) + 1)]

    for row in df.itertuples(index=False):
        t = _ts_sec(int(row.open_time))
        candles.append({
            "time": t,
            "open": float(row.open),
            "high": float(row.high),
            "low": float(row.low),
            "close": float(row.close),
            "volume": float(row.volume),
        })
        if pd.notna(row.bb_upper):
            bb_upper.append({"time": t, "value": float(row.bb_upper)})
            bb_mid.append({"time": t, "value": float(row.bb_basis)})
            bb_lower.append({"time": t, "value": float(row.bb_lower)})
        if pd.notna(getattr(row, "macd", None)):
            macd_line.append({"time": t, "value": float(row.macd)})
            macd_signal.append({"time": t, "value": float(row.macd_signal)})
            macd_hist.append({"time": t, "value": float(row.macd_hist)})
        oi_val = getattr(row, "oi", None)
        if oi_val is not None and pd.notna(oi_val) and float(oi_val) > 0:
            oi_series.append({"time": t, "value": float(oi_val)})
        for key, col in zip(vegas_keys, vegas_cols):
            val = getattr(row, col, None)
            if val is not None and pd.notna(val):
                vegas[key].append({"time": t, "value": float(val)})

    markers: list[dict[str, Any]] = []
    last = df.iloc[-1]
    analysis: dict[str, Any] = {
        "status": STATUS_SEARCHING,
        "status_label": STATUS_LABELS[STATUS_SEARCHING],
        "message": "",
    }

    # 射击之星 / 倒锤子 / 连续插针 + OI 异动
    markers.extend(collect_candle_signal_markers(df))

    price_lines: list[dict[str, Any]] = []
    if derivatives_ctx:
        for lz in derivatives_ctx.get("liquidation_zones") or []:
            if isinstance(lz, dict) and float(lz.get("price") or 0) > 0:
                price_lines.append(lz)

    last_ts = _ts_sec(int(last["open_time"]))
    analysis.update({
        "last_price": float(last["close"]),
        "bb_wick_top": bool(_bb_upper_wick(last)),
        "macd_bull": bool(_macd_bull_filter(df)),
        "macd_top_weak": bool(_macd_top_weak(df)),
        "oi_anomaly": any(
            bool(m.get("oi_anomaly")) and int(m.get("time") or 0) == last_ts
            for m in markers
            if isinstance(m, dict)
        ),
        "oi_anomaly_only": any(
            str(m.get("kind") or "") == "oi_anomaly" and int(m.get("time") or 0) == last_ts
            for m in markers
            if isinstance(m, dict)
        ),
    })
    sweep = evaluate_sweep_momentum_from_df(df, symbol=str(state.get("symbol") or ""))
    if sweep:
        analysis["sweep_momentum"] = sweep
    if derivatives_ctx:
        analysis["derivatives"] = derivatives_ctx

    return {
        "candles": _dedupe_candles(candles),
        "markers": _sort_series_by_time(markers),
        "price_lines": price_lines,
        "oi": _sort_series_by_time(oi_series),
        "bb": {
            "upper": _sort_series_by_time(bb_upper),
            "mid": _sort_series_by_time(bb_mid),
            "lower": _sort_series_by_time(bb_lower),
        },
        "vegas": {key: _sort_series_by_time(pts) for key, pts in vegas.items()},
        "macd": {
            "line": _sort_series_by_time(macd_line),
            "signal": _sort_series_by_time(macd_signal),
            "hist": _sort_series_by_time(macd_hist),
        },
        "analysis": analysis,
    }
