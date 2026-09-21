"""量价延续/反转信号状态机。"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any

import numpy as np
import pandas as pd

from oi_mornitor.volume_price.classify import ClassifyThresholds, classify_bars, fit_classify_thresholds
from oi_mornitor.volume_price.features import add_volume_price_features

DEFAULT_SIGNAL_TFS = ("15m", "1h")
DEFAULT_FILTER_TFS = ("1h", "4h")
EMA_SPAN = 20
EMA_TANGLE_PCT = 0.003
TREND_STRETCH_PCT = 0.02


@dataclass
class VolumePriceSignal:
    ts: int
    symbol: str
    tf: str
    side: str
    kind: str
    entry_hint: float
    invalid_level: float
    reason: str
    score: float
    observation_only: bool
    bar_class: str
    signal_bar_index: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _ema(s: pd.Series, span: int = EMA_SPAN) -> pd.Series:
    return s.ewm(span=span, adjust=False).mean()


def _position_from_close(close: float, ema: float, *, tangle_pct: float = EMA_TANGLE_PCT) -> str:
    if not np.isfinite(close) or not np.isfinite(ema) or ema <= 0:
        return "tangled"
    band = ema * tangle_pct
    if close > ema + band:
        return "bull"
    if close < ema - band:
        return "bear"
    return "tangled"


def _add_htf_columns(df: pd.DataFrame, htf: pd.DataFrame, prefix: str) -> pd.DataFrame:
    """将高周期趋势列 asof 合并到低周期（仅用已收盘 HTF  bar）。"""
    if htf.empty:
        out = df.copy()
        out[f"{prefix}_position"] = "tangled"
        out[f"{prefix}_dir"] = 0
        out[f"{prefix}_trend_end"] = False
        out[f"{prefix}_ema"] = np.nan
        return out

    h = htf.sort_values("ts").copy()
    h[f"{prefix}_ema"] = _ema(h["close"])
    h[f"{prefix}_position"] = [
        _position_from_close(c, e) for c, e in zip(h["close"], h[f"{prefix}_ema"], strict=False)
    ]
    h[f"{prefix}_dir"] = h[f"{prefix}_position"].map({"bull": 1, "bear": -1, "tangled": 0}).astype(int)
    stretch = (h["close"] - h[f"{prefix}_ema"]).abs() / h[f"{prefix}_ema"].replace(0, np.nan)
    h[f"{prefix}_trend_end"] = stretch >= TREND_STRETCH_PCT

    merge_cols = ["ts", f"{prefix}_position", f"{prefix}_dir", f"{prefix}_trend_end", f"{prefix}_ema"]
    left = df.sort_values("ts").copy()
    merged = pd.merge_asof(
        left,
        h[merge_cols],
        on="ts",
        direction="backward",
    )
    return merged


def prepare_htf_context(
    df: pd.DataFrame,
    *,
    signal_tfs: tuple[str, ...] = DEFAULT_SIGNAL_TFS,
    filter_tfs: tuple[str, ...] = DEFAULT_FILTER_TFS,
) -> pd.DataFrame:
    """特征 + 高周期趋势过滤列。signal_tfs 生成信号；filter_tfs 仅做趋势。"""
    featured = add_volume_price_features(df)
    parts: list[pd.DataFrame] = []
    htf_by_sym: dict[str, dict[str, pd.DataFrame]] = {}

    for sym, sym_df in featured.groupby("symbol", sort=False):
        by_tf = {str(tf): chunk.copy() for tf, chunk in sym_df.groupby("tf", sort=False)}
        htf_by_sym[sym] = by_tf

    for sym, by_tf in htf_by_sym.items():
        h1 = by_tf.get("1h", pd.DataFrame())
        h4 = by_tf.get("4h", pd.DataFrame())

        for tf in signal_tfs:
            if tf not in by_tf:
                continue
            chunk = by_tf[tf].copy()
            chunk = _add_htf_columns(chunk, h1, "h1")
            if "4h" in filter_tfs and not h4.empty:
                chunk = _add_htf_columns(chunk, h4, "h4")
            chunk["h1_trend_end"] = chunk.get("h1_trend_end", False)
            chunk["h1_dir"] = chunk.get("h1_dir", 0)
            chunk["h1_position"] = chunk.get("h1_position", "tangled")
            parts.append(chunk)

    if not parts:
        return featured
    return pd.concat(parts, ignore_index=True).sort_values(["symbol", "tf", "ts"]).reset_index(drop=True)


def _score_signal(base: float, vol_z: float) -> tuple[float, bool]:
    score = base
    observation = False
    if pd.notna(vol_z) and float(vol_z) < 0:
        score *= 0.5
        observation = True
    return min(1.0, max(0.0, score)), observation


def generate_signals(
    df: pd.DataFrame,
    *,
    thresholds: ClassifyThresholds | None = None,
    train_df: pd.DataFrame | None = None,
    signal_tfs: tuple[str, ...] = DEFAULT_SIGNAL_TFS,
) -> tuple[list[VolumePriceSignal], pd.DataFrame]:
    """生成量价信号；返回 (signals, 带 bar_class 的 enriched DataFrame)。"""
    ctx = prepare_htf_context(df, signal_tfs=signal_tfs)
    fit_src = train_df if train_df is not None else ctx
    th = thresholds or fit_classify_thresholds(fit_src)
    enriched = classify_bars(ctx, th, trend_end_col="h1_trend_end", h1_dir_col="h1_dir")

    signals: list[VolumePriceSignal] = []
    for (sym, tf), chunk in enriched.groupby(["symbol", "tf"], sort=False):
        rows = chunk.reset_index(drop=True)
        pending_rev_long: dict[str, Any] | None = None
        pending_rev_short: dict[str, Any] | None = None

        for i in range(len(rows)):
            row = rows.iloc[i]
            if pd.isna(row.get("vol_z")):
                continue

            bar_class = str(row.get("bar_class") or "other")
            pos = str(row.get("h1_position") or "tangled")
            h1_dir = int(row.get("h1_dir") or 0)
            body = float(row.get("body") or 0)
            vol_z = float(row.get("vol_z") or 0)
            high = float(row["high"])
            low = float(row["low"])
            close = float(row["close"])
            ts = int(row["ts"])

            # —— 延续 ——
            if pos == "bull" and bar_class in ("thrust", "confirm") and body > 0:
                score, obs = _score_signal(0.75 if bar_class == "thrust" else 0.85, vol_z)
                signals.append(
                    VolumePriceSignal(
                        ts=ts,
                        symbol=str(sym),
                        tf=str(tf),
                        side="long",
                        kind="continuation",
                        entry_hint=close,
                        invalid_level=low,
                        reason=f"1h偏多 + {bar_class} 向上",
                        score=score,
                        observation_only=obs,
                        bar_class=bar_class,
                        signal_bar_index=i,
                    )
                )
            elif pos == "bear" and bar_class in ("thrust", "confirm") and body < 0:
                score, obs = _score_signal(0.75 if bar_class == "thrust" else 0.85, vol_z)
                signals.append(
                    VolumePriceSignal(
                        ts=ts,
                        symbol=str(sym),
                        tf=str(tf),
                        side="short",
                        kind="continuation",
                        entry_hint=close,
                        invalid_level=high,
                        reason=f"1h偏空 + {bar_class} 向下",
                        score=score,
                        observation_only=obs,
                        bar_class=bar_class,
                        signal_bar_index=i,
                    )
                )

            # —— 反转 setup ——
            if bar_class in ("climax", "effort_no_result") and body < 0:
                pending_rev_long = {
                    "zone_high": high,
                    "zone_low": low,
                    "setup_vol": float(row["volume"]),
                    "setup_vol_z": vol_z,
                    "setup_index": i,
                    "setup_class": bar_class,
                }
                pending_rev_short = None
            elif bar_class in ("climax", "effort_no_result") and body > 0:
                pending_rev_short = {
                    "zone_high": high,
                    "zone_low": low,
                    "setup_vol": float(row["volume"]),
                    "setup_vol_z": vol_z,
                    "setup_index": i,
                    "setup_class": bar_class,
                }
                pending_rev_long = None

            # —— 反转 confirm ——
            if pending_rev_long and i > int(pending_rev_long["setup_index"]):
                setup = pending_rev_long
                vol_fail = float(row["volume"]) > float(setup["setup_vol"]) * 1.02
                if close > float(setup["zone_high"]) and not vol_fail:
                    score, obs = _score_signal(0.8, vol_z)
                    signals.append(
                        VolumePriceSignal(
                            ts=ts,
                            symbol=str(sym),
                            tf=str(tf),
                            side="long",
                            kind="reversal",
                            entry_hint=close,
                            invalid_level=float(setup["zone_low"]),
                            reason=f"反转多：{setup['setup_class']} 后站上区高",
                            score=score,
                            observation_only=obs,
                            bar_class=bar_class,
                            signal_bar_index=i,
                        )
                    )
                    pending_rev_long = None
                elif vol_fail:
                    pending_rev_long = None

            if pending_rev_short and i > int(pending_rev_short["setup_index"]):
                setup = pending_rev_short
                vol_fail = float(row["volume"]) > float(setup["setup_vol"]) * 1.02
                if close < float(setup["zone_low"]) and not vol_fail:
                    score, obs = _score_signal(0.8, vol_z)
                    signals.append(
                        VolumePriceSignal(
                            ts=ts,
                            symbol=str(sym),
                            tf=str(tf),
                            side="short",
                            kind="reversal",
                            entry_hint=close,
                            invalid_level=float(setup["zone_high"]),
                            reason=f"反转空：{setup['setup_class']} 后跌破区低",
                            score=score,
                            observation_only=obs,
                            bar_class=bar_class,
                            signal_bar_index=i,
                        )
                    )
                    pending_rev_short = None
                elif vol_fail:
                    pending_rev_short = None

    return signals, enriched
