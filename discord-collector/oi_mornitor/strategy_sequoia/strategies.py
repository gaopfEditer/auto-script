"""六种 Sequoia 策略（加密适配）— 在 OHLCV DataFrame 上打点。"""
from __future__ import annotations

from typing import Any, Callable

import numpy as np
import pandas as pd

from oi_mornitor.strategy_sequoia import config as cfg
from oi_mornitor.strategy_sequoia.indicators import (
    add_basic_cols,
    ensure_ohlcv,
    pct_change_lookback,
    prior_high,
    sma,
    vol_ok,
)
from oi_mornitor.strategy_sequoia.registry import STRATEGY_META, resolve_strategy_ids


def _hit(
    *,
    strategy_id: str,
    bar_index: int,
    row: pd.Series,
    reason: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    meta = STRATEGY_META[strategy_id]
    open_ms = int(row["open_time"]) if "open_time" in row.index and pd.notna(row["open_time"]) else 0
    close_ms = int(row["close_time"]) if "close_time" in row.index and pd.notna(row.get("close_time")) else open_ms
    out: dict[str, Any] = {
        "strategy_id": strategy_id,
        "kind": meta["kind"],
        "type_label": meta["type_label"],
        "side": meta["side"],
        "bar_index": int(bar_index),
        "open_time": open_ms,
        "close_time": close_ms,
        "open": float(row["open"]),
        "high": float(row["high"]),
        "low": float(row["low"]),
        "close": float(row["close"]),
        "price": float(row["close"]),
        "volume": float(row["volume"]),
        "reason": reason,
    }
    if extra:
        out.update(extra)
    return out


def detect_turtle_trade(df: pd.DataFrame) -> list[dict[str, Any]]:
    n = cfg.SEQUOIA_TURTLE_N
    work = add_basic_cols(df, vol_sma=20)
    if len(work) < n + 5:
        return []
    work = work.copy()
    work["ph"] = prior_high(work["high"], n)
    hits: list[dict[str, Any]] = []
    for i in range(n + 1, len(work)):
        row = work.iloc[i]
        ph = row.get("ph")
        if ph is None or not np.isfinite(ph) or float(ph) <= 0:
            continue
        if float(row["close"]) <= float(ph):
            continue
        if float(row["high"]) < float(ph):
            continue
        if not vol_ok(row, cfg.SEQUOIA_TURTLE_LIQ_MULT):
            continue
        if cfg.SEQUOIA_TURTLE_REQUIRE_BULL and not bool(row["is_bull"]):
            continue
        hits.append(
            _hit(
                strategy_id="turtle_trade",
                bar_index=i,
                row=row,
                reason=f"收盘突破前{n}高 {float(ph):.6g} + 量≥{cfg.SEQUOIA_TURTLE_LIQ_MULT}×MA20",
                extra={"break_level": float(ph), "vol_ratio": float(row["volume"]) / float(row["vol_sma"])},
            )
        )
    return hits


def detect_ma_volume(df: pd.DataFrame) -> list[dict[str, Any]]:
    s_n = cfg.SEQUOIA_MA_SHORT
    l_n = cfg.SEQUOIA_MA_LONG
    if l_n <= s_n:
        l_n = s_n + 5
    work = add_basic_cols(df, vol_sma=cfg.SEQUOIA_MA_VOL_SMA)
    if len(work) < l_n + 3:
        return []
    work = work.copy()
    work["ma_s"] = sma(work["close"], s_n)
    work["ma_l"] = sma(work["close"], l_n)
    hits: list[dict[str, Any]] = []
    for i in range(l_n + 1, len(work)):
        row = work.iloc[i]
        prev = work.iloc[i - 1]
        if any(pd.isna(x) for x in (row["ma_s"], row["ma_l"], prev["ma_s"], prev["ma_l"])):
            continue
        crossed = float(prev["ma_s"]) <= float(prev["ma_l"]) and float(row["ma_s"]) > float(row["ma_l"])
        if not crossed:
            continue
        if not vol_ok(row, cfg.SEQUOIA_MA_VOL_MULT):
            continue
        hits.append(
            _hit(
                strategy_id="ma_volume",
                bar_index=i,
                row=row,
                reason=f"MA{s_n}上穿MA{l_n} + 量≥{cfg.SEQUOIA_MA_VOL_MULT}×MA{cfg.SEQUOIA_MA_VOL_SMA}",
                extra={
                    "ma_short": float(row["ma_s"]),
                    "ma_long": float(row["ma_l"]),
                    "vol_ratio": float(row["volume"]) / float(row["vol_sma"]),
                },
            )
        )
    return hits


def detect_high_tight_flag(df: pd.DataFrame) -> list[dict[str, Any]]:
    run_lb = cfg.SEQUOIA_HTF_RUN_LOOKBACK
    flag_n = cfg.SEQUOIA_HTF_FLAG_BARS
    work = add_basic_cols(df, vol_sma=20)
    need = run_lb + flag_n + 5
    if len(work) < need:
        return []
    work = work.copy()
    work["run_pct"] = pct_change_lookback(work["close"], run_lb)
    hits: list[dict[str, Any]] = []
    for i in range(need, len(work)):
        # 旗形窗口：最近 flag_n 根（含当前）
        flag = work.iloc[i - flag_n + 1 : i + 1]
        run_end = i - flag_n
        if run_end < run_lb:
            continue
        run_pct = float(work.iloc[run_end]["run_pct"]) if pd.notna(work.iloc[run_end]["run_pct"]) else None
        if run_pct is None or run_pct < cfg.SEQUOIA_HTF_RUN_MIN_PCT:
            continue
        hi = float(flag["high"].max())
        lo = float(flag["low"].min())
        mid = float(flag["close"].mean())
        if mid <= 0:
            continue
        range_pct = (hi - lo) / mid * 100.0
        if range_pct > cfg.SEQUOIA_HTF_FLAG_MAX_RANGE_PCT:
            continue
        run_vol = float(work.iloc[run_end - run_lb + 1 : run_end + 1]["volume"].mean())
        flag_vol = float(flag["volume"].mean())
        if run_vol <= 0 or flag_vol > run_vol * cfg.SEQUOIA_HTF_VOL_SHRINK:
            continue
        # 突破旗形上沿收盘确认
        row = work.iloc[i]
        if float(row["close"]) < hi * 0.998:
            continue
        if not bool(row["is_bull"]):
            continue
        hits.append(
            _hit(
                strategy_id="high_tight_flag",
                bar_index=i,
                row=row,
                reason=(
                    f"前段涨幅{run_pct:.1f}%后旗形振幅{range_pct:.1f}%缩量"
                    f"（旗量/跑量={flag_vol/run_vol:.2f}）突破"
                ),
                extra={
                    "run_pct": run_pct,
                    "flag_range_pct": range_pct,
                    "flag_high": hi,
                    "vol_shrink": flag_vol / run_vol,
                },
            )
        )
    return hits


def detect_limit_up_shakeout(df: pd.DataFrame) -> list[dict[str, Any]]:
    lb = cfg.SEQUOIA_SHAKE_LOOKBACK
    work = add_basic_cols(df, vol_sma=20)
    if len(work) < lb + 5:
        return []
    hits: list[dict[str, Any]] = []
    for i in range(lb + 1, len(work)):
        row = work.iloc[i]
        if not bool(row["is_bear"]):
            continue
        # 找 lookback 内最近大阳
        up_idx = None
        up_pct = 0.0
        for j in range(i - 1, i - lb - 1, -1):
            r = work.iloc[j]
            if not bool(r["is_bull"]):
                continue
            base = float(r["open"])
            if base <= 0:
                continue
            pct = (float(r["close"]) - base) / base * 100.0
            if pct >= cfg.SEQUOIA_SHAKE_UP_PCT:
                up_idx = j
                up_pct = pct
                break
        if up_idx is None:
            continue
        up_close = float(work.iloc[up_idx]["close"])
        hold_tol = up_close * (1.0 - cfg.SEQUOIA_SHAKE_HOLD_TOL_PCT / 100.0)
        # 阴线回踩但收盘仍守大阳收盘附近
        if float(row["close"]) < hold_tol:
            continue
        if float(row["low"]) >= up_close:
            continue  # 没有真正回踩
        hits.append(
            _hit(
                strategy_id="limit_up_shakeout",
                bar_index=i,
                row=row,
                reason=f"大阳+{up_pct:.1f}%后阴线洗盘，收盘守前收{up_close:.6g}",
                extra={"up_bar_index": up_idx, "up_pct": up_pct, "hold_close": up_close},
            )
        )
    return hits


def detect_uptrend_limit_down(df: pd.DataFrame) -> list[dict[str, Any]]:
    tlb = cfg.SEQUOIA_ULD_TREND_LOOKBACK
    work = add_basic_cols(df, vol_sma=20)
    if len(work) < tlb + 5:
        return []
    work = work.copy()
    work["trend_pct"] = pct_change_lookback(work["close"], tlb)
    hits: list[dict[str, Any]] = []
    for i in range(tlb + 1, len(work)):
        row = work.iloc[i]
        trend = row.get("trend_pct")
        if trend is None or not np.isfinite(trend) or float(trend) < cfg.SEQUOIA_ULD_TREND_MIN_PCT:
            continue
        if not bool(row["is_bear"]):
            continue
        open_px = float(row["open"])
        if open_px <= 0:
            continue
        dump_pct = (open_px - float(row["close"])) / open_px * 100.0
        if dump_pct < cfg.SEQUOIA_ULD_DUMP_PCT:
            continue
        if not vol_ok(row, cfg.SEQUOIA_ULD_VOL_MULT):
            continue
        hits.append(
            _hit(
                strategy_id="uptrend_limit_down",
                bar_index=i,
                row=row,
                reason=(
                    f"前{tlb}根涨{float(trend):.1f}%中出现-{dump_pct:.1f}%放量阴"
                    f"（量≥{cfg.SEQUOIA_ULD_VOL_MULT}×MA20）"
                ),
                extra={
                    "trend_pct": float(trend),
                    "dump_pct": dump_pct,
                    "vol_ratio": float(row["volume"]) / float(row["vol_sma"]),
                },
            )
        )
    return hits


def detect_rps_breakout(
    df: pd.DataFrame,
    *,
    rps_percentile: float | None = None,
) -> list[dict[str, Any]]:
    """单币：近高点 +（可选）外部传入的宇宙 RPS 百分位。

    无宇宙百分位时，退化为「自身动量分位」：当前 lookback 涨幅相对自身历史滚动分位。
    """
    lb = cfg.SEQUOIA_RPS_LOOKBACK
    hlb = cfg.SEQUOIA_RPS_HIGH_LOOKBACK
    work = add_basic_cols(df, vol_sma=20)
    need = max(lb, hlb) + 5
    if len(work) < need:
        return []
    work = work.copy()
    work["mom"] = pct_change_lookback(work["close"], lb)
    work["hh"] = prior_high(work["high"], hlb)
    # 自身滚动分位（0-100）
    work["mom_pctile"] = work["mom"].rolling(hlb, min_periods=max(10, hlb // 3)).apply(
        lambda x: float(pd.Series(x).rank(pct=True).iloc[-1] * 100.0) if len(x) else np.nan,
        raw=False,
    )
    hits: list[dict[str, Any]] = []
    for i in range(need, len(work)):
        row = work.iloc[i]
        hh = row.get("hh")
        if hh is None or not np.isfinite(hh) or float(hh) <= 0:
            continue
        near = float(row["close"]) >= float(hh) * (1.0 - cfg.SEQUOIA_RPS_NEAR_HIGH_PCT / 100.0)
        if not near:
            continue
        if rps_percentile is not None:
            pctile = float(rps_percentile)
        else:
            mp = row.get("mom_pctile")
            if mp is None or not np.isfinite(mp):
                continue
            pctile = float(mp)
        if pctile < cfg.SEQUOIA_RPS_MIN_PERCENTILE:
            continue
        if not bool(row["is_bull"]) and float(row["close"]) < float(hh):
            continue
        hits.append(
            _hit(
                strategy_id="rps_breakout",
                bar_index=i,
                row=row,
                reason=f"RPS/动量分位{pctile:.0f} + 距{hlb}高≤{cfg.SEQUOIA_RPS_NEAR_HIGH_PCT}%",
                extra={"rps_percentile": pctile, "near_high": float(hh), "mom_pct": float(row["mom"]) if pd.notna(row["mom"]) else None},
            )
        )
    return hits


_DETECTORS: dict[str, Callable[..., list[dict[str, Any]]]] = {
    "turtle_trade": detect_turtle_trade,
    "ma_volume": detect_ma_volume,
    "high_tight_flag": detect_high_tight_flag,
    "limit_up_shakeout": detect_limit_up_shakeout,
    "uptrend_limit_down": detect_uptrend_limit_down,
    "rps_breakout": detect_rps_breakout,
}


def detect_all(
    df: pd.DataFrame,
    *,
    strategy_ids: tuple[str, ...] | list[str] | None = None,
    rps_percentile_by_bar: dict[int, float] | None = None,
) -> list[dict[str, Any]]:
    base = ensure_ohlcv(df)
    if base.empty:
        return []
    ids = resolve_strategy_ids(strategy_ids if strategy_ids is not None else cfg.SEQUOIA_STRATEGY_IDS)
    hits: list[dict[str, Any]] = []
    for sid in ids:
        fn = _DETECTORS.get(sid)
        if not fn:
            continue
        if sid == "rps_breakout" and rps_percentile_by_bar:
            # 逐 bar 不适用整表；仍用自有动量分位，宇宙分位由 scan 层注入
            part = detect_rps_breakout(base)
            for h in part:
                bi = int(h["bar_index"])
                if bi in rps_percentile_by_bar:
                    h["rps_percentile"] = float(rps_percentile_by_bar[bi])
                    h["reason"] = (
                        f"宇宙RPS分位{h['rps_percentile']:.0f} + 近高点"
                    )
            hits.extend(part)
        else:
            hits.extend(fn(base))
    hits.sort(key=lambda h: (int(h.get("bar_index") or 0), str(h.get("strategy_id") or "")))
    return hits


def detect_last_closed(
    df: pd.DataFrame,
    *,
    now_ms: int | None = None,
    strategy_ids: tuple[str, ...] | list[str] | None = None,
) -> list[dict[str, Any]]:
    """仅保留最近已收盘 K 上的命中。"""
    from oi_mornitor.strategy.candle_signals import closed_bar_index

    base = ensure_ohlcv(df)
    if base.empty:
        return []
    idx = closed_bar_index(base, now_ms=now_ms)
    if idx < 0:
        return []
    return [h for h in detect_all(base, strategy_ids=strategy_ids) if int(h.get("bar_index") or -1) == idx]
