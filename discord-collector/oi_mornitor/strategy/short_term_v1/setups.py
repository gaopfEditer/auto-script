"""五类机会识别：统一识别器，不同档位用不同流动性/风险参数。

1. liquidity_sweep_reclaim：刺破前高/前低后收回，再出现吸收、缩量或小周期结构转变。
   仅有扫单不是入场（复用严格流动性反转：sweep + reclaim + CHoCH/BOS）。
2. breakout_pullback：放量收盘突破（禁止仅影线），回踩不破，主动成交回到突破方向再进。
   复用趋势回调延续的收盘确认逻辑。
3. absorption：主动买盘增加但价格推不动（或相反）。必须等后续结构确认；单独吸收不作为反转。
   依赖 CVD；缺失则标记并跳过，不假装检出。
4. relative_strength：BTC 上涨时不急着做多落后币；BTC 回落时观察相对强势币。B 档尤其适用。
5. liquidation_exhaustion：清算潮后等待强制成交衰减并收回关键结构。清算打印本身不是反转。
   无清算历史则跳过并标记。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

import pandas as pd

from oi_mornitor.market_regime import (
    bos_by_close,
    choch_by_close,
    last_confirmed_swing,
    wick_only_break,
)
from oi_mornitor.strategy.liquidity_reversal import (
    SWEEP_PIERCE_MAX,
    SWEEP_PIERCE_MIN,
    _complete_reversal,
    _sweep_and_reclaim,
    is_tradable_liquidity_event,
)
from oi_mornitor.strategy.trend_continuation import (
    _directional_confirm,
    _vol_contraction,
)


SETUP_IDS = (
    "liquidity_sweep_reclaim",
    "breakout_pullback",
    "absorption",
    "relative_strength",
    "liquidation_exhaustion",
)

SETUP_LABELS = {
    "liquidity_sweep_reclaim": "扫流动性后反转",
    "breakout_pullback": "突破回踩延续",
    "absorption": "成交吸收",
    "relative_strength": "跨币种相对强弱",
    "liquidation_exhaustion": "清算潮后衰竭反转",
}


@dataclass
class SetupResult:
    setup: str
    accepted: bool
    direction: str | None = None  # long / short
    skip_reason: str | None = None
    evidence: list[str] = field(default_factory=list)
    data_flags: dict[str, Any] = field(default_factory=dict)
    sweep_extreme: float | None = None
    liquidity_level: float | None = None
    structure_level: float | None = None
    confirm_idx: int | None = None
    bar_index: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _reject(setup: str, reason: str, **kwargs: Any) -> SetupResult:
    return SetupResult(setup=setup, accepted=False, skip_reason=reason, **kwargs)


# ---------- 1. 扫流动性收回 ----------

def sweep_pierce_flags(df: pd.DataFrame, *, idx: int, side: str) -> dict[str, Any]:
    """区分：无扫单 / 仅扫单未收回 / 已收回。不把仅扫单当成入场。"""
    from oi_mornitor.market_regime import SWING_ORDER, confirmed_swings

    out = {"sweep": False, "reclaim": False, "pierce": False, "level": None, "extreme": None}
    if df is None or idx < SWING_ORDER * 2 + 2 or idx >= len(df):
        return out
    row = df.iloc[idx]
    high, low, close = float(row["high"]), float(row["low"]), float(row["close"])
    if side == "short":
        swings = confirmed_swings(df, end_idx=idx - 1, which="high", order=SWING_ORDER)
        if not swings:
            return out
        _pi, ph = swings[-1]
        if ph <= 0:
            return out
        out["level"] = ph
        if high > ph * (1 + SWEEP_PIERCE_MIN) and high <= ph * (1 + SWEEP_PIERCE_MAX):
            out["sweep"] = True
            out["pierce"] = True
            out["extreme"] = high
            if close < ph:
                out["reclaim"] = True
        return out
    swings = confirmed_swings(df, end_idx=idx - 1, which="low", order=SWING_ORDER)
    if not swings:
        return out
    _pi, pl = swings[-1]
    if pl <= 0:
        return out
    out["level"] = pl
    if low < pl * (1 - SWEEP_PIERCE_MIN) and low >= pl * (1 - SWEEP_PIERCE_MAX):
        out["sweep"] = True
        out["pierce"] = True
        out["extreme"] = low
        if close > pl:
            out["reclaim"] = True
    return out


def evaluate_liquidity_sweep_reclaim(
    df: pd.DataFrame,
    *,
    idx: int,
    side: str,
    require_choch: bool = True,
    max_wait: int = 6,
) -> SetupResult:
    setup = "liquidity_sweep_reclaim"
    flags = sweep_pierce_flags(df, idx=idx, side=side)
    evidence: list[str] = []
    if flags["sweep"] and not flags["reclaim"]:
        return _reject(
            setup,
            "sweep_without_reclaim",
            direction=side,
            evidence=["扫单未收回关键价位，不是入场"],
            data_flags=flags,
            sweep_extreme=flags.get("extreme"),
            liquidity_level=flags.get("level"),
            bar_index=idx,
        )
    swept = _sweep_and_reclaim(df, idx=idx, side=side)
    if not swept:
        return _reject(setup, "no_sweep_reclaim", direction=side, data_flags=flags, bar_index=idx)
    evidence.append("刺破后收盘收回关键价位")
    confirm = _complete_reversal(df, sweep_idx=idx, side=side, max_wait=max_wait) if require_choch else idx
    if require_choch and confirm is None:
        return _reject(
            setup,
            "no_choch_after_reclaim",
            direction=side,
            evidence=evidence + ["收回后未见 CHoCH/结构转变"],
            data_flags={**flags, "sweep": True, "reclaim": True, "choch": False},
            sweep_extreme=swept.get("sweepExtreme"),
            liquidity_level=swept.get("liquidityLevel"),
            bar_index=idx,
        )
    choch_ok = confirm is not None
    tradable = is_tradable_liquidity_event({"sweep": True, "reclaim": True, "choch": choch_ok})
    if not tradable:
        return _reject(setup, "incomplete_liquidity_event", direction=side, data_flags=flags)
    evidence.append("Sweep + Reclaim + CHoCH 完整")
    return SetupResult(
        setup=setup,
        accepted=True,
        direction=side,
        evidence=evidence,
        data_flags={"sweep": True, "reclaim": True, "choch": True},
        sweep_extreme=float(swept["sweepExtreme"]),
        liquidity_level=float(swept["liquidityLevel"]),
        structure_level=float(swept["sweepExtreme"]),
        confirm_idx=int(confirm) if confirm is not None else idx,
        bar_index=idx,
    )


# ---------- 2. 突破回踩 ----------

def evaluate_breakout_pullback(
    df: pd.DataFrame,
    *,
    idx: int,
    side: str,
    lookback: int = 12,
) -> SetupResult:
    """收盘确认突破；仅影线刺破拒绝。回踩后需方向性 K 线。"""
    setup = "breakout_pullback"
    if df is None or idx < lookback + 2 or idx >= len(df):
        return _reject(setup, "insufficient_bars", direction=side, bar_index=idx)

    bos_idx = None
    for k in range(idx, max(lookback, idx - lookback) - 1, -1):
        if bos_by_close(df, bar_idx=k, side=side):
            bos_idx = k
            break
    if bos_idx is None:
        # 可能是仅影线：检查最近一根是否 wick-only
        for k in range(idx, max(lookback, idx - lookback) - 1, -1):
            sw = last_confirmed_swing(df, end_idx=k - 1, which="high" if side == "long" else "low")
            if sw and wick_only_break(df, bar_idx=k, level=sw[1], side=side):
                return _reject(
                    setup,
                    "wick_only_breakout",
                    direction=side,
                    evidence=["仅影线刺破，缺少收盘确认"],
                    bar_index=k,
                    structure_level=sw[1],
                )
        return _reject(setup, "no_close_bos", direction=side, bar_index=idx)

    sw = last_confirmed_swing(df, end_idx=bos_idx - 1, which="high" if side == "long" else "low")
    if sw and wick_only_break(df, bar_idx=bos_idx, level=sw[1], side=side):
        return _reject(
            setup,
            "wick_only_breakout",
            direction=side,
            evidence=["仅影线刺破，拒绝入场"],
            bar_index=bos_idx,
            structure_level=sw[1],
        )
    level = sw[1] if sw else float(df.iloc[bos_idx]["close"])
    if bos_idx >= idx:
        return _reject(setup, "bos_without_pullback", direction=side, bar_index=idx)

    if side == "long":
        pb_low = float(df.iloc[bos_idx + 1 : idx + 1]["low"].min())
        struct = last_confirmed_swing(df, end_idx=idx, which="low")
        swing_low = struct[1] if struct else pb_low
        if struct and struct[0] < bos_idx and pb_low < swing_low:
            return _reject(setup, "pullback_broke_structure", direction=side, bar_index=idx, structure_level=swing_low)
        near = abs(pb_low - level) / max(level, 1e-12) <= 0.015 or pb_low <= level
        if not near:
            return _reject(setup, "pullback_not_near_break", direction=side, bar_index=idx)
        struct_lvl = pb_low
    else:
        pb_high = float(df.iloc[bos_idx + 1 : idx + 1]["high"].max())
        near = abs(pb_high - level) / max(level, 1e-12) <= 0.015 or pb_high >= level
        if not near:
            return _reject(setup, "pullback_not_near_break", direction=side, bar_index=idx)
        struct_lvl = pb_high

    if not _directional_confirm(df.iloc[idx], side):
        return _reject(setup, "no_directional_confirm", direction=side, bar_index=idx, structure_level=struct_lvl)

    vol_ok = _vol_contraction(df, bos_idx, idx)
    evidence = ["收盘确认突破", "回踩未破结构", "方向性 K 线确认"]
    if vol_ok:
        evidence.append("回踩缩量")
    return SetupResult(
        setup=setup,
        accepted=True,
        direction=side,
        evidence=evidence,
        data_flags={"close_bos": True, "wick_only": False, "pullback_volume": "contraction" if vol_ok else "expansion"},
        structure_level=float(struct_lvl),
        confirm_idx=idx,
        bar_index=idx,
    )


# ---------- 3. 吸收（依赖 CVD） ----------

def evaluate_absorption(
    df: pd.DataFrame,
    *,
    idx: int,
    cvd_col: str = "cvd",
    lookback: int = 6,
    require_structure: bool = True,
) -> SetupResult:
    setup = "absorption"
    if df is None or cvd_col not in df.columns:
        return _reject(
            setup,
            "cvd_missing",
            evidence=["CVD 序列缺失，跳过吸收形态，不假装检出"],
            data_flags={"cvd_missing": True},
            bar_index=idx,
        )
    if idx < lookback + 1 or idx >= len(df):
        return _reject(setup, "insufficient_bars", data_flags={"cvd_missing": False}, bar_index=idx)
    cvd = df[cvd_col].astype(float)
    price = df["close"].astype(float)
    cvd_chg = float(cvd.iloc[idx] - cvd.iloc[idx - lookback])
    price_chg = float(price.iloc[idx] - price.iloc[idx - lookback])
    atr_proxy = float((df["high"].iloc[idx - lookback : idx + 1] - df["low"].iloc[idx - lookback : idx + 1]).mean())
    stall = abs(price_chg) <= max(atr_proxy * 0.35, abs(price.iloc[idx]) * 0.002)
    if not stall or abs(cvd_chg) <= 0:
        return _reject(setup, "no_absorption", data_flags={"cvd_missing": False}, bar_index=idx)
    # 买盘增加价格推不动 → 卖方吸收，潜在做空；反之潜在做多。必须再等结构。
    direction = "short" if cvd_chg > 0 else "long"
    evidence = [
        f"CVD 变化 {cvd_chg:.4g} 而价格停滞（{price_chg:.4g}），疑似吸收",
    ]
    if require_structure:
        prior = "up" if direction == "short" else "down"
        confirmed = choch_by_close(df, bar_idx=idx, prior_trend=prior) or _directional_confirm(df.iloc[idx], direction)
        if not confirmed:
            return _reject(
                setup,
                "absorption_needs_structure_confirm",
                direction=direction,
                evidence=evidence + ["吸收本身不是入场，等待结构确认"],
                data_flags={"cvd_missing": False, "absorption": True, "structure_confirm": False},
                bar_index=idx,
            )
        evidence.append("后续结构确认")
    return SetupResult(
        setup=setup,
        accepted=True,
        direction=direction,
        evidence=evidence,
        data_flags={"cvd_missing": False, "absorption": True, "structure_confirm": True},
        confirm_idx=idx,
        bar_index=idx,
        structure_level=float(df.iloc[idx]["low"] if direction == "long" else df.iloc[idx]["high"]),
    )


# ---------- 4. 相对强弱 ----------

def relative_return(df: pd.DataFrame, *, idx: int, lookback: int = 12) -> float | None:
    if df is None or idx < lookback or idx >= len(df) or "close" not in df.columns:
        return None
    a = float(df.iloc[idx - lookback]["close"])
    b = float(df.iloc[idx]["close"])
    if a <= 0:
        return None
    return (b - a) / a


def evaluate_relative_strength(
    df_coin: pd.DataFrame,
    df_btc: pd.DataFrame | None,
    *,
    idx: int,
    lookback: int = 12,
    require_structure: bool = True,
    btc_idx: int | None = None,
) -> SetupResult:
    setup = "relative_strength"
    if df_btc is None or len(df_btc) == 0:
        return _reject(
            setup,
            "btc_series_missing",
            evidence=["缺少 BTC 序列，无法做相对强弱"],
            data_flags={"btc_missing": True},
            bar_index=idx,
        )
    bi = len(df_btc) - 1 if btc_idx is None else btc_idx
    coin_r = relative_return(df_coin, idx=idx, lookback=lookback)
    btc_r = relative_return(df_btc, idx=bi, lookback=min(lookback, bi))
    if coin_r is None or btc_r is None:
        return _reject(setup, "rs_returns_missing", data_flags={"btc_missing": False}, bar_index=idx)
    rel = coin_r - btc_r
    evidence = [f"BTC 收益 {btc_r:.2%}，币收益 {coin_r:.2%}，相对 {rel:.2%}"]
    # BTC 上涨时落后币不作为做多机会；BTC 回落时相对抗跌可作为观察多头，仍要结构确认。
    if btc_r > 0 and rel < -0.02:
        return _reject(
            setup,
            "laggard_no_long",
            direction="long",
            evidence=evidence + ["BTC 上涨时不急着做多落后币"],
            data_flags={"leader": False, "laggard": True},
            bar_index=idx,
        )
    if btc_r >= 0:
        return _reject(
            setup,
            "no_btc_dip",
            evidence=evidence + ["BTC 未回落，相对强弱不单独开多"],
            data_flags={"leader": rel >= 0, "laggard": rel < 0},
            bar_index=idx,
        )
    if rel < 0:
        return _reject(
            setup,
            "not_a_leader_on_btc_dip",
            evidence=evidence + ["BTC 回落但该币并未相对抗跌"],
            data_flags={"leader": False},
            bar_index=idx,
        )
    direction = "long"
    if require_structure and not _directional_confirm(df_coin.iloc[idx], direction):
        return _reject(
            setup,
            "rs_needs_structure_confirm",
            direction=direction,
            evidence=evidence + ["相对强势需结构/方向 K 确认"],
            data_flags={"leader": True},
            bar_index=idx,
        )
    return SetupResult(
        setup=setup,
        accepted=True,
        direction=direction,
        evidence=evidence + ["BTC 回落时相对抗跌，且有结构确认"],
        data_flags={"leader": True, "btc_dip": True},
        confirm_idx=idx,
        bar_index=idx,
        structure_level=float(df_coin.iloc[idx]["low"]),
    )


# ---------- 5. 清算衰竭 ----------

def evaluate_liquidation_exhaustion(
    df: pd.DataFrame,
    *,
    idx: int,
    liq_events: list[dict[str, Any]] | None,
    lookback_ms: int = 3 * 3600_000,
    ts_col: str = "open_time",
    min_cluster: int = 3,
) -> SetupResult:
    setup = "liquidation_exhaustion"
    if liq_events is None:
        return _reject(
            setup,
            "liquidation_history_missing",
            evidence=["清算历史缺失，跳过本形态，不把价格波动假装成清算潮"],
            data_flags={"liquidation_missing": True},
            bar_index=idx,
        )
    if df is None or idx >= len(df) or ts_col not in df.columns:
        return _reject(setup, "insufficient_bars", data_flags={"liquidation_missing": False}, bar_index=idx)
    t = int(df.iloc[idx][ts_col])
    if t < 1e12:
        t *= 1000
    cluster = []
    later = []
    for ev in liq_events:
        et = int(ev.get("ts") or ev.get("time") or ev.get("T") or 0)
        if et < 1e12:
            et *= 1000
        if t - lookback_ms <= et <= t:
            cluster.append(ev)
        elif t < et <= t + lookback_ms // 2:
            later.append(ev)
    if len(cluster) < min_cluster:
        return _reject(
            setup,
            "no_liquidation_cluster",
            evidence=["窗口内无足够清算聚集，清算打印本身不是反转"],
            data_flags={"liquidation_missing": False, "cluster": len(cluster)},
            bar_index=idx,
        )
    # 强制成交衰减：后续窗口清算少于聚集期的一半
    faded = len(later) <= max(len(cluster) // 2, 0)
    if not faded:
        return _reject(
            setup,
            "forced_flow_not_faded",
            evidence=["清算潮后强制成交尚未衰减"],
            data_flags={"liquidation_missing": False, "cluster": len(cluster), "later": len(later)},
            bar_index=idx,
        )
    # 需要收回结构：用扫单收回或 CHoCH 作为代理
    for side in ("long", "short"):
        sw = evaluate_liquidity_sweep_reclaim(df, idx=idx, side=side, require_choch=True)
        if sw.accepted:
            return SetupResult(
                setup=setup,
                accepted=True,
                direction=side,
                evidence=[f"清算聚集 {len(cluster)} 笔后衰减", "价格收回关键结构"] + sw.evidence,
                data_flags={"liquidation_missing": False, "cluster": len(cluster), "faded": True},
                structure_level=sw.structure_level,
                sweep_extreme=sw.sweep_extreme,
                confirm_idx=sw.confirm_idx,
                bar_index=idx,
            )
        if choch_by_close(df, bar_idx=idx, prior_trend="down" if side == "long" else "up"):
            return SetupResult(
                setup=setup,
                accepted=True,
                direction=side,
                evidence=[f"清算聚集 {len(cluster)} 笔后衰减", "出现结构 CHoCH"],
                data_flags={"liquidation_missing": False, "cluster": len(cluster), "faded": True, "choch": True},
                confirm_idx=idx,
                bar_index=idx,
                structure_level=float(df.iloc[idx]["low"] if side == "long" else df.iloc[idx]["high"]),
            )
    return _reject(
        setup,
        "liq_cluster_without_reclaim",
        evidence=["清算潮后未见结构收回，清算本身不是反转信号"],
        data_flags={"liquidation_missing": False, "cluster": len(cluster), "faded": faded},
        bar_index=idx,
    )


def setup_options() -> list[dict[str, str]]:
    return [{"id": i, "label": SETUP_LABELS[i]} for i in SETUP_IDS]
