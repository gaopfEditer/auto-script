"""威科夫量价：匹配、放量滞涨/不跌、价新高量萎缩。阈值可配置。"""
from __future__ import annotations

import os
from typing import Any

import pandas as pd

from oi_mornitor.strategy.features import add_core_features, confirmed_swings, mark_causal_swings
from oi_mornitor.strategy.params import SWING_LEFT, SWING_RIGHT

RVOL_MATCH = float(os.getenv("OI_VP_MATCH_RVOL", "1.5"))
SPREAD_MATCH = float(os.getenv("OI_VP_MATCH_SPREAD", "1.0"))
CPOS_MATCH = float(os.getenv("OI_VP_MATCH_CPOS", "0.7"))
RVOL_PULLBACK = float(os.getenv("OI_VP_PULLBACK_RVOL", "0.8"))
RVOL_DIV = float(os.getenv("OI_VP_DIV_RVOL", "2.0"))
EXHAUST_VOL_RATIO = float(os.getenv("OI_VP_EXHAUST_VOL_RATIO", "0.7"))


def _bar_meta(df: pd.DataFrame, i: int) -> dict[str, Any]:
    row = df.iloc[i]
    open_ts = int(row["open_time"]) if "open_time" in df.columns else int(row.get("ts") or 0)
    close_ts = int(row["close_time"]) if "close_time" in df.columns else open_ts
    return {
        "bar_index": i,
        "bar_open_ts": open_ts,
        "bar_close_ts": close_ts,
        "price_close": float(row["close"]),
        "strength": 0.5,
    }


def detect_wyckoff_events(df: pd.DataFrame) -> list[dict[str, Any]]:
    if df is None or len(df) < 40:
        return []
    work = add_core_features(df) if "rvol" not in df.columns else df
    work = mark_causal_swings(work)
    n = len(work)
    out: list[dict[str, Any]] = []
    last_match_long = -999
    last_match_short = -999

    for i in range(21, n):
        row = work.iloc[i]
        rvol = float(row["rvol"]) if pd.notna(row.get("rvol")) else None
        spread = float(row["spread"]) if pd.notna(row.get("spread")) else None
        cpos = float(row["cpos"]) if pd.notna(row.get("cpos")) else 0.5
        close = float(row["close"])
        ema33 = float(row["ema33"]) if pd.notna(row.get("ema33")) else close
        hh20 = float(work.iloc[i - 20 : i]["high"].max())
        ll20 = float(work.iloc[i - 20 : i]["low"].min())
        if rvol is None or spread is None:
            continue

        if (
            close > float(row["open"])
            and rvol >= RVOL_MATCH
            and spread >= SPREAD_MATCH
            and cpos >= CPOS_MATCH
            and (close > ema33 or close > hh20)
        ):
            ev = {
                "family": "wyckoff",
                "kind": "vp_match_long",
                "side": "long",
                **_bar_meta(work, i),
                "strength": min(1.0, max(0.0, (rvol - 1.0) / 2.0) * cpos),
            }
            out.append(ev)
            last_match_long = i
        if (
            close < float(row["open"])
            and rvol >= RVOL_MATCH
            and spread >= SPREAD_MATCH
            and cpos <= (1.0 - CPOS_MATCH)
            and (close < ema33 or close < ll20)
        ):
            ev = {
                "family": "wyckoff",
                "kind": "vp_match_short",
                "side": "short",
                **_bar_meta(work, i),
                "strength": min(1.0, max(0.0, (rvol - 1.0) / 2.0) * (1.0 - cpos)),
            }
            out.append(ev)
            last_match_short = i

        # 缩量回踩：匹配后 10 根内，下一根收阳确认
        if 0 < i - last_match_long <= 10 and i >= 1:
            prev = work.iloc[i - 1]
            prev_rvol = float(prev["rvol"]) if pd.notna(prev.get("rvol")) else 99
            prev_spread = float(prev["spread"]) if pd.notna(prev.get("spread")) else 99
            ema13 = float(prev["ema13"]) if pd.notna(prev.get("ema13")) else 0
            ema33p = float(prev["ema33"]) if pd.notna(prev.get("ema33")) else 0
            lo = float(prev["low"])
            in_ma = ema33p >= lo and lo <= max(ema13, ema33p)
            if (
                prev_rvol <= RVOL_PULLBACK
                and prev_spread <= 0.8
                and in_ma
                and close > float(row["open"])
            ):
                out.append(
                    {
                        "family": "wyckoff",
                        "kind": "vp_pullback_long",
                        "side": "long",
                        **_bar_meta(work, i),
                        "strength": 0.6,
                    }
                )
                last_match_long = -999
        if 0 < i - last_match_short <= 10 and i >= 1:
            prev = work.iloc[i - 1]
            prev_rvol = float(prev["rvol"]) if pd.notna(prev.get("rvol")) else 99
            prev_spread = float(prev["spread"]) if pd.notna(prev.get("spread")) else 99
            ema13 = float(prev["ema13"]) if pd.notna(prev.get("ema13")) else 0
            ema33p = float(prev["ema33"]) if pd.notna(prev.get("ema33")) else 0
            hi = float(prev["high"])
            in_ma = min(ema13, ema33p) <= hi <= max(ema13, ema33p)
            if (
                prev_rvol <= RVOL_PULLBACK
                and prev_spread <= 0.8
                and in_ma
                and close < float(row["open"])
            ):
                out.append(
                    {
                        "family": "wyckoff",
                        "kind": "vp_pullback_short",
                        "side": "short",
                        **_bar_meta(work, i),
                        "strength": 0.6,
                    }
                )
                last_match_short = -999

        # 放量滞涨 / 放量不跌：下一根确认
        if i >= 1:
            prev = work.iloc[i - 1]
            prev_rvol = float(prev["rvol"]) if pd.notna(prev.get("rvol")) else 0
            prev_spread = float(prev["spread"]) if pd.notna(prev.get("spread")) else 99
            prev_cpos = float(prev["cpos"]) if pd.notna(prev.get("cpos")) else 0.5
            prev_hh = float(work.iloc[max(0, i - 21) : i - 1]["high"].max()) if i > 21 else float(prev["high"])
            prev_ll = float(work.iloc[max(0, i - 21) : i - 1]["low"].min()) if i > 21 else float(prev["low"])
            if (
                float(prev["high"]) >= 0.995 * prev_hh
                and prev_rvol >= RVOL_DIV
                and (prev_spread <= 0.7 or prev_cpos <= 0.45)
                and float(row["high"]) <= float(prev["high"])
            ):
                out.append(
                    {
                        "family": "wyckoff",
                        "kind": "vp_div_top",
                        "side": "short",
                        **_bar_meta(work, i),
                        "strength": min(1.0, prev_rvol / 3.0),
                    }
                )
            if (
                float(prev["low"]) <= 1.005 * prev_ll
                and prev_rvol >= RVOL_DIV
                and prev_cpos >= 0.55
                and float(row["low"]) >= float(prev["low"])
            ):
                out.append(
                    {
                        "family": "wyckoff",
                        "kind": "vp_div_bottom",
                        "side": "long",
                        **_bar_meta(work, i),
                        "strength": min(1.0, prev_rvol / 3.0),
                    }
                )

    # 价新高量萎缩：两个已确认摆动高
    highs = confirmed_swings(work, n - 1, which="high")
    for a in range(len(highs) - 1):
        i1, p1 = highs[a]
        i2, p2 = highs[a + 1]
        if p2 <= p1 or i2 - i1 < 3:
            continue
        vol1 = float(work.iloc[max(0, i1 - 3) : i1 + 4]["volume"].mean())
        vol2 = float(work.iloc[max(0, i2 - 3) : i2 + 4]["volume"].mean())
        confirm = i2 + SWING_RIGHT
        if confirm >= n or vol1 <= 0:
            continue
        if vol2 < EXHAUST_VOL_RATIO * vol1:
            out.append(
                {
                    "family": "wyckoff",
                    "kind": "vp_exhaust_top",
                    "side": "short",
                    **_bar_meta(work, confirm),
                    "strength": 0.7,
                    "p1_ts": int(work.iloc[i1].get("open_time") or 0),
                    "p2_ts": int(work.iloc[i2].get("open_time") or 0),
                }
            )
    lows = confirmed_swings(work, n - 1, which="low")
    for a in range(len(lows) - 1):
        i1, p1 = lows[a]
        i2, p2 = lows[a + 1]
        if p2 >= p1 or i2 - i1 < 3:
            continue
        vol1 = float(work.iloc[max(0, i1 - 3) : i1 + 4]["volume"].mean())
        vol2 = float(work.iloc[max(0, i2 - 3) : i2 + 4]["volume"].mean())
        confirm = i2 + SWING_RIGHT
        if confirm >= n or vol1 <= 0:
            continue
        if vol2 < EXHAUST_VOL_RATIO * vol1:
            out.append(
                {
                    "family": "wyckoff",
                    "kind": "vp_exhaust_bottom",
                    "side": "long",
                    **_bar_meta(work, confirm),
                    "strength": 0.7,
                    "p1_ts": int(work.iloc[i1].get("open_time") or 0),
                    "p2_ts": int(work.iloc[i2].get("open_time") or 0),
                }
            )
    return out
