"""Sequoia 信号过滤：HTF 确认 / 冷却 / 缩量剔除（filtered · leaders_htf 档案）。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Sequence

import numpy as np
import pandas as pd

from oi_mornitor.strategy_sequoia.indicators import add_basic_cols, sma


@dataclass(frozen=True)
class FilterProfile:
    """回测过滤档案；baseline 等价于全部关闭。"""

    name: str
    universe: str  # majors | leaders
    universe_label: str
    leverage: float
    sl_pct: float
    hold_bars: int
    htf_confirm: bool
    htf_interval: str
    htf_rule: str  # close_above_smaN
    htf_ma: int
    cooldown_hours: float
    volume_min_ratio: float  # 0=关闭；>=1.0 表示量须 ≥ ratio×vol_sma
    volume_sma: int
    out_subdir: str


BASELINE_PROFILE = FilterProfile(
    name="baseline",
    universe="majors",
    universe_label="majors_28",
    leverage=20.0,
    sl_pct=5.0,
    hold_bars=5,
    htf_confirm=False,
    htf_interval="4h",
    htf_rule="close_above_sma20",
    htf_ma=20,
    cooldown_hours=0.0,
    volume_min_ratio=0.0,
    volume_sma=20,
    out_subdir="crypto",
)

FILTERED_PROFILE = FilterProfile(
    name="filtered",
    universe="leaders",
    universe_label="leaders_BTC_ETH",
    leverage=5.0,
    sl_pct=5.0,
    hold_bars=5,
    htf_confirm=True,
    htf_interval="4h",
    htf_rule="close_above_sma20",
    htf_ma=20,
    cooldown_hours=12.0,
    volume_min_ratio=1.0,  # 缩量：volume < 1.0×vol_sma20 → 丢弃
    volume_sma=20,
    out_subdir="crypto_filtered",
)

# CLI 别名
_PROFILE_ALIASES: dict[str, str] = {
    "baseline": "baseline",
    "default": "baseline",
    "filtered": "filtered",
    "leaders_htf": "filtered",
    "leaders-htf": "filtered",
    "crypto_filtered": "filtered",
}


def normalize_profile_name(raw: str | None) -> str:
    key = str(raw or "baseline").strip().lower()
    return _PROFILE_ALIASES.get(key, key if key in ("baseline", "filtered") else "baseline")


def resolve_filter_profile(raw: str | None) -> FilterProfile:
    name = normalize_profile_name(raw)
    if name == "filtered":
        return FILTERED_PROFILE
    return BASELINE_PROFILE


def build_htf_trend_ok(
    df_htf: pd.DataFrame,
    *,
    ma: int = 20,
) -> pd.DataFrame:
    """
    4h（或其它 HTF）趋势表：每根已收盘 K 标记 close > SMA(ma)。

    规则文档口径：htf_rule=close_above_sma20 → 仅当最近已收盘 HTF 收盘价高于其 SMA(ma) 时放行 1h 多头。
    """
    if df_htf is None or df_htf.empty:
        return pd.DataFrame(columns=["open_time", "close_time", "htf_close", "htf_ma", "htf_ok"])
    work = df_htf.reset_index(drop=True).copy()
    work["open_time"] = work["open_time"].astype("int64")
    if "close_time" in work.columns:
        work["close_time"] = work["close_time"].astype("int64")
    else:
        # 粗估：下一根 open_time - 1
        nxt = work["open_time"].shift(-1)
        work["close_time"] = (nxt - 1).fillna(work["open_time"] + 4 * 3600_000 - 1).astype("int64")
    work["htf_close"] = work["close"].astype(float)
    work["htf_ma"] = sma(work["htf_close"], ma)
    work["htf_ok"] = (work["htf_close"] > work["htf_ma"]) & work["htf_ma"].notna()
    return work[["open_time", "close_time", "htf_close", "htf_ma", "htf_ok"]]


def htf_ok_at_signal_ms(htf_trend: pd.DataFrame, signal_close_ms: int) -> bool:
    """取 signal 时刻之前（含）最近一根已收盘 HTF 的 htf_ok。"""
    if htf_trend is None or htf_trend.empty or not signal_close_ms:
        return False
    closed = htf_trend[htf_trend["close_time"] <= int(signal_close_ms)]
    if closed.empty:
        return False
    return bool(closed.iloc[-1]["htf_ok"])


def volume_ok_at_bar(
    df_1h: pd.DataFrame,
    bar_index: int,
    *,
    min_ratio: float,
    vol_sma: int = 20,
) -> bool:
    """min_ratio<=0 关闭；否则要求该 bar volume >= min_ratio × vol_sma。"""
    if min_ratio is None or float(min_ratio) <= 0:
        return True
    if df_1h is None or df_1h.empty or bar_index < 0 or bar_index >= len(df_1h):
        return False
    work = add_basic_cols(df_1h, vol_sma=vol_sma)
    row = work.iloc[bar_index]
    ma = row.get("vol_sma")
    if ma is None or not np.isfinite(float(ma)) or float(ma) <= 0:
        return False
    return float(row["volume"]) >= float(min_ratio) * float(ma)


def _signal_ms_from_hit(hit: dict[str, Any], df_1h: pd.DataFrame) -> int:
    bi = int(hit.get("bar_index") or -1)
    ms = int(hit.get("close_time") or 0)
    if ms and ms < 1e12:
        ms *= 1000
    if ms:
        return ms
    if 0 <= bi < len(df_1h):
        row = df_1h.iloc[bi]
        if "close_time" in df_1h.columns and pd.notna(row.get("close_time")):
            v = int(row["close_time"])
            return v * 1000 if v < 1e12 else v
        if bi + 1 < len(df_1h):
            v = int(df_1h.iloc[bi + 1]["open_time"])
            return v
        v = int(row["open_time"])
        return v
    return 0


def apply_signal_filters(
    hits: Sequence[dict[str, Any]],
    df_1h: pd.DataFrame,
    *,
    profile: FilterProfile,
    htf_trend: pd.DataFrame | None = None,
    symbol: str = "",
) -> list[dict[str, Any]]:
    """
    按档案过滤命中（保序）：
    1) 缩量剔除（volume < min_ratio×vol_sma）
    2) HTF 确认（仅 long；htf close > SMA）
    3) 同币同向冷却（cooldown_hours）
    """
    if profile is None or profile.name == "baseline":
        return list(hits)
    if not hits:
        return []

    out: list[dict[str, Any]] = []
    # side → last accepted signal_ms
    last_by_side: dict[str, int] = {}
    cooldown_ms = int(float(profile.cooldown_hours) * 3600_000) if profile.cooldown_hours else 0

    for h in hits:
        bi = int(h.get("bar_index") or -1)
        side = str(h.get("side") or "long").lower()
        if side in ("bull",):
            side = "long"
        if side in ("bear",):
            side = "short"

        if not volume_ok_at_bar(
            df_1h,
            bi,
            min_ratio=profile.volume_min_ratio,
            vol_sma=profile.volume_sma,
        ):
            continue

        sig_ms = _signal_ms_from_hit(h, df_1h)
        if profile.htf_confirm and side == "long":
            if htf_trend is None or htf_trend.empty:
                continue
            if not htf_ok_at_signal_ms(htf_trend, sig_ms):
                continue

        if cooldown_ms > 0 and sig_ms:
            prev = last_by_side.get(side)
            if prev is not None and sig_ms - prev < cooldown_ms:
                continue
            last_by_side[side] = sig_ms

        enriched = dict(h)
        enriched["filter_profile"] = profile.name
        enriched["universe_label"] = profile.universe_label
        out.append(enriched)
    return out


def profile_params_dict(profile: FilterProfile) -> dict[str, Any]:
    return {
        "profile": profile.name,
        "universe": profile.universe,
        "universe_label": profile.universe_label,
        "leverage": profile.leverage,
        "sl_pct": profile.sl_pct,
        "hold_bars": profile.hold_bars,
        "htf_confirm": profile.htf_confirm,
        "htf_interval": profile.htf_interval,
        "htf_rule": profile.htf_rule,
        "htf_ma": profile.htf_ma,
        "cooldown_hours": profile.cooldown_hours,
        "volume_min_ratio": profile.volume_min_ratio,
        "volume_sma": profile.volume_sma,
        "out_subdir": profile.out_subdir,
        "htf_rule_doc": (
            f"{profile.htf_interval} 已收盘 close > SMA({profile.htf_ma}) 才放行 1h 多头；"
            f"入场仍为信号下一根 1h open；冷却同币同向 {profile.cooldown_hours:g}h；"
            f"量能 volume≥{profile.volume_min_ratio:g}×vol_sma{profile.volume_sma} 否则视为缩量丢弃。"
            if profile.htf_confirm or profile.volume_min_ratio > 0 or profile.cooldown_hours > 0
            else "无额外过滤（baseline）"
        ),
    }


__all__ = [
    "BASELINE_PROFILE",
    "FILTERED_PROFILE",
    "FilterProfile",
    "apply_signal_filters",
    "build_htf_trend_ok",
    "htf_ok_at_signal_ms",
    "normalize_profile_name",
    "profile_params_dict",
    "resolve_filter_profile",
    "volume_ok_at_bar",
]
