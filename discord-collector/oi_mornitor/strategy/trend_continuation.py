"""独立策略：趋势回调延续（trend_pullback_continuation）。

自有入场、止损、止盈、仓位与超时，不是只读标签。
规则为研究假设，须独立回测与样本外验证。
优先在报告中分开 BTC / DOGE；ETH 可跑但单独汇总，不因是主流就默认纳入结论。
"""
from __future__ import annotations

from typing import Any

import pandas as pd

from oi_mornitor.market_regime import (
    SWING_ORDER,
    bos_by_close,
    classify_trend_regime,
    immediately_reclaimed,
    last_confirmed_swing,
    wick_only_break,
)
from oi_mornitor.opportunity_score import assess
from oi_mornitor.strategy.sl_profiles import resolve_sl_price, tp_prices

STRATEGY_ID = "trend_pullback_continuation"
STRATEGY_LABEL = "趋势回调延续"
FOCUS_SYMBOLS = ("BTC", "DOGE")  # 报告焦点；检测本身不限币种
TIMEOUT_BARS_1H = 24  # 超时退出
BATCH_WEIGHTS = (0.30, 0.30, 0.40)
DEFAULT_R = (1.5, 3.0)
ALT_R_PROFILES = ((1.5, 2.0, 3.0), (1.5, 3.0), (2.0, 3.0))


def _oi_status(df: pd.DataFrame, idx: int, side: str) -> str:
    if "oi" not in df.columns or idx < 2:
        return "oi_unavailable"
    cur = df.iloc[idx].get("oi")
    prev = df.iloc[idx - 1].get("oi")
    try:
        c, p = float(cur), float(prev)
    except (TypeError, ValueError):
        return "oi_unavailable"
    if not (c > 0 and p > 0):
        return "oi_unavailable"
    chg = (c - p) / p
    # 不利背离：做多时 OI 明显下降；做空时 OI 明显上升（挤仓空头未出清的粗代理）
    if side == "long" and chg < -0.02:
        return "adverse"
    if side == "short" and chg > 0.03:
        return "adverse"
    if abs(chg) < 0.005:
        return "pending"
    return "confirmed"


def _vol_contraction(df: pd.DataFrame, start: int, end: int) -> bool:
    if "volume" not in df.columns or end <= start:
        return False
    vol = df["volume"].astype(float)
    impulse = float(vol.iloc[max(0, start - 2) : start + 1].max())
    pull = float(vol.iloc[start + 1 : end + 1].mean()) if end > start else impulse
    return impulse > 0 and pull <= impulse * 0.8


def _directional_confirm(row: pd.Series, side: str) -> bool:
    o, c = float(row["open"]), float(row["close"])
    h, l = float(row["high"]), float(row["low"])
    rng = max(h - l, 1e-12)
    body = abs(c - o)
    if body / rng < 0.4:
        return False
    if side == "long":
        return c > o
    return c < o


def _atr(df: pd.DataFrame, idx: int, period: int = 14) -> float:
    if idx < period:
        return 0.0
    trs: list[float] = []
    for i in range(max(1, idx - period + 1), idx + 1):
        row, prev = df.iloc[i], df.iloc[i - 1]
        h, l, pc = float(row["high"]), float(row["low"]), float(prev["close"])
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return sum(trs) / len(trs) if trs else 0.0


def detect_trend_pullback_trades(
    df_1h: pd.DataFrame,
    df_4h: pd.DataFrame | None = None,
    *,
    symbol: str = "",
    sl_profile: str = "structure",
    r_multiples: tuple[float, ...] = DEFAULT_R,
    start_idx: int = 60,
) -> list[dict[str, Any]]:
    """扫描 1h（配 4h 环境）。入场为确认柱的下一根开盘（由回测侧用 next open 填价）。"""
    if df_1h is None or len(df_1h) < start_idx + 3:
        return []
    trades: list[dict[str, Any]] = []
    n = len(df_1h)
    last_emit = -999

    for i in range(start_idx, n - 1):  # i = 确认柱（已收盘）；入场在 i+1 open
        if i - last_emit < 4:
            continue
        r4 = classify_trend_regime(df_4h, end_idx=len(df_4h) - 1, tf="4h") if df_4h is not None and len(df_4h) else None
        # 若能把 4h 对齐到 1h 时间，更精确
        if df_4h is not None and len(df_4h) and "open_time" in df_1h.columns and "open_time" in df_4h.columns:
            t = int(df_1h.iloc[i]["open_time"])
            idx4 = int(df_4h["open_time"].astype(int).searchsorted(t, side="right") - 1)
            idx4 = max(0, min(idx4, len(df_4h) - 1))
            r4 = classify_trend_regime(df_4h, end_idx=idx4, tf="4h")
        r1 = classify_trend_regime(df_1h, end_idx=i, tf="1h")

        forbidden = None
        side = ""
        if r4 is not None and r4.label == "trend_up":
            side = "long"
        elif r4 is not None and r4.label == "trend_down":
            side = "short"
        elif r4 is None and r1.label == "trend_up":
            side = "long"
        elif r4 is None and r1.label == "trend_down":
            side = "short"
        else:
            continue

        if r4 is not None and r4.label in ("trend_up", "trend_down") and r4.label != (
            "trend_up" if side == "long" else "trend_down"
        ):
            forbidden = "4h 结构反转"
            continue

        # 1h BOS 收盘确认：在回调前应已发生
        bos_idx = None
        for k in range(i, max(start_idx - 1, i - 12), -1):
            if bos_by_close(df_1h, bar_idx=k, side=side):
                bos_idx = k
                break
        if bos_idx is None:
            continue
        # 禁止仅影线刺破
        sw = last_confirmed_swing(
            df_1h,
            end_idx=bos_idx - 1,
            which="high" if side == "long" else "low",
        )
        if sw and wick_only_break(df_1h, bar_idx=bos_idx, level=sw[1], side=side):
            continue
        level = sw[1] if sw else float(df_1h.iloc[bos_idx]["close"])
        if immediately_reclaimed(df_1h, break_idx=bos_idx, level=level, side=side, look=2):
            forbidden = "突破后快速收回"
            continue
        if bos_idx >= i:
            # BOS 当天还没形成回踩
            if bos_idx == i:
                continue

        # 回踩：BOS 之后价格回到突破位附近，且未破坏结构
        pb_low = float(df_1h.iloc[bos_idx + 1 : i + 1]["low"].min()) if i > bos_idx else None
        pb_high = float(df_1h.iloc[bos_idx + 1 : i + 1]["high"].max()) if i > bos_idx else None
        if pb_low is None:
            continue
        if side == "long":
            struct_sl_ref = last_confirmed_swing(df_1h, end_idx=i, which="low")
            # 回踩未跌破结构（BOS 前摆动低或突破位过多）
            swing_low = struct_sl_ref[1] if struct_sl_ref else pb_low
            if pb_low < swing_low * 0.997 and struct_sl_ref and struct_sl_ref[0] < bos_idx:
                # 跌破 BOS 前的结构低 = 破坏
                if pb_low < struct_sl_ref[1]:
                    continue
            near_break = abs(pb_low - level) / level <= 0.015 or pb_low <= level
            if not near_break:
                continue
        else:
            struct_sl_ref = last_confirmed_swing(df_1h, end_idx=i, which="high")
            swing_high = struct_sl_ref[1] if struct_sl_ref else pb_high
            near_break = abs(pb_high - level) / level <= 0.015 or pb_high >= level
            if not near_break:
                continue

        if not _vol_contraction(df_1h, bos_idx, i):
            vol_state = "expansion"
        else:
            vol_state = "contraction"

        row = df_1h.iloc[i]
        if not _directional_confirm(row, side):
            continue

        oi = _oi_status(df_1h, i, side)
        if oi == "adverse":
            # 规则：OI 明显不利则不做（硬禁止），并记入评估
            continue

        atr = _atr(df_1h, i)
        if side == "long":
            struct_lvl = float(df_1h.iloc[bos_idx + 1 : i + 1]["low"].min())
        else:
            struct_lvl = float(df_1h.iloc[bos_idx + 1 : i + 1]["high"].max())
        next_open = float(df_1h.iloc[i + 1]["open"]) if i + 1 < n else float(row["close"])
        sl, used_sl = resolve_sl_price(
            entry=next_open,
            is_short=side == "short",
            structure_level=struct_lvl,
            atr=atr,
            profile=sl_profile,
        )
        tps = tp_prices(next_open, sl, is_short=side == "short", r_multiples=r_multiples)
        opp = assess(
            symbol=symbol,
            side_intent=side,
            regime_4h=r4.label if r4 else "unknown",
            regime_1h=r1.label,
            structure_1h="bos",
            oi_status=oi,
            pullback_volume=vol_state,
            pattern=STRATEGY_ID,
            htf_aligned=True if r4 is None or (
                (side == "long" and r4.label == "trend_up") or (side == "short" and r4.label == "trend_down")
            ) else False,
            close_confirmed=True,
            extra_reasons=["回踩后方向性 K 线确认"],
        )
        if opp.decision == "skip":
            continue
        trades.append({
            "strategy": STRATEGY_ID,
            "strategyLabel": STRATEGY_LABEL,
            "symbol": symbol,
            "interval": "1h",
            "kind": STRATEGY_ID,
            "typeLabel": STRATEGY_LABEL,
            "side": "bull" if side == "long" else "bear",
            "bar_index": i,
            "entry_bar": i + 1,
            "entry_mode": "next_bar_open",
            "entry": next_open,
            "defense": struct_lvl,
            "slPrice": sl,
            "slProfile": used_sl,
            "tp1Price": tps[0] if tps else None,
            "tp2Price": tps[1] if len(tps) > 1 else None,
            "tpLevelsR": list(r_multiples),
            "batchWeights": list(BATCH_WEIGHTS),
            "timeoutBars": TIMEOUT_BARS_1H,
            "regime4h": r4.to_dict() if r4 else None,
            "regime1h": r1.to_dict(),
            "oiStatus": oi,
            "opportunity": opp.to_dict(),
            "noTradeRules": ["4h 结构反转", "突破后快速收回", "仅影线刺破", "OI 明显不利"],
            "focusHint": "报告请将 ETH 单独汇总；焦点币 BTC/DOGE",
        })
        last_emit = i
    return trades
