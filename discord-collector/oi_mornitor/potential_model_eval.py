"""潜力五模型评估（spec v0.2）。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from oi_mornitor.potential_features import (
    SymbolFeed,
    atr_pctile,
    btc_regime,
    coin_btc_ema_bull,
    detect_btc_turn,
    ema,
    equal_levels,
    fund_mean,
    fund_neg_streak,
    fund_pctile,
    new_low,
    oi_accel,
    oi_chg_pct,
    oi_quiet_ratio,
    range_width,
    recent_volume_spike_offset,
    ret_pct,
    volume_quiet_ratio_pre_spike,
    volume_sustain_after_spike,
    swing_points,
    vol_z,
    volume_ratio,
    vs_btc,
    wilder_atr,
)
from oi_mornitor.potential_models_config import load_potential_config

MODEL_LABELS: dict[str, str] = {
    "quiet_oi_breakout": "量沉寂 → 放量突破 → 延续",
    "short_squeeze": "OI 抗跌突破（费率仅参考）",
    "relative_strength": "强弱背离 · 首冲",
    "wyckoff_spring": "威科夫 Spring",
    "liquidity_sweep": "流动性打靶 (SFP)",
}

END_SIGNALS: dict[str, list[str]] = {
    "quiet_oi_breakout": [
        "OI 日降且价格滞涨",
        "量价背离（价创新高量缩）",
        "脉冲回撤过半",
    ],
    "short_squeeze": [
        "费率收至 0 附近且 OI 日降",
        "轧空后 OI 断崖",
        "现货转入交易所增",
    ],
    "relative_strength": [
        "BTC 涨时本币滞涨",
        "对 BTC 汇率跌破 EMA20",
        "相对强弱转负",
    ],
    "wyckoff_spring": [
        "天量高潮后 AR 回撤",
        "假破后无法收回箱体",
        "二次测试失败",
    ],
    "liquidity_sweep": [
        "扫完触及对侧流动性",
        "中轴反向吞没",
        "强单边趋势下逆势 SFP 失效",
    ],
}


@dataclass
class ModelResult:
    model_id: str
    hit: bool
    score: float
    stage: str
    entry: str
    exit: str
    metrics: dict[str, Any]
    tf: str
    hard_fail: bool = False
    label: str = ""
    end_signals: list[str] = field(default_factory=list)
    signal_time_ms: int | None = None
    direction: str = "neutral"
    score_reasons: list[str] = field(default_factory=list)

    def to_hit_dict(self) -> dict[str, Any]:
        from oi_mornitor.potential_features import ms_to_utc8_str
        from oi_mornitor.potential_score_explain import direction_label

        d = str(self.direction or "neutral")
        return {
            "id": self.model_id,
            "label": self.label or MODEL_LABELS.get(self.model_id, self.model_id),
            "stage": self.stage,
            "score": int(round(self.score)),
            "reasons": list(self.score_reasons) if self.score_reasons else ([self.entry] if self.entry else []),
            "entry": self.entry,
            "exit": self.exit,
            "end_signals": self.end_signals,
            "metrics": self.metrics,
            "tf": self.tf,
            "signal_tf": self.tf,
            "signal_time_ms": self.signal_time_ms,
            "signal_time_utc8": ms_to_utc8_str(self.signal_time_ms),
            "direction": d,
            "direction_label": direction_label(d),
            "score_reasons": list(self.score_reasons),
            "hard_fail": self.hard_fail,
        }


def _miss(model_id: str, tf: str = "1h") -> ModelResult:
    return ModelResult(
        model_id=model_id,
        hit=False,
        score=0.0,
        stage="watch",
        entry="",
        exit="",
        metrics={},
        tf=tf,
        label=MODEL_LABELS.get(model_id, model_id),
        end_signals=END_SIGNALS.get(model_id, []),
    )


def _signal_ms(df: pd.DataFrame) -> int | None:
    from oi_mornitor.potential_features import last_closed_bar_open_ms

    return last_closed_bar_open_ms(df)


def _bars_for_days(tf: str, days: float) -> int:
    h = {"15m": 0.25, "1h": 1, "4h": 4, "1d": 24}.get(tf, 1)
    return max(1, int(days * 24 / h))


def find_box(df: pd.DataFrame, cfg: dict[str, Any]) -> dict[str, Any] | None:
    n_min = int(cfg["box_min_bars"])
    n_max = int(cfg["box_max_bars"])
    if len(df) < n_min + 5:
        return None
    best = None
    widths: list[float] = []
    for n in range(n_min, min(n_max, len(df) - 2)):
        seg = df.iloc[-n:]
        hi = float(seg["high"].max())
        lo = float(seg["low"].min())
        mid = (hi + lo) / 2
        if mid <= 0:
            continue
        w = (hi - lo) / mid
        widths.append(w)
    if not widths:
        return None
    w_arr = np.array(widths)
    for n in range(n_min, min(n_max, len(df) - 2)):
        seg = df.iloc[-n:]
        hi = float(seg["high"].max())
        lo = float(seg["low"].min())
        mid = (hi + lo) / 2
        if mid <= 0:
            continue
        w = (hi - lo) / mid
        pct = float((w_arr <= w).sum()) / len(w_arr)
        if pct > float(cfg["box_width_pctile_max"]):
            continue
        touches_hi = sum(1 for i in range(len(seg)) if float(seg["high"].iloc[i]) >= hi * 0.995)
        touches_lo = sum(1 for i in range(len(seg)) if float(seg["low"].iloc[i]) <= lo * 1.005)
        if touches_hi >= 2 and touches_lo >= 2:
            best = {"lo": lo, "hi": hi, "mid": mid, "width": w, "bars": n}
    return best


def eval_m1_quiet_oi(feed: SymbolFeed, cfg_root: dict[str, Any]) -> ModelResult:
    mid = "quiet_oi_breakout"
    c = cfg_root[mid]
    tf = str(c["tf_primary"])
    df = feed.df(tf)
    vol_ma = int(c.get("volume_ratio_ma") or 20)
    if df.empty or len(df) < 100:
        return _miss(mid, tf)

    vq_short = _bars_for_days(tf, float(c.get("volume_quiet_short_days") or 7))
    vq_long = _bars_for_days(tf, float(c.get("volume_quiet_long_days") or 30))
    spike_lb = int(c.get("spike_lookback_bars") or 10)
    vq = volume_quiet_ratio_pre_spike(df, vq_short, vq_long, spike_lb + 2)
    oq = oi_quiet_ratio(df, _bars_for_days(tf, 14), _bars_for_days(tf, 60))
    oi7 = oi_chg_pct(df, _bars_for_days(tf, 7))
    oi14 = oi_chg_pct(df, _bars_for_days(tf, 14))
    accel = oi_accel(df)
    atr_p = atr_pctile(df, 90)
    rw60 = range_width(df, int(c["lookback_range_bars"]))
    vr = volume_ratio(df, vol_ma)
    spike_off = recent_volume_spike_offset(
        df,
        int(c.get("spike_lookback_bars") or 10),
        vol_ma,
        float(c.get("spike_volume_ratio_min") or 2.8),
    )
    sustain_ok = False
    sustain_bars = 0
    sustain_ret: float | None = None
    if spike_off is not None:
        sustain_ok, sustain_bars, sustain_ret = volume_sustain_after_spike(
            df,
            spike_off,
            int(c.get("sustain_bars_min") or 2),
            float(c.get("sustain_volume_ratio_min") or 1.25),
            vol_ma,
        )
    reclaim = int(c["reclaim_ma"])
    e_ma = ema(df["close"].astype(float), reclaim)
    c_hold = float(df["low"].iloc[-1]) >= float(e_ma.iloc[-1]) * 0.995
    hi20 = float(df["high"].iloc[-21:-1].max()) if len(df) > 21 else 0.0
    c_break = float(df["close"].iloc[-1]) > hi20 if hi20 > 0 else False

    C_vol_quiet = vq is not None and vq <= float(c.get("volume_quiet_max") or 0.72)
    C_oi_quiet = oq is not None and oq <= float(c["oi_quiet_max"])
    C_oi7 = oi7 is not None and oi7 >= float(c["oi_chg_7d_min"])
    C_oi14 = oi14 is not None and oi14 >= float(c["oi_chg_14d_min"])
    C_accel = accel is not None and accel >= float(c["oi_accel_min"])
    C_calm = (atr_p is not None and atr_p <= float(c["atr_pctile_max"])) or (
        rw60 is not None and rw60 < 0.25
    )
    C_spike = spike_off is not None
    C_sustain = sustain_ok
    C_vol_mild = (
        vr is not None
        and float(c["volume_ratio_mild_min"]) <= vr <= float(c["volume_ratio_mild_max"])
    )
    C_vol_spk = vr is not None and vr >= float(c["volume_ratio_spike"])
    C_hold = c_hold
    C_break = c_break

    watch = C_vol_quiet and C_calm
    primed = watch and C_spike
    triggered = primed and C_sustain and (C_hold or c_break)
    oi1d = oi_chg_pct(df, _bars_for_days(tf, 1))
    r1d = ret_pct(df, _bars_for_days(tf, 1))
    exiting = triggered and (
        (oi1d is not None and oi1d < -0.08 and r1d is not None and r1d < 0.02)
        or (sustain_ret is not None and sustain_ret < -0.05)
        or (vr is not None and vr < 0.85 and not C_sustain)
    )

    stage = "watch"
    if primed:
        stage = "primed"
    if triggered:
        stage = "triggered"
    if exiting:
        stage = "exiting"

    score = 0.0
    if C_vol_quiet:
        score += 28
    if C_calm:
        score += 18
    if C_spike:
        score += 22
    if C_sustain:
        score += 22
    if C_hold:
        score += 5
    if C_break:
        score += 5
    if C_oi_quiet and (C_oi7 or C_oi14):
        score += 5
    if C_accel and C_vol_mild:
        score += 5
    if exiting:
        score -= 25
    score = max(0.0, min(100.0, score))

    require_sustain = bool(c.get("require_sustain_for_hit", True))
    hit = (
        score >= float(c["score_hit_min"])
        and stage == "triggered"
        and (C_sustain if require_sustain else True)
        and not exiting
    )
    vq_s = f"{vq:.2f}" if vq is not None else "—"
    vr_s = f"{vr:.1f}" if vr is not None else "—"
    entry = f"量沉寂比{vq_s}，近{spike_off or '—'}根前放量，延续{sustain_bars}根，量比{vr_s}"
    exit = ""
    if exiting and r1d is not None:
        exit = f"放量后量能衰竭/回撤，疑单根脉冲结束"

    return ModelResult(
        model_id=mid,
        hit=hit,
        score=score,
        stage=stage,
        entry=entry[:120],
        exit=exit[:120],
        metrics={
            "volume_quiet_ratio": round(vq, 4) if vq is not None else None,
            "volume_spike_bars_ago": spike_off,
            "volume_sustain_bars": sustain_bars,
            "volume_sustain_ret": round(sustain_ret, 4) if sustain_ret is not None else None,
            "oi_quiet_ratio": round(oq, 4) if oq is not None else None,
            "oi_change_7d_pct": round(oi7, 4) if oi7 is not None else None,
            "oi_change_14d_pct": round(oi14, 4) if oi14 is not None else None,
            "oi_accel": round(accel, 6) if accel is not None else None,
            "atr_pctile": round(atr_p, 3) if atr_p is not None else None,
            "volume_ratio": round(vr, 2) if vr is not None else None,
            "range_width_60": round(rw60, 4) if rw60 is not None else None,
        },
        tf=tf,
        signal_time_ms=_signal_ms(df),
        label=MODEL_LABELS[mid],
        end_signals=END_SIGNALS[mid],
    )


def eval_m2_short_squeeze(feed: SymbolFeed, cfg_root: dict[str, Any]) -> ModelResult:
    mid = "short_squeeze"
    c = cfg_root[mid]
    tf = str(c["tf_primary"])
    df = feed.df(tf)
    rates = feed.funding_rates
    if df.empty or len(df) < 48:
        return _miss(mid, tf)

    n = int(c["fund_mean_n"])
    fm = fund_mean(rates, n) if rates else None
    fl = rates[-1] if rates else None
    fp = fund_pctile(rates, n, 30) if rates else None
    streak = fund_neg_streak(rates) if rates else 0
    oi1 = oi_chg_pct(df, _bars_for_days(tf, 1))
    oi3 = oi_chg_pct(df, _bars_for_days(tf, 3))
    r1 = ret_pct(df, _bars_for_days(tf, 1))

    C_fund = (fm is not None and fm <= float(c["fund_extreme"])) or (
        fp is not None and fp <= float(c["fund_extreme_pctile"])
    )
    C_streak = streak >= int(c["fund_neg_streak_min"])
    C_oi = (oi1 is not None and oi1 >= float(c["oi_chg_1d_min"])) or (
        oi3 is not None and oi3 >= float(c["oi_chg_3d_min"])
    )
    C_hold = r1 is not None and r1 > -float(c["price_anti_drop_max"])
    _, sl = swing_points(df, 3)
    swing_lo = sl[-1][1] if sl else None
    C_support = swing_lo is None or float(df["close"].iloc[-1]) >= swing_lo * 0.998
    C_basis = feed.spot_premium is not None and feed.spot_premium >= float(
        c["basis_spot_premium_min"]
    )
    hi3 = float(df["high"].iloc[-4:-1].max()) if len(df) > 4 else 0.0
    price_break = hi3 > 0 and float(df["close"].iloc[-1]) > hi3
    fund_scores = bool(c.get("funding_scores_enabled", False))
    core = C_oi and C_hold and C_support and price_break
    if fund_scores:
        triggered = core and C_fund and C_streak
    else:
        triggered = core
    exiting = (
        fm is not None
        and fm >= float(c["exit_fund_recover"])
        and oi1 is not None
        and oi1 <= float(c["exit_oi_cliff_1d"])
    ) or (fl is not None and fl >= 0 and oi1 is not None and oi1 <= float(c["exit_oi_cliff_1d"]))

    watch = C_oi and C_hold
    primed = watch and C_support
    stage = "watch"
    if primed:
        stage = "primed"
    if triggered:
        stage = "triggered"
    if exiting:
        stage = "exiting"

    score = 0.0
    if fund_scores:
        if C_fund:
            score += 10
        if C_streak:
            score += 5
    if C_oi:
        score += 30
    if C_hold:
        score += 20
    if C_support:
        score += 15
    if C_basis:
        score += 5
    if triggered:
        score += 15
    if exiting:
        score -= 25
    score = max(0.0, min(100.0, score))
    hit_min = float(c.get("score_hit_min") or 52)
    hit = score >= hit_min and stage == "triggered" and not exiting

    f_disp = fm if fm is not None else (fl or 0.0)
    fund_note = f"费率{f_disp:.2%}（仅诊断）" if not fund_scores else f"费率{f_disp:.2%}"
    entry = f"{fund_note}，OI{(oi1 or 0):+.0%}/1d，价格抗跌突破"
    exit = ""
    if exiting:
        exit = f"费率收至{f_disp:.2%}且OI日降{(oi1 or 0):.0%}，轧空动能衰竭"

    return ModelResult(
        model_id=mid,
        hit=hit,
        score=score,
        stage=stage,
        entry=entry[:120],
        exit=exit[:120],
        metrics={
            "funding_rate": fl,
            "funding_mean_3": fm,
            "funding_percentile": fp,
            "oi_change_1d_pct": oi1,
            "oi_change_3d_pct": oi3,
            "spot_premium": feed.spot_premium,
        },
        tf=tf,
        signal_time_ms=_signal_ms(df),
        label=MODEL_LABELS[mid],
        end_signals=END_SIGNALS[mid],
    )


def eval_m3_relative_strength(feed: SymbolFeed, cfg_root: dict[str, Any]) -> ModelResult:
    mid = "relative_strength"
    c = dict(cfg_root[mid])
    if feed.scan_profile == "fast":
        c.update(cfg_root.get("relative_strength_fast") or {})
    tf = str(c["tf_primary"])
    tf_tr = str(c["tf_trigger"])
    df = feed.df(tf)
    btc = feed.btc(tf)
    btc_tr = feed.btc(tf_tr)
    if df.empty or btc.empty or len(df) < 30:
        return _miss(mid, tf)

    lb = int(c["btc_lookback_bars"])
    regime = btc_regime(btc, lb, float(c["btc_down_th"]), float(c["btc_flat_th"]))
    vs = vs_btc(df, btc, lb)
    antilog = (
        regime == "down"
        and not new_low(df, lb)
        and vs is not None
        and vs >= float(c["vs_btc_down_min"])
    )
    vr = volume_ratio(df, 20)
    brk = int(c["break_lookback"])
    flat_lead = (
        regime == "flat"
        and len(df) > brk + 1
        and float(df["close"].iloc[-1])
        > float(df["high"].iloc[-brk - 1 : -1].max())
        and vr is not None
        and vr >= float(c["vol_break_min"])
    )
    ef, es = int(c["ema_fast"]), int(c["ema_slow"])
    e1, e2 = ema(df["close"].astype(float), ef), ema(df["close"].astype(float), es)
    c_ema = float(df["close"].iloc[-1]) > float(e1.iloc[-1]) > float(e2.iloc[-1])
    c_pair = coin_btc_ema_bull(df, btc)
    c_turn = detect_btc_turn(btc_tr if not btc_tr.empty else btc)
    r1 = ret_pct(df, 1)

    watch = antilog
    primed = antilog and (c_ema or c_pair)
    triggered = primed and (flat_lead or (c_turn and r1 is not None and r1 > 0))
    vs_exit = vs_btc(df, btc, lb)
    exiting = (regime == "up" and vs_exit is not None and vs_exit <= float(c["exit_vs_btc_lag"])) or (
        c_pair and float(df["close"].iloc[-1]) / float(btc["close"].iloc[-1])
        < float(ema(df["close"].astype(float) / btc["close"].astype(float), 20).iloc[-1])
    )

    stage = "watch"
    if primed:
        stage = "primed"
    if triggered:
        stage = "triggered"
    if exiting:
        stage = "exiting"

    score = 0.0
    if antilog:
        score += 30
    if c_ema:
        score += 20
    if c_pair:
        score += 20
    if flat_lead:
        score += 20
    if c_turn:
        score += 10
    if exiting:
        score -= 25
    score = max(0.0, min(100.0, score))
    hit = score >= 40 and (watch or primed or triggered or exiting)

    entry = f"BTC{regime}窗口 VS_BTC{(vs or 0):+.1%}，EMA/汇率{'多头' if c_pair else '整理'}"
    exit = "BTC上涨窗口相对滞涨" if exiting else ""

    return ModelResult(
        model_id=mid,
        hit=hit,
        score=score,
        stage=stage,
        entry=entry[:120],
        exit=exit[:120],
        metrics={
            "vs_btc_pct": vs,
            "btc_regime": regime,
            "coin_btc_trend": c_pair,
            "volume_ratio": vr,
        },
        tf=tf,
        signal_time_ms=_signal_ms(df),
        label=MODEL_LABELS[mid],
        end_signals=END_SIGNALS[mid],
    )


def eval_m4_wyckoff_spring(feed: SymbolFeed, cfg_root: dict[str, Any]) -> ModelResult:
    mid = "wyckoff_spring"
    c = cfg_root[mid]
    tf = str(c["tf_primary"])
    df = feed.df(tf)
    if len(df) < int(c["box_min_bars"]) + 10:
        return _miss(mid, tf)

    box = find_box(df, c)
    hard_fail = False
    C_box = box is not None
    C_spring = False
    C_test = False
    spring_depth = None
    reclaim_bars = None

    if box:
        lo = box["lo"]
        min_b = float(c["spring_min_break"])
        max_b = float(c["spring_max_break"])
        max_bars = int(c["spring_max_bars"])
        for i in range(max(0, len(df) - max_bars - 8), len(df)):
            low_i = float(df["low"].iloc[i])
            if lo * (1 - max_b) <= low_i < lo * (1 - min_b):
                vz = vol_z(df, i)
                if vz is not None and vz <= float(c["spring_max_vol_z"]):
                    for j in range(i + 1, min(len(df), i + max_bars + 1)):
                        if float(df["close"].iloc[j]) >= lo:
                            C_spring = True
                            spring_depth = (lo - low_i) / lo
                            reclaim_bars = j - i
                            break
            elif low_i < lo * (1 - max_b):
                reclaimed = any(
                    float(df["close"].iloc[j]) >= lo
                    for j in range(i + 1, min(len(df), i + max_bars + 3))
                )
                if not reclaimed:
                    hard_fail = True

        if C_spring and reclaim_bars:
            j = len(df) - 1
            pb_vz = vol_z(df, j)
            pull_lo = float(df["low"].iloc[-3:].min())
            if pull_lo >= lo * 0.998 and pb_vz is not None and pb_vz <= float(c["test_max_vol_z"]):
                C_test = True

    atr = wilder_atr(df, 14)
    bc_exit = False
    if len(df) >= 5:
        vz_last = vol_z(df, -1)
        body = abs(float(df["close"].iloc[-1]) - float(df["open"].iloc[-1]))
        atr_v = float(atr.iloc[-1]) if pd.notna(atr.iloc[-1]) else 0.0
        bull = float(df["close"].iloc[-1]) > float(df["open"].iloc[-1])
        if (
            vz_last is not None
            and vz_last >= float(c["bc_vol_z"])
            and atr_v > 0
            and bull
            and body / atr_v >= float(c["bc_body_atr_min"])
        ):
            bc_exit = True

    stage = "watch"
    if C_box:
        stage = "watch"
    if C_spring:
        stage = "primed"
    if C_spring and C_test:
        stage = "triggered"
    if bc_exit:
        stage = "exiting"

    score = 0.0
    if C_box:
        score += 25
    if C_spring:
        score += 35
    if C_test:
        score += 25
    if bc_exit:
        score -= 30
    score = max(0.0, min(100.0, score))
    hit = C_spring and score >= 35 and not hard_fail

    entry = "箱体Spring假破收回" if C_spring else "箱体震荡观察"
    exit = "天量高潮后回撤，疑BC+AR" if bc_exit else ""

    return ModelResult(
        model_id=mid,
        hit=hit,
        score=score,
        stage=stage,
        entry=entry[:120],
        exit=exit[:120],
        metrics={
            "range_width_pct": box["width"] if box else None,
            "spring_depth_pct": spring_depth,
            "spring_reclaim_bars": reclaim_bars,
        },
        tf=tf,
        signal_time_ms=_signal_ms(df),
        hard_fail=hard_fail,
        label=MODEL_LABELS[mid],
        end_signals=END_SIGNALS[mid],
    )


def eval_m5_liquidity_sweep(feed: SymbolFeed, cfg_root: dict[str, Any]) -> ModelResult:
    mid = "liquidity_sweep"
    c = cfg_root[mid]
    tf = str(c["tf_primary"])
    df = feed.df(tf)
    if len(df) < 40:
        return _miss(mid, tf)

    L = int(c["swing_L"])
    sh, sl = swing_points(df, L)
    tol = float(c["eh_tol_pct"])
    eh = equal_levels(sh, tol, int(c["min_sep_bars"]), int(c["max_sep_bars"]))
    el = equal_levels(sl, tol, int(c["min_sep_bars"]), int(c["max_sep_bars"]))
    C_pool = eh is not None or el is not None

    atr = wilder_atr(df, 14)
    atr_v = float(atr.iloc[-1]) if pd.notna(atr.iloc[-1]) else 0.0
    atr_p = atr_pctile(df, 90)
    hard_fail = atr_p is not None and atr_p > 0.9

    o, h, l, cl = (
        float(df["open"].iloc[-1]),
        float(df["high"].iloc[-1]),
        float(df["low"].iloc[-1]),
        float(df["close"].iloc[-1]),
    )
    level_h = eh[0] if eh else (sh[-1][1] if sh else None)
    level_l = el[0] if el else (sl[-1][1] if sl else None)
    uw = h - max(o, cl)
    lw = min(o, cl) - l
    wick_min = float(c["wick_min_atr"]) * atr_v if atr_v > 0 else 0.0

    C_sfp_h = (
        level_h is not None
        and h > level_h
        and cl < level_h
        and uw >= wick_min
    )
    C_sfp_l = (
        level_l is not None
        and l < level_l
        and cl > level_l
        and lw >= wick_min
    )
    C_sfp = C_sfp_h or C_sfp_l

    stage = "watch"
    if C_pool:
        stage = "watch"
    if C_sfp and bool(c["reclaim_required"]):
        stage = "triggered"

    score = 0.0
    if C_pool:
        score += 20
    if C_sfp:
        score += 40
    hit = C_sfp and score >= 45
    if hard_fail:
        score -= 40
        hit = False

    side = "high" if C_sfp_h else ("low" if C_sfp_l else "")
    entry = f"{'上' if C_sfp_h else '下'}方流动性扫单后收回" if C_sfp else "等流动性池形成"
    exit = "触及对侧流动性或中轴反向吞没"

    return ModelResult(
        model_id=mid,
        hit=hit,
        score=max(0.0, min(100.0, score)),
        stage=stage,
        entry=entry[:120],
        exit=exit[:120],
        metrics={
            "sweep_side": side,
            "level": level_h or level_l,
            "reclaim": C_sfp,
        },
        tf=tf,
        signal_time_ms=_signal_ms(df),
        hard_fail=hard_fail,
        label=MODEL_LABELS[mid],
        end_signals=END_SIGNALS[mid],
    )


_EVAL_MAP = {
    "quiet_oi_breakout": eval_m1_quiet_oi,
    "short_squeeze": eval_m2_short_squeeze,
    "relative_strength": eval_m3_relative_strength,
    "wyckoff_spring": eval_m4_wyckoff_spring,
    "liquidity_sweep": eval_m5_liquidity_sweep,
}


def evaluate_models(feed: SymbolFeed, model_ids: list[str] | None = None) -> list[ModelResult]:
    cfg = load_potential_config()
    enabled = list(model_ids) if model_ids else list(cfg.get("models_enabled") or [])
    out: list[ModelResult] = []
    for mid in enabled:
        fn = _EVAL_MAP.get(mid)
        if not fn:
            continue
        try:
            from oi_mornitor.potential_score_explain import finalize_model_result

            out.append(finalize_model_result(fn(feed, cfg)))
        except Exception:  # noqa: BLE001
            out.append(_miss(mid))
    return out


def evaluate_all_models(feed: SymbolFeed) -> list[ModelResult]:
    return evaluate_models(feed, None)
