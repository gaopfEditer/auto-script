"""单周期六组加权打分 0-100。"""
from __future__ import annotations

import os
from typing import Any

import pandas as pd

from oi_mornitor.strategy.board_tags import tag_board_context
from oi_mornitor.strategy.ma_confluence import ema_alignment

W_PATTERN = float(os.getenv("OI_SCORE_W_PATTERN", "25"))
W_LOCATION = float(os.getenv("OI_SCORE_W_LOCATION", "25"))
W_VOLUME = float(os.getenv("OI_SCORE_W_VOLUME", "20"))
W_DIV = float(os.getenv("OI_SCORE_W_DIV", "15"))
W_FLOW = float(os.getenv("OI_SCORE_W_FLOW", "10"))
W_ENV = float(os.getenv("OI_SCORE_W_ENV", "5"))
VETO_ATR_MULT = float(os.getenv("OI_SCORE_VETO_ATR_MULT", "3.0"))
TTL = {"15m": 4, "1h": 3, "4h": 2, "1d": 2}

PATTERN_KINDS = {
    "hammer",
    "inverted_hammer",
    "inv_hammer",
    "shooting_star",
    "hs_vegas_break",
    "m_top_vegas_break",
    "bottom_secondary_test",
    "liquidity_sweep",
    "bb_ema144_hammer",
    "bb_ema_shooting_star",
}
LOCATION_KINDS = {"bb_ema144_hammer", "bb_ema_shooting_star"}
VOLUME_KINDS = {
    "vp_match_long",
    "vp_match_short",
    "vp_pullback_long",
    "vp_pullback_short",
    "vp_div_top",
    "vp_div_bottom",
    "vp_exhaust_top",
    "vp_exhaust_bottom",
}
DIV_KINDS = {"macd_bear_div", "macd_bull_div"}


def _clip100(x: float) -> float:
    return max(0.0, min(100.0, x))


def score_side(
    events: list[dict[str, Any]],
    *,
    side: str,
    tf: str,
    row: pd.Series | None = None,
    board: str = "none",
    asof_idx: int | None = None,
) -> dict[str, Any]:
    ttl = TTL.get(tf, 3)
    s_p = s_l = s_v = s_d = s_f = s_e = 0.0
    used: list[str] = []
    near_v = False
    oi_on = False
    for ev in events:
        if ev.get("side") not in (side, "bull" if side == "long" else "bear"):
            # 兼容 candle 的 bull/bear
            if not (
                (side == "long" and ev.get("side") == "bull")
                or (side == "short" and ev.get("side") == "bear")
            ):
                continue
        if ev.get("reject_reason"):
            continue
        if asof_idx is not None and ttl > 0:
            age = asof_idx - int(ev.get("bar_index") or asof_idx)
            if age < 0 or age > ttl:
                continue
            decay = 1.0 - age / max(ttl, 1)
        else:
            decay = 1.0
        kind = str(ev.get("kind") or "")
        st = float(ev.get("strength") or 0.5) * decay
        tags = ev.get("tags") or {}
        near_v = near_v or bool(tags.get("near_vegas") or str(ev.get("text") or "").startswith("V"))
        oi_on = oi_on or bool(tags.get("oi_anomaly") or ev.get("oi_anomaly"))
        if kind in PATTERN_KINDS:
            s_p = max(s_p, st)
            used.append(kind)
        if kind in LOCATION_KINDS or near_v:
            s_l = max(s_l, st if kind in LOCATION_KINDS else 0.5)
        if kind in VOLUME_KINDS:
            s_v = max(s_v, st)
        if kind in DIV_KINDS:
            s_d = max(s_d, st)
    if near_v:
        s_l = max(s_l, 0.55)
        used.append("near_vegas")
    if oi_on:
        s_f = max(s_f, 0.7)
        used.append("oi_anomaly")
    align = ema_alignment(row) if row is not None else "unknown"
    board_tags = tag_board_context(board=board, alignment=align, family="", side=side)
    if board_tags["board_scene"] in ("gainer_trend", "loser_bounce") and side == "long":
        s_e = 0.8
    elif board_tags["board_scene"] in ("gainer_reversal", "loser_trend") and side == "short":
        s_e = 0.8
    elif align == "bull" and side == "long":
        s_e = 0.4
    elif align == "bear" and side == "short":
        s_e = 0.4

    if row is not None and pd.notna(row.get("atr14")) and float(row["atr14"]) > 0:
        rng = float(row.get("candle_range") or (float(row["high"]) - float(row["low"])))
        if rng > VETO_ATR_MULT * float(row["atr14"]):
            return {
                "score": 0.0,
                "veto": "wide_range",
                "parts": {},
                "board": board_tags,
            }

    score = (
        W_PATTERN * s_p
        + W_LOCATION * s_l
        + W_VOLUME * s_v
        + W_DIV * s_d
        + W_FLOW * s_f
        + W_ENV * s_e
    )
    return {
        "score": _clip100(score),
        "veto": None,
        "parts": {"P": s_p, "L": s_l, "V": s_v, "D": s_d, "F": s_f, "E": s_e},
        "used": used,
        "board": board_tags,
        "tags": {"near_vegas": near_v, "oi_anomaly": oi_on},
    }
