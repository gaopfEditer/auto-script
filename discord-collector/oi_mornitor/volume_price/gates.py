"""量价四层门禁：缺层 → 观察；硬禁 → 不出信号。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from oi_mornitor.volume_price.regime import regime_blocks_long, regime_blocks_short
from oi_mornitor.volume_price.vp_config import CLOSE_UPPER_FRAC, VOL_BREAK_MULT


@dataclass
class VpGateResult:
    emit: bool
    formal: bool
    observation_only: bool
    layers: dict[str, bool] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)
    exit_plan: dict[str, Any] = field(default_factory=dict)


def _last_opposite_volume(rows: pd.DataFrame, i: int, *, side: str) -> float | None:
    """最近一根反向放量柱的量。"""
    want_sign = -1 if side == "long" else 1
    vol_ma = rows.get("vol_ma20")
    body = rows.get("body")
    if vol_ma is None or body is None:
        return None
    for j in range(i - 1, max(-1, i - 40), -1):
        if j < 0:
            break
        b = float(body.iloc[j] or 0)
        if want_sign < 0 and b >= 0:
            continue
        if want_sign > 0 and b <= 0:
            continue
        v = float(rows.iloc[j]["volume"])
        vma = float(vol_ma.iloc[j]) if pd.notna(vol_ma.iloc[j]) else 0
        if vma > 0 and v > vma:
            return v
    return None


def _oi_price_aligned(row: pd.Series, side: str) -> tuple[bool, bool]:
    """(aligned, oi_present)。"""
    oi_ch = row.get("oi_change")
    if oi_ch is None or (isinstance(oi_ch, float) and np.isnan(oi_ch)):
        return False, False
    body = float(row.get("body") or 0)
    if side == "long":
        return body > 0 and float(oi_ch) > 0, True
    return body < 0 and float(oi_ch) < 0, True


def build_exit_plan(
    *,
    side: str,
    entry: float,
    invalid: float,
    range_high: float | None,
) -> dict[str, Any]:
    if side == "long":
        risk = max(entry - invalid, entry * 0.001)
        trim_px = float(range_high) if range_high and np.isfinite(range_high) else entry + risk
        trim_alt = entry + risk
        trim = max(trim_px, trim_alt)
        return {
            "invalid": invalid,
            "trim": trim,
            "exit_note": "收盘跌破 EMA20，或放量长上影且量>入场K",
        }
    risk = max(invalid - entry, entry * 0.001)
    trim_px = float(range_high) if range_high else entry - risk
    return {
        "invalid": invalid,
        "trim": min(trim_px, entry - risk),
        "exit_note": "收盘升破 EMA20，或放量长下影且量>入场K",
    }


def gate_confirm_long(row: pd.Series, rows: pd.DataFrame, i: int) -> VpGateResult:
    regime = str(row.get("regime") or "neutral")
    layers: dict[str, bool] = {"regime": True, "breakout": True, "oi": True, "zone": True}
    reasons: list[str] = []

    if regime_blocks_long(regime):
        return VpGateResult(
            emit=False,
            formal=False,
            observation_only=False,
            layers={"regime": False},
            reasons=[f"行情{regime}：禁抄底式量价多"],
        )

    close = float(row["close"])
    low = float(row["low"])
    high = float(row["high"])
    vol = float(row["volume"])
    vol_ma = float(row.get("vol_ma20") or 0)
    h20 = row.get("high_20_prev")
    breakout = pd.notna(h20) and close > float(h20)
    vol_ok = vol_ma > 0 and vol > VOL_BREAK_MULT * vol_ma
    opp = _last_opposite_volume(rows, i, side="long")
    vol_gt_opp = opp is None or vol > opp
    upper_body = float(row.get("close_range_frac") or 0) >= CLOSE_UPPER_FRAC

    if not breakout:
        layers["breakout"] = False
        reasons.append("未收盘突破近20高")
    if not vol_ok:
        layers["breakout"] = False
        reasons.append("量未达1.5×均量")
    if not vol_gt_opp:
        layers["breakout"] = False
        reasons.append("量未超最近反向放量柱")
    if not upper_body:
        layers["breakout"] = False
        reasons.append("收盘不在K线上30%")

    oi_ok, oi_present = _oi_price_aligned(row, "long")
    if not oi_present:
        layers["oi"] = False
        reasons.append("OI 不可用→仅观察")
    elif not oi_ok:
        layers["oi"] = False
        reasons.append("价OI未同向")

    in_top = bool(row.get("in_range_top_15"))
    if in_top and not breakout:
        layers["zone"] = False
        reasons.append("位于30根区间上沿15%且非突破")

    formal = all(layers.values())
    exit_plan = build_exit_plan(
        side="long",
        entry=close,
        invalid=low,
        range_high=float(row.get("range_30_high") or 0) or None,
    )
    return VpGateResult(
        emit=True,
        formal=formal,
        observation_only=not formal,
        layers=layers,
        reasons=reasons,
        exit_plan=exit_plan,
    )


def gate_confirm_short(row: pd.Series, rows: pd.DataFrame, i: int) -> VpGateResult:
    regime = str(row.get("regime") or "neutral")
    if regime_blocks_short(regime):
        return VpGateResult(
            emit=False,
            formal=False,
            observation_only=False,
            layers={"regime": False},
            reasons=[f"行情{regime}：震荡禁空确认"],
        )

    close = float(row["close"])
    high = float(row["high"])
    low = float(row["low"])
    vol = float(row["volume"])
    vol_ma = float(row.get("vol_ma20") or 0)
    low_20 = rows["low"].rolling(20, min_periods=20).min().shift(1).iloc[i]
    breakout = pd.notna(low_20) and close < float(low_20)
    vol_ok = vol_ma > 0 and vol > VOL_BREAK_MULT * vol_ma
    opp = _last_opposite_volume(rows, i, side="short")
    vol_gt_opp = opp is None or vol > opp
    rng = max(high - low, 1e-12)
    lower_body = (high - close) / rng >= CLOSE_UPPER_FRAC

    layers = {"regime": True, "breakout": True, "oi": True, "zone": True}
    reasons: list[str] = []
    if not breakout:
        layers["breakout"] = False
        reasons.append("未收盘跌破近20低")
    if not vol_ok:
        layers["breakout"] = False
    if not vol_gt_opp:
        layers["breakout"] = False
    if not lower_body:
        layers["breakout"] = False
        reasons.append("收盘不在K线下30%")

    oi_ok, oi_present = _oi_price_aligned(row, "short")
    if not oi_present:
        layers["oi"] = False
        reasons.append("OI 不可用→仅观察")
    elif not oi_ok:
        layers["oi"] = False
        reasons.append("价OI未同向")

    formal = all(layers.values())
    exit_plan = build_exit_plan(
        side="short",
        entry=close,
        invalid=high,
        range_high=float(row.get("range_30_low") or 0) or None,
    )
    return VpGateResult(
        emit=True,
        formal=formal,
        observation_only=not formal,
        layers=layers,
        reasons=reasons,
        exit_plan=exit_plan,
    )


def gate_thrust(row: pd.Series, *, side: str) -> VpGateResult:
    regime = str(row.get("regime") or "neutral")
    if side == "long" and regime_blocks_long(regime):
        return VpGateResult(
            emit=False,
            formal=False,
            observation_only=False,
            layers={"regime": False},
            reasons=[f"行情{regime}：禁量价推进多"],
        )
    if side == "short" and regime_blocks_short(regime):
        return VpGateResult(
            emit=False,
            formal=False,
            observation_only=False,
            layers={"regime": False},
            reasons=[f"行情{regime}：禁量价推进空"],
        )
    close = float(row["close"])
    inv = float(row["low"] if side == "long" else row["high"])
    exit_plan = build_exit_plan(
        side=side,
        entry=close,
        invalid=inv,
        range_high=float(row.get("range_30_high") or row.get("range_30_low") or 0) or None,
    )
    return VpGateResult(
        emit=True,
        formal=True,
        observation_only=False,
        layers={"regime": True},
        reasons=[],
        exit_plan=exit_plan,
    )


def gate_reversal_long(row: pd.Series) -> VpGateResult:
    regime = str(row.get("regime") or "neutral")
    if regime_blocks_long(regime):
        return VpGateResult(
            emit=False,
            formal=False,
            observation_only=False,
            layers={"regime": False},
            reasons=[f"行情{regime}：禁反转多"],
        )
    close = float(row["close"])
    low = float(row["low"])
    oi_ok, oi_present = _oi_price_aligned(row, "long")
    layers = {"regime": True, "oi": oi_present and oi_ok}
    reasons: list[str] = []
    if not oi_present:
        layers["oi"] = False
        reasons.append("OI 不可用→仅观察")
    elif not oi_ok:
        layers["oi"] = False
        reasons.append("价OI未同向")
    formal = all(layers.values())
    exit_plan = build_exit_plan(
        side="long",
        entry=close,
        invalid=low,
        range_high=float(row.get("range_30_high") or 0) or None,
    )
    return VpGateResult(
        emit=True,
        formal=formal,
        observation_only=not formal,
        layers=layers,
        reasons=reasons,
        exit_plan=exit_plan,
    )


def gate_reversal_short(row: pd.Series) -> VpGateResult:
    regime = str(row.get("regime") or "neutral")
    if regime_blocks_short(regime):
        return VpGateResult(
            emit=False,
            formal=False,
            observation_only=False,
            layers={"regime": False},
            reasons=[f"行情{regime}：禁反转空"],
        )
    close = float(row["close"])
    high = float(row["high"])
    oi_ok, oi_present = _oi_price_aligned(row, "short")
    layers = {"regime": True, "oi": oi_present and oi_ok}
    reasons: list[str] = []
    if not oi_present:
        layers["oi"] = False
        reasons.append("OI 不可用→仅观察")
    elif not oi_ok:
        layers["oi"] = False
    formal = all(layers.values())
    exit_plan = build_exit_plan(
        side="short",
        entry=close,
        invalid=high,
        range_high=float(row.get("range_30_low") or 0) or None,
    )
    return VpGateResult(
        emit=True,
        formal=formal,
        observation_only=not formal,
        layers=layers,
        reasons=reasons,
        exit_plan=exit_plan,
    )
