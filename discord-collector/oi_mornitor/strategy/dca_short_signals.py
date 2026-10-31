"""短线 DCA 信号端口：TD9 + 维加斯 near_v + 射击之星/倒锤子 + NLV。

对齐 docs/strategies/aicoin-dca-td9-vegas-nlv.pine；复用：
- td_sequential.td_setup_series
- range_extreme_volume.range_extreme_signal_series
- strategy.indicators.enrich_strategy_indicators / detect_*
- strategy.candle_signals.near_vegas_channel / at_lower_band / SHOOT_REPEAT_BARS
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

import pandas as pd

from oi_mornitor.range_extreme_volume import (
    LOOKBACK,
    MA_VOL,
    ohlcv_from_df,
    range_extreme_signal_series,
)
from oi_mornitor.strategy.candle_signals import (
    SHOOT_REPEAT_BARS,
    at_lower_band,
    near_vegas_channel,
)
from oi_mornitor.strategy.indicators import (
    detect_inverted_hammer,
    detect_shooting_star,
    enrich_strategy_indicators,
)
from oi_mornitor.td_sequential import td_setup_series


EPS = 1e-7


@dataclass
class DcaBarSignals:
    """单根已收盘柱上的模块信号快照。"""

    td: int = 0
    td_os: bool = False  # -9
    td_ob: bool = False  # +9
    near_v: bool = False
    shoot: bool = False
    ss2: bool = False
    inv_s: bool = False
    nlv: int = 0  # +1 buy / -1 sell
    label: str = ""
    score: int = 0


def enrich_dca_frame(df: pd.DataFrame) -> pd.DataFrame:
    """写入 BB / Vegas EMA（与 Pine 参数一致）。"""
    if df is None or df.empty:
        return pd.DataFrame()
    need = {"open", "high", "low", "close", "volume"}
    if not need.issubset(set(df.columns)):
        return pd.DataFrame()
    return enrich_strategy_indicators(df)


def compute_dca_signal_frame(df: pd.DataFrame) -> pd.DataFrame:
    """返回与 df 等长的信号列 DataFrame（closed-bar 语义由调用方保证）。"""
    base = enrich_dca_frame(df)
    n = len(base)
    out = pd.DataFrame(index=base.index)
    if n == 0:
        return out

    closes = [float(x) for x in base["close"].tolist()]
    td = td_setup_series(closes)
    o, h, l, c, v = ohlcv_from_df(base)
    nlv = range_extreme_signal_series(h, l, o, c, v)

    near_v = [False] * n
    shoot = [False] * n
    ss2 = [False] * n
    inv_s = [False] * n
    labels = [""] * n
    scores = [0] * n
    last_ss = -10_000

    for i in range(n):
        row = base.iloc[i]
        # Vegas / BB 暖机不足时 near_v 为 False
        try:
            nv = bool(near_vegas_channel(row))
        except Exception:  # noqa: BLE001
            nv = False
        near_v[i] = nv

        try:
            at_lo = bool(at_lower_band(row))
        except Exception:  # noqa: BLE001
            at_lo = False
        try:
            below_mid = float(row["low"]) <= float(row["bb_basis"]) if pd.notna(row.get("bb_basis")) else False
        except Exception:  # noqa: BLE001
            below_mid = False

        sh = False
        try:
            sh = bool(detect_shooting_star(row, at_lower=at_lo))
        except Exception:  # noqa: BLE001
            sh = False
        shoot[i] = sh
        if sh:
            ss2[i] = last_ss >= 0 and 0 < (i - last_ss) <= SHOOT_REPEAT_BARS
            last_ss = i
        else:
            ss2[i] = False

        ih = False
        if below_mid and not sh:
            try:
                ih = bool(detect_inverted_hammer(row))
            except Exception:  # noqa: BLE001
                ih = False
        inv_s[i] = ih

        # 标签 + 简易共振分（Mode C）
        parts: list[str] = []
        sc = 0
        tdv = int(td[i]) if i < len(td) else 0
        if tdv == -9:
            parts.append("TD9买")
            sc += 2
        elif tdv == 9:
            parts.append("TD9卖")
            sc += 2
        if sh:
            name = ("V射2" if nv and ss2[i] else "V射" if nv else "射2" if ss2[i] else "射")
            parts.append(name)
            sc += 2 if nv else 1
            if ss2[i]:
                sc += 1
        if ih and not sh:
            parts.append("V倒锤" if nv else "倒锤")
            sc += 2 if nv else 1
        nlv_i = int(nlv[i]) if i < len(nlv) else 0
        if nlv_i == 1:
            parts.append("NLV买")
            sc += 2
        elif nlv_i == -1:
            parts.append("NLV卖")
            sc += 2
        labels[i] = "+".join(parts)
        scores[i] = sc

    out["td"] = td
    out["td_os"] = [int(x) == -9 for x in td]
    out["td_ob"] = [int(x) == 9 for x in td]
    out["near_v"] = near_v
    out["shoot"] = shoot
    out["ss2"] = ss2
    out["inv_s"] = inv_s
    out["nlv"] = nlv
    out["label"] = labels
    out["score"] = scores
    # 便于 settle 取 pin
    out["high"] = base["high"].astype(float).tolist()
    out["low"] = base["low"].astype(float).tolist()
    out["open"] = base["open"].astype(float).tolist()
    out["close"] = base["close"].astype(float).tolist()
    return out


def min_warmup_bars(*, mode: str = "nlv_flip") -> int:
    """Mode A≈NLV 暖机；含 Vegas 形态时需 ≥676。"""
    m = (mode or "").strip().lower()
    if m in ("confluence", "mode_c", "c", "vegas", "candles"):
        return max(MA_VOL + LOOKBACK + 2, 680)
    if m in ("td9", "td9_long", "mode_b", "b"):
        return 40
    # nlv_flip / mode_a
    return max(MA_VOL + LOOKBACK + 2, 130)


def bar_snapshot(sig_df: pd.DataFrame, i: int) -> DcaBarSignals:
    if sig_df is None or sig_df.empty or i < 0 or i >= len(sig_df):
        return DcaBarSignals()
    row = sig_df.iloc[i]
    td = int(row.get("td") or 0)
    nlv = int(row.get("nlv") or 0)
    return DcaBarSignals(
        td=td,
        td_os=bool(row.get("td_os")),
        td_ob=bool(row.get("td_ob")),
        near_v=bool(row.get("near_v")),
        shoot=bool(row.get("shoot")),
        ss2=bool(row.get("ss2")),
        inv_s=bool(row.get("inv_s")),
        nlv=nlv,
        label=str(row.get("label") or ""),
        score=int(row.get("score") or 0),
    )


__all__ = [
    "DcaBarSignals",
    "EPS",
    "bar_snapshot",
    "compute_dca_signal_frame",
    "enrich_dca_frame",
    "min_warmup_bars",
]
