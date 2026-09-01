"""沙盒入场/出场 — 短线猎手(S) + 长线维加斯(T)。"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import pandas as pd

from oi_mornitor.config import (
    CARD_NEAR_ENTRY_MAJOR_LEV,
    CARD_NEAR_ENTRY_PCT,
    CARD_NEAR_ENTRY_PCT_MAJOR,
    CARD_SL_MAX_DIST_PCT,
    CARD_TP_MAX_DIST_PCT,
    SANDBOX_ABSURD_PNL_PCT,
    SANDBOX_FEE_PCT,
    SANDBOX_HUNTER_ATR_MULT,
    SANDBOX_HUNTER_HAMMER_BELOW_MID,
    SANDBOX_HUNTER_HAMMER_TREND_LOOKBACK,
    SANDBOX_HUNTER_HAMMER_TREND_MIN_PCT,
    SANDBOX_HUNTER_REQUIRE_POSITION,
    SANDBOX_HUNTER_SL_PAD,
    SANDBOX_HUNTER_SHOOT_TREND_LOOKBACK,
    SANDBOX_HUNTER_SHOOT_TREND_MIN_PCT,
    SANDBOX_INTERVAL,
    SANDBOX_INTERVALS,
    SANDBOX_LEVERAGE_ALT,
    SANDBOX_LEVERAGE_MAJOR,
    SANDBOX_MAJOR_SYMBOLS,
    SANDBOX_MIN_HOLD_BARS,
    SANDBOX_RANGE_SLOPE_MAX,
    SANDBOX_REF_INTERVALS_HUNTER,
    SANDBOX_REF_INTERVALS_TREND,
    SANDBOX_SL_ATR_MULT,
    SANDBOX_SL_MAX_PCT_ALT,
    SANDBOX_SL_MAX_PCT_MAJOR,
    SANDBOX_SOFT_EXIT_MIN_MOVE_PCT,
    SANDBOX_STEP_TRAIL_PROFIT_PCT,
    SANDBOX_STEP_TRAIL_SL_LIFT_PCT,
    SANDBOX_TREND_BE_PRICE_PCT,
    SANDBOX_TREND_PARTIAL_FRAC,
    SANDBOX_TREND_PARTIAL_PRICE_PCT,
    SANDBOX_TREND_SL_PAD,
    SANDBOX_TREND_SLOPE_MIN,
    SANDBOX_TREND_TRAIL_PCT,
    SANDBOX_VEGAS_DIRECTION_GATE,
)
from oi_mornitor.strategy.candle_signals import near_vegas_channel
from oi_mornitor.strategy.indicators import (
    detect_inverted_hammer,
    detect_shooting_star,
    enrich_strategy_indicators,
)


@dataclass
class SandboxSignal:
    action: str  # enter | exit | trail | partial
    side: str  # LONG | SHORT
    logic: str  # S | T
    price: float
    sl: float | None = None
    tp1: float | None = None
    tp2: float | None = None
    message: str = ""
    meta: dict[str, Any] | None = None


def _ts_sec(open_time_ms: int) -> int:
    return int(open_time_ms // 1000) if open_time_ms > 10_000_000_000 else int(open_time_ms)


def is_major_symbol(symbol: str) -> bool:
    sym = symbol.upper()
    return sym in SANDBOX_MAJOR_SYMBOLS or sym in ("BTCUSDT", "ETHUSDT")


def sandbox_leverage(symbol: str) -> float:
    return SANDBOX_LEVERAGE_MAJOR if is_major_symbol(symbol) else SANDBOX_LEVERAGE_ALT


def card_near_entry_pct(symbol: str, leverage: float | None = None) -> float:
    """
    卡片限价近场阈值（距入场区 %）：
    - 主流（BTC/ETH）或杠杆 ≥ CARD_NEAR_ENTRY_MAJOR_LEV（默认 80，对应约 100x）→ 0.2%
    - 山寨小杠杆（约 20x/30x）→ 1%
    """
    lev = float(leverage) if leverage and float(leverage) > 0 else 0.0
    if is_major_symbol(symbol) or lev >= CARD_NEAR_ENTRY_MAJOR_LEV:
        return CARD_NEAR_ENTRY_PCT_MAJOR
    return CARD_NEAR_ENTRY_PCT


def price_move_pct(entry: float, level: float) -> float:
    """|level − entry| / entry × 100。"""
    e = float(entry or 0)
    if e <= 0:
        return float("inf")
    return abs(float(level) - e) / e * 100.0


def is_absurd_price_move(
    entry: float, exit_px: float, *, max_pct: float | None = None
) -> bool:
    """出场价相对入场偏离是否离谱（默认 |ΔP| > SANDBOX_ABSURD_PNL_PCT）。"""
    cap = float(max_pct if max_pct is not None else SANDBOX_ABSURD_PNL_PCT)
    if cap <= 0:
        return False
    return price_move_pct(entry, exit_px) > cap


def validate_card_levels(
    side: str,
    entry: float,
    sl: float | None,
    tps: list[float] | None = None,
    *,
    sl_max_pct: float | None = None,
    tp_max_pct: float | None = None,
) -> tuple[bool, str]:
    """
    校验卡片 SL/TP 相对入场是否同侧且量级合理。
    典型坏例：入场 4.97e-5、SL=0.0446（错位小数 → 近 9 万 %）。
    """
    side_u = str(side or "").upper()
    entry_v = float(entry or 0)
    if entry_v <= 0:
        return False, "入场价无效"
    sl_cap = float(sl_max_pct if sl_max_pct is not None else CARD_SL_MAX_DIST_PCT)
    tp_cap = float(tp_max_pct if tp_max_pct is not None else CARD_TP_MAX_DIST_PCT)

    if sl is not None:
        sl_v = float(sl)
        if sl_v <= 0:
            return False, "止损无效"
        if side_u == "LONG" and sl_v >= entry_v:
            return False, f"多单止损须低于入场（SL={sl_v:.6g} ≥ entry={entry_v:.6g}）"
        if side_u == "SHORT" and sl_v <= entry_v:
            return False, f"空单止损须高于入场（SL={sl_v:.6g} ≤ entry={entry_v:.6g}）"
        dist = price_move_pct(entry_v, sl_v)
        if sl_cap > 0 and dist > sl_cap:
            return False, f"止损距入场 {dist:.1f}% 超过上限 {sl_cap:g}%（疑小数错位）"

    for i, tp in enumerate(tps or []):
        try:
            tp_v = float(tp)
        except (TypeError, ValueError):
            continue
        if tp_v <= 0:
            continue
        if side_u == "LONG" and tp_v <= entry_v:
            return False, f"多单 TP{i + 1}={tp_v:.6g} 须高于入场"
        if side_u == "SHORT" and tp_v >= entry_v:
            return False, f"空单 TP{i + 1}={tp_v:.6g} 须低于入场"
        dist = price_move_pct(entry_v, tp_v)
        if tp_cap > 0 and dist > tp_cap:
            return False, f"TP{i + 1} 距入场 {dist:.1f}% 超过上限 {tp_cap:g}%"

    return True, ""


def sandbox_sl_max_pct(symbol: str) -> float:
    """兼容旧接口：百分比上限已弃用，返回历史默认值仅供展示。"""
    return SANDBOX_SL_MAX_PCT_MAJOR if is_major_symbol(symbol) else SANDBOX_SL_MAX_PCT_ALT


def clamp_sandbox_sl(
    symbol: str,
    entry: float,
    side: str,
    sl: float,
    *,
    atr: float | None = None,
) -> float:
    """
    用 2.5×ATR(14) 作为止损距离上限，取代 0.5%/1.5% 百分比硬推。

    OI 暴增时 ATR 变大，允许更宽的止损，避免被噪音扫掉。
    结构 SL 距入场超过 mult×ATR 时收束；ATR 无效时不裁剪。
    """
    del symbol  # 距离由 ATR 决定，不再按主流/山寨百分比分档
    if entry <= 0 or sl <= 0:
        return sl
    atr_v = float(atr or 0.0)
    if atr_v <= 0:
        return float(sl)
    mult = float(SANDBOX_SL_ATR_MULT)
    if mult <= 0:
        return float(sl)
    dist = atr_v * mult
    side_u = side.upper()
    if side_u == "LONG":
        floor = entry - dist
        capped = max(float(sl), floor)
        return min(capped, entry * (1.0 - 1e-6))
    if side_u == "SHORT":
        ceil = entry + dist
        capped = min(float(sl), ceil)
        return max(capped, entry * (1.0 + 1e-6))
    return float(sl)


def apply_entry_sl_cap(symbol: str, sig: SandboxSignal) -> SandboxSignal:
    """入场信号按 2.5×ATR(14) 裁剪止损，并回写 meta / 文案中的 SL。"""
    if sig.action != "enter" or not sig.sl or sig.price <= 0:
        return sig
    if (sig.meta or {}).get("skip_sl_cap"):
        return sig
    old = float(sig.sl)
    meta = dict(sig.meta or {})
    atr = float(meta.get("atr") or 0.0)
    new = clamp_sandbox_sl(symbol, float(sig.price), sig.side, old, atr=atr)
    meta["sl_raw"] = old
    meta["initial_sl"] = new
    meta["sl_atr"] = atr
    meta["sl_atr_mult"] = float(SANDBOX_SL_ATR_MULT)
    if atr > 0:
        meta["sl_max_dist"] = atr * float(SANDBOX_SL_ATR_MULT)
        meta["sl_capped"] = abs(new - old) / max(float(sig.price), 1e-12) >= 1e-8
    else:
        meta["sl_capped"] = False
    meta.pop("sl_max_pct", None)
    if abs(new - old) / max(float(sig.price), 1e-12) < 1e-8:
        sig.meta = meta
        return sig
    sig.sl = new
    sig.meta = meta
    if "SL=" in sig.message:
        sig.message = re.sub(r"SL=[0-9.eE+-]+", f"SL={new:.6g}", sig.message, count=1)
    else:
        sig.message = f"{sig.message} · SL={new:.6g}".strip(" ·")
    if meta.get("entry_reason"):
        meta["entry_reason"] = sig.message
    return sig


def sandbox_round_trip_fee_pct(fee_pct: float | None = None) -> float:
    """开+平双边手续费（价格变动百分点，与回测一致）。"""
    one = float(fee_pct if fee_pct is not None else SANDBOX_FEE_PCT)
    return max(0.0, one) * 2.0


def apply_sandbox_fees(
    *,
    pnl_pct: float,
    margin_usd: float,
    leverage: float,
    frac: float = 1.0,
    fee_pct: float | None = None,
) -> tuple[float, float, float, float]:
    """
    从毛利中扣开平双边手续费。
    返回 (net_pnl_pct, net_pnl_usd, fee_usd, fee_price_pct)。
    fee 按名义本金 margin×lev×frac 计：单边 fee_pct%，双边 ×2。
    """
    one = float(fee_pct if fee_pct is not None else SANDBOX_FEE_PCT)
    one = max(0.0, one)
    fee_price_pct = one * 2.0
    frac = min(max(float(frac), 0.0), 1.0)
    notional = float(margin_usd) * float(leverage) * frac
    fee_usd = notional * (one / 100.0) * 2.0
    net_pnl_pct = float(pnl_pct) - fee_price_pct
    net_pnl_usd = net_pnl_pct / 100.0 * float(margin_usd) * float(leverage) * frac
    return net_pnl_pct, net_pnl_usd, fee_usd, fee_price_pct


def entry_source_label(source: str) -> str:
    s = str(source).strip().lower()
    if s in ("manual", "手动"):
        return "手动"
    if s in ("card", "卡片"):
        return "卡片"
    return "自动"


def resolve_entry_source(
    meta: dict[str, Any] | None = None,
    *,
    force_manual: bool = False,
) -> str:
    """订单来源：manual=手动 / card=卡片 / auto=策略自动。"""
    meta = meta or {}
    raw = str(meta.get("source") or meta.get("source_label") or "").strip().lower()
    if raw in ("card", "卡片") or meta.get("card_id") or str(meta.get("logic") or "") == "C":
        return "card"
    if force_manual:
        return "manual"
    if raw in ("manual", "手动"):
        return "manual"
    if raw in ("auto", "自动"):
        return "auto"
    if meta.get("manual") is True:
        return "manual"
    reason = str(meta.get("entry_reason") or meta.get("message") or "")
    if reason.startswith("手动"):
        return "manual"
    if reason.startswith("卡片") or "card_id" in meta:
        return "card"
    return "auto"


_TF_ORDER = ("15m", "30m", "1h", "4h", "1d")


def normalize_sandbox_interval(interval: str | None) -> str:
    iv = (interval or SANDBOX_INTERVAL or "15m").strip()
    return iv if iv else "15m"


def sandbox_intervals() -> tuple[str, ...]:
    return SANDBOX_INTERVALS or (normalize_sandbox_interval(None),)


def ref_intervals_for_logic(logic: str, interval: str | None = None) -> list[str]:
    """参考周期：短线=执行周期；长线=执行周期及以上（默认 15m/1h/4h/1d）。"""
    iv = normalize_sandbox_interval(interval)
    if logic == "T":
        base = list(SANDBOX_REF_INTERVALS_TREND) or ["15m", "1h", "4h", "1d"]
        try:
            idx = _TF_ORDER.index(iv)
            allowed = set(_TF_ORDER[idx:])
            out = [x for x in base if x in allowed]
        except ValueError:
            out = [iv] + [x for x in base if x != iv]
        return out or [iv]
    return [iv]


def entry_meta_common(
    logic: str,
    message: str,
    *,
    source: str = "auto",
    interval: str | None = None,
) -> dict[str, Any]:
    iv = normalize_sandbox_interval(interval)
    refs = ref_intervals_for_logic(logic, iv)
    src = resolve_entry_source({"source": source})
    return {
        "entry_reason": message,
        "interval": iv,
        "ref_intervals": refs,
        "ref_intervals_label": " · ".join(refs),
        "source": src,
        "source_label": entry_source_label(src),
        "manual": src == "manual",
    }


def enrich_sandbox_df(df: pd.DataFrame) -> pd.DataFrame:
    out = enrich_strategy_indicators(df)
    ema12 = out["close"].ewm(span=12, adjust=False).mean()
    ema26 = out["close"].ewm(span=26, adjust=False).mean()
    out["macd"] = ema12 - ema26
    out["macd_signal"] = out["macd"].ewm(span=9, adjust=False).mean()
    out["macd_hist"] = out["macd"] - out["macd_signal"]
    prev_close = out["close"].shift(1)
    tr = pd.concat(
        [
            (out["high"] - out["low"]).abs(),
            (out["high"] - prev_close).abs(),
            (out["low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    out["atr14"] = tr.rolling(14).mean()
    out["vegas_fast_mid"] = (out["vegas_e1"] + out["vegas_e2"]) / 2.0
    out["vegas_slow_mid"] = (out["vegas_e3"] + out["vegas_e4"]) / 2.0
    out["vegas_slow_slope"] = out["vegas_e3"].pct_change(20)
    return out


def detect_hammer(row: pd.Series) -> bool:
    o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
    body = abs(c - o)
    if body <= 0:
        return False
    lower_w = min(o, c) - l
    upper_w = h - max(o, c)
    return lower_w >= body * 1.5 and upper_w <= body * 0.6


def detect_bullish_engulf(last: pd.Series, prev: pd.Series) -> bool:
    """阳线反包：本 K 阳包住前 K 阴。"""
    o1, c1 = float(prev["open"]), float(prev["close"])
    o2, c2 = float(last["open"]), float(last["close"])
    if c1 >= o1 or c2 <= o2:
        return False
    return c2 >= o1 and o2 <= c1


def detect_bearish_engulf(last: pd.Series, prev: pd.Series) -> bool:
    o1, c1 = float(prev["open"]), float(prev["close"])
    o2, c2 = float(last["open"]), float(last["close"])
    if c1 <= o1 or c2 >= o2:
        return False
    return c2 <= o1 and o2 >= c1


def trend_status(df: pd.DataFrame) -> str:
    """
    Trend_Status 分流：
    - BULL：慢速通道斜率向上且价在通道上方
    - BEAR：斜率向下且价在通道下方
    - RANGE：其余（含横盘纠缠）→ 短线猎手环境
    """
    if len(df) < 30:
        return "RANGE"
    last = df.iloc[-1]
    if pd.isna(last.get("vegas_slow_slope")) or pd.isna(last.get("vegas_slow_mid")):
        return "RANGE"
    slope = float(last["vegas_slow_slope"])
    close = float(last["close"])
    slow = float(last["vegas_slow_mid"])
    if close <= 0:
        return "RANGE"
    # 通道纠缠视为震荡
    if pd.notna(last.get("vegas_e1")) and pd.notna(last.get("vegas_e3")):
        entangle = abs(float(last["vegas_e1"]) - float(last["vegas_e3"])) / close
        if entangle < 0.02 and abs(slope) <= SANDBOX_RANGE_SLOPE_MAX:
            return "RANGE"
    if slope >= SANDBOX_TREND_SLOPE_MIN and close > slow:
        return "BULL"
    if slope <= -SANDBOX_TREND_SLOPE_MIN and close < slow:
        return "BEAR"
    return "RANGE"


def vegas_direction(df: pd.DataFrame) -> str:
    """
    Vegas 通道相对位置（图表蓝 vs 红）：
    - UP：快通道中轨(EMA144/169) > 慢通道中轨(EMA576/676) → 偏多
    - DOWN：快 < 慢 → 偏空
    - FLAT：纠缠或数据不足
    """
    if len(df) < 30:
        return "FLAT"
    last = df.iloc[-1]
    if pd.isna(last.get("vegas_fast_mid")) or pd.isna(last.get("vegas_slow_mid")):
        return "FLAT"
    fast = float(last["vegas_fast_mid"])
    slow = float(last["vegas_slow_mid"])
    close = float(last["close"])
    if fast <= 0 or slow <= 0 or close <= 0:
        return "FLAT"
    tol = close * 1e-4
    if fast > slow + tol:
        return "UP"
    if fast < slow - tol:
        return "DOWN"
    return "FLAT"


def annotate_entry_trend_meta(
    sig: SandboxSignal | None,
    *,
    status: str,
    direction: str,
) -> SandboxSignal | None:
    if not sig:
        return None
    meta = dict(sig.meta or {})
    meta["trend_status"] = status
    meta["vegas_direction"] = direction
    meta["vegas_direction_label"] = {
        "UP": "蓝>红↑",
        "DOWN": "红>蓝↓",
        "FLAT": "纠缠",
    }.get(direction, direction)
    sig.meta = meta
    return sig


def gate_entry_by_vegas(
    sig: SandboxSignal | None,
    direction: str,
    *,
    enabled: bool | None = None,
) -> SandboxSignal | None:
    """
    顺 Vegas：底部信号仅在 UP 做多，顶部信号仅在 DOWN 做空。
    FLAT 时不开自动仓，避免纠缠区乱做。
    """
    use = SANDBOX_VEGAS_DIRECTION_GATE if enabled is None else enabled
    if not use or not sig or sig.action != "enter":
        return sig
    side = str(sig.side or "").upper()
    if direction == "UP" and side == "LONG":
        return sig
    if direction == "DOWN" and side == "SHORT":
        return sig
    return None


def hunter_sl(side: str, signal_high: float, signal_low: float) -> float:
    """信号 K 极值 + 0.1% 安全垫，击穿即走。"""
    pad = SANDBOX_HUNTER_SL_PAD
    if side == "SHORT":
        return signal_high * (1.0 + pad)
    return signal_low * (1.0 - pad)


def trend_sl_long(entry: float, hl: float, ema169: float) -> float:
    """多单：HL 或 EMA169 下方 0.2%（取更紧且仍低于入场的结构位）。"""
    structural: list[float] = []
    if hl > 0:
        structural.append(hl * (1.0 - 0.0005))
    if ema169 > 0:
        structural.append(ema169 * (1.0 - SANDBOX_TREND_SL_PAD))
    if not structural:
        return entry * (1.0 - SANDBOX_TREND_SL_PAD)
    raw = max(structural)
    return min(raw, entry * (1.0 - 1e-4))


def trend_sl_short(entry: float, lh: float, ema169: float) -> float:
    structural: list[float] = []
    if lh > 0:
        structural.append(lh * (1.0 + 0.0005))
    if ema169 > 0:
        structural.append(ema169 * (1.0 + SANDBOX_TREND_SL_PAD))
    if not structural:
        return entry * (1.0 + SANDBOX_TREND_SL_PAD)
    raw = min(structural)
    return max(raw, entry * (1.0 + 1e-4))


def _near(price: float, level: float, tol: float = 0.004) -> bool:
    if price <= 0 or level <= 0:
        return False
    return abs(price - level) / price <= tol or abs(price - level) / level <= tol


def hunter_trend_return(df: pd.DataFrame, lookback: int) -> float | None:
    """信号 K 前 lookback 根（不含信号根）的累计涨跌幅 %；历史不足返回 None。"""
    idx = len(df) - 1
    start = idx - int(lookback)
    if start < 0 or idx <= 0:
        return None
    base = float(df.iloc[start]["close"])
    ref = float(df.iloc[idx - 1]["close"])
    if base <= 0:
        return None
    return (ref - base) / base * 100.0


def close_in_bb_upper_zone(row: pd.Series) -> bool:
    """收盘位于 BB 上轨区（basis + 0.85×带宽），对齐卡片射击之星位置过滤。"""
    basis = float(row["bb_basis"]) if pd.notna(row.get("bb_basis")) else 0.0
    upper = float(row["bb_upper"]) if pd.notna(row.get("bb_upper")) else 0.0
    width = upper - basis
    if width <= 0:
        return False
    return float(row["close"]) >= basis + width * 0.85


def close_below_bb_mid(row: pd.Series) -> bool:
    """收盘位于布林中轨之下（对齐卡片倒锤子 §4.2 口径）。"""
    basis = float(row["bb_basis"]) if pd.notna(row.get("bb_basis")) else 0.0
    return basis > 0 and float(row["close"]) < basis


def evaluate_hunter_entry(
    df: pd.DataFrame,
    *,
    structure: dict[str, Any],
    interval: str | None = None,
) -> SandboxSignal | None:
    """模块一：短线猎手 — 布林极限 + 射击之星 / 倒锤·锤子。

    2026-09 对齐卡片高胜率调优：射击之星做空须收盘在 BB 上轨区或近 Vegas 通道，
    且信号前有累计上涨；倒锤/锤子做多须收盘在中轨之下，且信号前有累计下跌。
    """
    iv = normalize_sandbox_interval(interval)
    last = df.iloc[-1]
    price = float(last["close"])
    high = float(last["high"])
    low = float(last["low"])
    bb_u = float(last["bb_upper"]) if pd.notna(last.get("bb_upper")) else 0.0
    bb_l = float(last["bb_lower"]) if pd.notna(last.get("bb_lower")) else 0.0
    bb_m = float(last["bb_basis"]) if pd.notna(last.get("bb_basis")) else 0.0
    atr = float(last["atr14"]) if pd.notna(last.get("atr14")) else 0.0
    lh = float(structure.get("lh_price") or structure.get("lh") or 0)
    hl = float(structure.get("hl") or 0)

    touch_up = bb_u > 0 and (high >= bb_u * 0.998 or _near(high, bb_u, 0.003))
    touch_lh = lh > 0 and (high >= lh * 0.998 or _near(high, lh, 0.004))
    touch_dn = bb_l > 0 and (low <= bb_l * 1.002 or _near(low, bb_l, 0.003))
    touch_hl = hl > 0 and (low <= hl * 1.002 or _near(low, hl, 0.004))

    if (touch_up or touch_lh) and detect_shooting_star(last):
        pos_ok = (not SANDBOX_HUNTER_REQUIRE_POSITION) or (
            close_in_bb_upper_zone(last) or near_vegas_channel(last)
        )
        trend_pct = hunter_trend_return(df, SANDBOX_HUNTER_SHOOT_TREND_LOOKBACK)
        trend_ok = trend_pct is not None and trend_pct >= SANDBOX_HUNTER_SHOOT_TREND_MIN_PCT
        if pos_ok and trend_ok:
            sl = hunter_sl("SHORT", high, low)
            filter_note = []
            if close_in_bb_upper_zone(last):
                filter_note.append("上轨区")
            if near_vegas_channel(last):
                filter_note.append("近Vegas")
            if trend_pct is not None:
                filter_note.append(f"前涨{trend_pct:.1f}%")
            note = " · ".join(filter_note)
            msg = f"短线猎手做空 · {iv} · 射击之星({note}) · SL={sl:.6g}"
            return SandboxSignal(
                action="enter",
                side="SHORT",
                logic="S",
                price=price,
                sl=sl,
                tp1=bb_m if bb_m > 0 else None,
                message=msg,
                meta={
                    **entry_meta_common("S", msg, interval=iv),
                    "module": "hunter",
                    "module_label": "短线猎手",
                    "signal_high": high,
                    "signal_low": low,
                    "atr": atr,
                    "bb_mid": bb_m,
                    "position_ok": bool(pos_ok),
                    "near_vegas": bool(near_vegas_channel(last)),
                    "trend_pct": trend_pct,
                    "initial_sl": sl,
                    "stage": 0,
                },
            )

    hammerish = detect_inverted_hammer(last) or detect_hammer(last)
    if (touch_dn or touch_hl) and hammerish:
        trend_pct = hunter_trend_return(df, SANDBOX_HUNTER_HAMMER_TREND_LOOKBACK)
        trend_ok = trend_pct is not None and trend_pct <= -SANDBOX_HUNTER_HAMMER_TREND_MIN_PCT
        below_mid_check = SANDBOX_HUNTER_HAMMER_BELOW_MID
        below_mid = close_below_bb_mid(last) if below_mid_check else True
        if trend_ok and below_mid:
            sl = hunter_sl("LONG", high, low)
            filter_note = []
            if below_mid_check:
                filter_note.append("中轨下")
            if trend_pct is not None:
                filter_note.append(f"前跌{abs(trend_pct):.1f}%")
            note = " · ".join(filter_note)
            shape = "倒锤" if detect_inverted_hammer(last) else "锤子"
            msg = f"短线猎手做多 · {iv} · {shape}({note}) · SL={sl:.6g}"
            return SandboxSignal(
                action="enter",
                side="LONG",
                logic="S",
                price=price,
                sl=sl,
                tp1=bb_m if bb_m > 0 else None,
                message=msg,
                meta={
                    **entry_meta_common("S", msg, interval=iv),
                    "module": "hunter",
                    "module_label": "短线猎手",
                    "signal_high": high,
                    "signal_low": low,
                    "atr": atr,
                    "bb_mid": bb_m,
                    "below_mid": bool(below_mid),
                    "trend_pct": trend_pct,
                    "initial_sl": sl,
                    "stage": 0,
                },
            )
    return None


def evaluate_trend_entry(
    df: pd.DataFrame,
    *,
    status: str,
    structure: dict[str, Any],
    interval: str | None = None,
) -> SandboxSignal | None:
    """模块二：长线维加斯 — 顺势回踩过滤线/隧道 + 阳线反包或 HL/LH。"""
    iv = normalize_sandbox_interval(interval)
    last = df.iloc[-1]
    prev = df.iloc[-2]
    price = float(last["close"])
    low = float(last["low"])
    high = float(last["high"])
    filt = float(last["vegas_filter"]) if pd.notna(last.get("vegas_filter")) else 0.0
    e1 = float(last["vegas_e1"]) if pd.notna(last.get("vegas_e1")) else 0.0
    e2 = float(last["vegas_e2"]) if pd.notna(last.get("vegas_e2")) else 0.0
    tunnel_lo = min(e1, e2) if e1 and e2 else e1 or e2
    tunnel_hi = max(e1, e2) if e1 and e2 else e1 or e2
    hl = float(structure.get("hl") or 0)
    lh = float(structure.get("lh_price") or structure.get("lh") or 0)

    if status == "BULL" and filt > 0:
        touched = low <= filt * 1.002 or (tunnel_lo > 0 and low <= tunnel_lo * 1.002)
        reclaimed = price >= filt or (tunnel_lo > 0 and price >= tunnel_lo)
        confirm = detect_bullish_engulf(last, prev) or (
            hl > 0 and low <= hl * 1.01 and price > hl
        )
        if touched and reclaimed and confirm:
            sl = trend_sl_long(price, hl, e2 or tunnel_lo)
            atr = float(last["atr14"]) if pd.notna(last.get("atr14")) else 0.0
            msg = f"长线回踩做多 · {iv} · SL={sl:.6g}"
            return SandboxSignal(
                action="enter",
                side="LONG",
                logic="T",
                price=price,
                sl=sl,
                message=msg,
                meta={
                    **entry_meta_common("T", msg, interval=iv),
                    "module": "trend",
                    "module_label": "长线维加斯",
                    "filter": filt,
                    "ema169": e2,
                    "hl": hl,
                    "atr": atr,
                    "initial_sl": sl,
                    "stage": 0,
                    "be_price_pct": SANDBOX_TREND_BE_PRICE_PCT,
                    "partial_price_pct": SANDBOX_TREND_PARTIAL_PRICE_PCT,
                    "partial_frac": SANDBOX_TREND_PARTIAL_FRAC,
                    "trail_pct": SANDBOX_TREND_TRAIL_PCT,
                },
            )

    if status == "BEAR" and filt > 0:
        touched = high >= filt * 0.998 or (tunnel_hi > 0 and high >= tunnel_hi * 0.998)
        rejected = price <= filt or (tunnel_hi > 0 and price <= tunnel_hi)
        confirm = detect_bearish_engulf(last, prev) or (
            lh > 0 and high >= lh * 0.99 and price < lh
        )
        if touched and rejected and confirm:
            sl = trend_sl_short(price, lh, e2 or tunnel_hi)
            atr = float(last["atr14"]) if pd.notna(last.get("atr14")) else 0.0
            msg = f"长线回抽做空 · {iv} · SL={sl:.6g}"
            return SandboxSignal(
                action="enter",
                side="SHORT",
                logic="T",
                price=price,
                sl=sl,
                message=msg,
                meta={
                    **entry_meta_common("T", msg, interval=iv),
                    "module": "trend",
                    "module_label": "长线维加斯",
                    "filter": filt,
                    "ema169": e2,
                    "lh": lh,
                    "atr": atr,
                    "initial_sl": sl,
                    "stage": 0,
                    "be_price_pct": SANDBOX_TREND_BE_PRICE_PCT,
                    "partial_price_pct": SANDBOX_TREND_PARTIAL_PRICE_PCT,
                    "partial_frac": SANDBOX_TREND_PARTIAL_FRAC,
                    "trail_pct": SANDBOX_TREND_TRAIL_PCT,
                },
            )
    return None


def evaluate_entry(
    df: pd.DataFrame,
    *,
    symbol: str,
    structure: dict[str, Any] | None = None,
    interval: str | None = None,
) -> SandboxSignal | None:
    """Trend_Status 分流：RANGE→S，BULL/BEAR→T；再经 Vegas 蓝红方向门控。"""
    if len(df) < 60:
        return None
    iv = normalize_sandbox_interval(interval)
    structure = structure or {}
    status = trend_status(df)
    direction = vegas_direction(df)
    structure = {
        **structure,
        "trend_status": status,
        "vegas_direction": direction,
        "symbol": symbol.upper(),
    }
    if status == "RANGE":
        sig = evaluate_hunter_entry(df, structure=structure, interval=iv)
    else:
        sig = evaluate_trend_entry(df, status=status, structure=structure, interval=iv)
    sig = annotate_entry_trend_meta(sig, status=status, direction=direction)
    sig = gate_entry_by_vegas(sig, direction)
    return apply_entry_sl_cap(symbol, sig) if sig else None


def build_manual_entry_signal(
    df: pd.DataFrame,
    *,
    symbol: str,
    logic: str,
    side: str,
    structure: dict[str, Any] | None = None,
    market_price: float | None = None,
    interval: str | None = None,
) -> SandboxSignal | None:
    """
    手动市价进场：不校验形态扳机，按所选逻辑/方向用最新价开仓，
    并按该逻辑规则计算初始止损（仍走后续阶梯/分阶段出场）。
    """
    if len(df) < 30:
        return None
    logic = logic.strip().upper()
    side = side.strip().upper()
    if logic not in ("S", "T") or side not in ("LONG", "SHORT"):
        return None
    iv = normalize_sandbox_interval(interval)

    structure = structure or {}
    last = df.iloc[-1]
    price = float(market_price) if market_price and market_price > 0 else float(last["close"])
    high = float(last["high"])
    low = float(last["low"])
    bb_m = float(last["bb_basis"]) if pd.notna(last.get("bb_basis")) else 0.0
    atr = float(last["atr14"]) if pd.notna(last.get("atr14")) else 0.0
    e2 = float(last["vegas_e2"]) if pd.notna(last.get("vegas_e2")) else 0.0
    e1 = float(last["vegas_e1"]) if pd.notna(last.get("vegas_e1")) else 0.0
    tunnel_lo = min(e1, e2) if e1 and e2 else e1 or e2
    tunnel_hi = max(e1, e2) if e1 and e2 else e1 or e2
    hl = float(structure.get("hl") or 0)
    lh = float(structure.get("lh_price") or structure.get("lh") or 0)
    status = trend_status(df)
    direction = vegas_direction(df)

    if logic == "S":
        sl = hunter_sl(side, high, low)
        # 市价入场时信号 K 极值可能已远离；保证 SL 在入场不利侧至少有垫
        if side == "LONG":
            sl = min(sl, price * (1.0 - SANDBOX_HUNTER_SL_PAD))
        else:
            sl = max(sl, price * (1.0 + SANDBOX_HUNTER_SL_PAD))
        label = "短线猎手"
        module = "hunter"
        msg = f"手动市价 · {label}{'做多' if side == 'LONG' else '做空'} · {iv} · SL={sl:.6g}"
        meta = {
            **entry_meta_common("S", msg, source="manual", interval=iv),
            "module": module,
            "module_label": label,
            "signal_high": high,
            "signal_low": low,
            "atr": atr,
            "bb_mid": bb_m,
            "initial_sl": sl,
            "stage": 0,
            "trend_status": status,
        }
        sig = annotate_entry_trend_meta(
            SandboxSignal(
                action="enter",
                side=side,
                logic="S",
                price=price,
                sl=sl,
                tp1=bb_m if bb_m > 0 else None,
                message=msg,
                meta=meta,
            ),
            status=status,
            direction=direction,
        )
        return apply_entry_sl_cap(symbol, sig)

    # logic T
    if side == "LONG":
        sl = trend_sl_long(price, hl, e2 or tunnel_lo)
    else:
        sl = trend_sl_short(price, lh, e2 or tunnel_hi)
    label = "长线维加斯"
    msg = f"手动市价 · {label}{'做多' if side == 'LONG' else '做空'} · {iv} · SL={sl:.6g}"
    meta = {
        **entry_meta_common("T", msg, source="manual", interval=iv),
        "module": "trend",
        "module_label": label,
        "filter": float(last["vegas_filter"]) if pd.notna(last.get("vegas_filter")) else 0.0,
        "ema169": e2,
        "hl": hl,
        "lh": lh,
        "atr": atr,
        "initial_sl": sl,
        "stage": 0,
        "be_price_pct": SANDBOX_TREND_BE_PRICE_PCT,
        "partial_price_pct": SANDBOX_TREND_PARTIAL_PRICE_PCT,
        "partial_frac": SANDBOX_TREND_PARTIAL_FRAC,
        "trail_pct": SANDBOX_TREND_TRAIL_PCT,
        "trend_status": status,
    }
    sig = annotate_entry_trend_meta(
        SandboxSignal(
            action="enter",
            side=side,
            logic="T",
            price=price,
            sl=sl,
            message=msg,
            meta=meta,
        ),
        status=status,
        direction=direction,
    )
    return apply_entry_sl_cap(symbol, sig)


def _bars_held(entry_time: int, bar_time: int, interval_sec: int) -> int:
    if entry_time <= 0 or bar_time <= 0 or interval_sec <= 0:
        return 0
    if bar_time <= entry_time:
        return 0
    return max(0, (bar_time - entry_time) // interval_sec)


def _price_pnl_pct(side: str, entry: float, px: float) -> float:
    if entry <= 0:
        return 0.0
    if side == "LONG":
        return (px - entry) / entry * 100.0
    return (entry - px) / entry * 100.0


# 出场原因码 → 中文（便于复盘改进）
EXIT_REASON_LABELS: dict[str, str] = {
    "sl": "硬止损",
    "step_sl": "阶梯锁定止损",
    "bb_mid": "布林中轨止盈",
    "atr2": "ATR止盈",
    "trail": "跟踪止损",
    "partial": "阶段减仓",
    "breakeven": "保本移损",
    "step_trail": "阶梯移止损",
    "card_sl": "卡片止损",
    "card_tp": "卡片止盈",
    "card_tp_partial": "卡片分批止盈",
    "card_tp1_be": "卡片TP1后保本",
    "card_invalid": "卡片数据异常作废",
    "manual": "手动平仓",
    "manual_partial": "手动减仓",
    "max_hold": "持仓超期强平",
    "absurd_exit": "离谱价差拒记",
}


def evaluate_card_exit(
    df: pd.DataFrame,
    *,
    side: str,
    entry_price: float,
    sl: float,
    tps: list[float] | None = None,
    tp1: float | None = None,
    tp2: float | None = None,
    meta: dict[str, Any] | None = None,
) -> list[SandboxSignal]:
    """
    卡片仓出场：严格按卡片 SL / 多级 TP。
    - 触及 SL → 全平
    - 多级 TP：依次减仓（等分），最后一级全平
    - **第一止盈（TP1）触发后**：剩余仓止损移至开仓价（保本），防回吐
    - 不做阶梯/维加斯移损
    """
    if df is None or df.empty:
        return []
    last = df.iloc[-1]
    high = float(last["high"])
    low = float(last["low"])
    close = float(last["close"])
    side_u = side.upper()
    meta = dict(meta or {})
    entry = float(entry_price) if entry_price and float(entry_price) > 0 else 0.0
    levels: list[float] = []
    for x in tps or meta.get("card_tps") or []:
        try:
            v = float(x)
            if v > 0:
                levels.append(v)
        except (TypeError, ValueError):
            continue
    if not levels:
        for x in (tp1, tp2, meta.get("tp3")):
            if x is not None and float(x) > 0:
                levels.append(float(x))
    # 方向排序：多单 TP 升序，空单 TP 降序
    if side_u == "LONG":
        levels = sorted(set(levels))
    else:
        levels = sorted(set(levels), reverse=True)

    done = int(meta.get("card_tp_done") or 0)
    out: list[SandboxSignal] = []

    # 硬止损优先（先校验 SL 同侧 + 量级，防错位小数立刻「打止损」记神单）
    sl_v = float(sl) if sl and float(sl) > 0 else 0.0
    if sl_v > 0 and entry > 0:
        ok_sl, sl_err = validate_card_levels(side_u, entry, sl_v, None)
        if not ok_sl:
            out.append(
                SandboxSignal(
                    action="exit",
                    side=side_u,
                    logic="C",
                    price=float(entry),
                    sl=sl_v,
                    message=f"卡片数据异常作废 · {sl_err}",
                    meta={
                        "exit_code": "card_invalid",
                        "exit_label": exit_reason_label("card_invalid"),
                        "card_id": meta.get("card_id"),
                        "reject_reason": sl_err,
                        "void_trade": True,
                    },
                )
            )
            return out

    sl_hit = (side_u == "LONG" and low <= sl_v) or (
        side_u == "SHORT" and high >= sl_v
    )
    if sl_hit and sl_v > 0:
        out.append(
            SandboxSignal(
                action="exit",
                side=side_u,
                logic="C",
                price=float(sl_v),
                sl=float(sl_v),
                message=f"卡片止损 SL={sl_v:.6g}",
                meta={
                    "exit_code": "card_sl",
                    "exit_label": exit_reason_label("card_sl"),
                    "card_id": meta.get("card_id"),
                },
            )
        )
        return out

    remaining_levels = levels[done:]
    if not remaining_levels:
        return out

    # 过滤离谱 TP，避免按错价减仓
    sane_levels: list[float] = []
    for tp in remaining_levels:
        ok_tp, _ = validate_card_levels(side_u, entry, None, [tp])
        if ok_tp:
            sane_levels.append(tp)
    remaining_levels = sane_levels
    if not remaining_levels:
        return out

    hit_idx = None
    for i, tp in enumerate(remaining_levels):
        if side_u == "LONG" and high >= tp:
            hit_idx = i
            break
        if side_u == "SHORT" and low <= tp:
            hit_idx = i
            break
    if hit_idx is None:
        return out

    # 一根 K 可能越过多个 TP：按顺序处理到最远触及档
    # 简化：只处理第一档；若只剩一档则全平
    tp = remaining_levels[0]
    next_done = done + 1
    is_last = next_done >= len(levels)
    if is_last or len(levels) == 1:
        out.append(
            SandboxSignal(
                action="exit",
                side=side_u,
                logic="C",
                price=float(tp),
                sl=float(sl) if sl else None,
                message=f"卡片止盈 TP={tp:.6g}",
                meta={
                    "exit_code": "card_tp",
                    "exit_label": exit_reason_label("card_tp"),
                    "card_id": meta.get("card_id"),
                    "card_tp_done": next_done,
                },
            )
        )
        return out

    # 分批：按剩余档数等分当前仓；TP1 后把止损移到开仓价保本
    left_levels = len(levels) - done
    frac = 1.0 / max(left_levels, 1)
    is_first_tp = done == 0
    be_sl = entry if is_first_tp and entry > 0 else (float(sl) if sl else None)
    msg = f"卡片分批止盈 TP={tp:.6g} · {frac:.0%}"
    if is_first_tp and be_sl:
        msg = f"{msg} · SL→开仓价 {be_sl:.6g}"
    out.append(
        SandboxSignal(
            action="partial",
            side=side_u,
            logic="C",
            price=float(tp),
            sl=float(be_sl) if be_sl else (float(sl) if sl else None),
            message=msg,
            meta={
                "exit_code": "card_tp_partial",
                "exit_label": exit_reason_label("card_tp_partial"),
                "card_id": meta.get("card_id"),
                "card_tp_done": next_done,
                "partial_frac": frac,
                "move_sl_to_entry": bool(is_first_tp and be_sl),
                "breakeven_sl": float(be_sl) if be_sl else None,
            },
        )
    )
    return out



def exit_reason_label(code: str, fallback: str = "") -> str:
    c = str(code or "").strip().lower()
    return EXIT_REASON_LABELS.get(c) or fallback or c or "未知出场"


def _soft_tp_allowed(
    *,
    held: int,
    side: str,
    entry_price: float,
    price: float,
) -> bool:
    """
    主动止盈门槛（防入场后立刻被中轨/ATR打出）：
    - 至少持仓 MIN_HOLD 根已收盘 K
    - 收盘价相对入场已有 SOFT_EXIT_MIN_MOVE_PCT 以上有利波动
    硬止损不受此限。
    """
    if held < max(1, SANDBOX_MIN_HOLD_BARS):
        return False
    return _price_pnl_pct(side, entry_price, price) >= SANDBOX_SOFT_EXIT_MIN_MOVE_PCT


def _exit_meta(reason: str, event: str, message: str, **extra: Any) -> dict[str, Any]:
    label = exit_reason_label(reason, message)
    out = {
        "reason": reason,
        "event": event,
        "exit_code": reason,
        "exit_label": label,
        "message": message,
    }
    out.update(extra)
    return out


def _step_trail_sl(
    side: str,
    entry: float,
    peak_px: float,
    *,
    profit_step_pct: float = SANDBOX_STEP_TRAIL_PROFIT_PCT,
    sl_lift_pct: float = SANDBOX_STEP_TRAIL_SL_LIFT_PCT,
) -> tuple[int, float | None]:
    """
    阶梯上移止损：峰值盈利每满 profit_step_pct（默认 2.2%），
    相对入场价锁定 steps × sl_lift_pct（默认每档 +1%）。
    返回 (steps, target_sl)；steps<1 时 target_sl 为 None。
    """
    if entry <= 0 or peak_px <= 0 or profit_step_pct <= 0 or sl_lift_pct <= 0:
        return 0, None
    peak_pnl = _price_pnl_pct(side, entry, peak_px)
    steps = int(peak_pnl // profit_step_pct)
    if steps < 1:
        return 0, None
    lock_pct = steps * sl_lift_pct
    if side == "LONG":
        return steps, entry * (1.0 + lock_pct / 100.0)
    return steps, entry * (1.0 - lock_pct / 100.0)


def _improve_sl(side: str, current: float, candidate: float | None) -> float:
    if candidate is None or candidate <= 0:
        return current
    if side == "LONG":
        return max(current, candidate)
    return min(current, candidate)


def evaluate_exit_and_trail(
    df: pd.DataFrame,
    *,
    side: str,
    logic: str,
    entry_price: float,
    sl: float,
    tp1: float | None,
    tp2: float | None,
    breakeven_armed: bool,
    structure: dict[str, Any] | None = None,
    entry_time: int = 0,
    bar_time: int = 0,
    interval_sec: int = 900,
    meta: dict[str, Any] | None = None,
) -> list[SandboxSignal]:
    """
    平仓/阶段管理：
    - 硬止损（入场当根不触发；不受最短持仓限制）
    - 通用阶梯：峰值盈利每满 2.2% → 相对入场锁定 +1% SL（可叠加）
    - S：中轨或 2×ATR 全平（需最短持仓 + 最小有利波动，用收盘价判定中轨）
    - T：阶段1保本 → 阶段2减仓30% → 阶段3跟踪1%
    """
    del tp2  # 短线只用中轨/ATR；长线用状态机
    if len(df) < 3:
        return []
    structure = structure or {}
    meta = dict(meta or {})
    last = df.iloc[-1]
    price = float(last["close"])
    high = float(last["high"])
    low = float(last["low"])
    out: list[SandboxSignal] = []
    held = _bars_held(entry_time, bar_time, interval_sec)
    if held <= 0:
        return out

    incoming_sl = float(sl)

    # —— 硬止损 ——
    if side == "LONG" and low <= incoming_sl:
        msg = f"硬止损 · 持仓{held}根 · SL={incoming_sl:.6g}"
        out.append(
            SandboxSignal(
                action="exit",
                side=side,
                logic=logic,
                price=incoming_sl,
                message=msg,
                meta=_exit_meta("sl", "exit_sl", msg, held_bars=held),
            )
        )
        return out
    if side == "SHORT" and high >= incoming_sl:
        msg = f"硬止损 · 持仓{held}根 · SL={incoming_sl:.6g}"
        out.append(
            SandboxSignal(
                action="exit",
                side=side,
                logic=logic,
                price=incoming_sl,
                message=msg,
                meta=_exit_meta("sl", "exit_sl", msg, held_bars=held),
            )
        )
        return out

    atr = float(last["atr14"]) if pd.notna(last.get("atr14")) else float(meta.get("atr") or 0)
    bb_m = float(last["bb_basis"]) if pd.notna(last.get("bb_basis")) else float(
        meta.get("bb_mid") or (tp1 or 0)
    )
    stage = int(meta.get("stage") or 0)
    partial_done = bool(meta.get("partial_done"))
    soft_ok = _soft_tp_allowed(
        held=held, side=side, entry_price=entry_price, price=price
    )

    highest = float(meta.get("highest_price") or entry_price)
    lowest = float(meta.get("lowest_price") or entry_price)
    if side == "LONG":
        highest = max(highest, high)
    else:
        lowest = min(lowest, low)

    peak_px = highest if side == "LONG" else lowest
    step_n, step_sl = _step_trail_sl(side, entry_price, peak_px)
    prev_steps = int(meta.get("step_trail_level") or 0)
    working_sl = _improve_sl(side, incoming_sl, step_sl)
    step_upgraded = step_n > prev_steps and (
        (side == "LONG" and working_sl > incoming_sl * 1.0005)
        or (side == "SHORT" and working_sl < incoming_sl * 0.9995)
    )

    def _sync_meta(**extra: Any) -> dict[str, Any]:
        base = {
            "highest_price": highest,
            "lowest_price": lowest,
            "step_trail_level": max(prev_steps, step_n),
            "held_bars": held,
        }
        base.update(extra)
        return base

    def _emit_step_trail(new_sl: float) -> SandboxSignal:
        msg = (
            f"阶梯移止损 · 峰值盈利≥{step_n * SANDBOX_STEP_TRAIL_PROFIT_PCT:.1f}% "
            f"→ 锁定+{step_n * SANDBOX_STEP_TRAIL_SL_LIFT_PCT:.1f}% · SL→{new_sl:.6g}"
        )
        return SandboxSignal(
            action="trail",
            side=side,
            logic=logic,
            price=price,
            sl=new_sl,
            message=msg,
            meta=_sync_meta(
                **_exit_meta("step_trail", "trail_update", msg, breakeven_armed=True)
            ),
        )

    # —— 短线猎手 S ——
    if logic == "S":
        if step_upgraded:
            out.append(_emit_step_trail(working_sl))
            if side == "LONG" and low <= working_sl:
                msg = f"阶梯锁定止损 · 持仓{held}根 · SL={working_sl:.6g}"
                out.append(
                    SandboxSignal(
                        action="exit",
                        side=side,
                        logic=logic,
                        price=working_sl,
                        message=msg,
                        meta=_sync_meta(**_exit_meta("step_sl", "exit_sl", msg)),
                    )
                )
                return out
            if side == "SHORT" and high >= working_sl:
                msg = f"阶梯锁定止损 · 持仓{held}根 · SL={working_sl:.6g}"
                out.append(
                    SandboxSignal(
                        action="exit",
                        side=side,
                        logic=logic,
                        price=working_sl,
                        message=msg,
                        meta=_sync_meta(**_exit_meta("step_sl", "exit_sl", msg)),
                    )
                )
                return out
        # 主动止盈：最短持仓 + 最小有利波动；中轨用收盘价（避免影线秒平）
        if soft_ok and bb_m > 0:
            if side == "LONG" and price >= bb_m:
                msg = (
                    f"布林中轨止盈 · 持仓{held}根 · 收盘触及中轨 "
                    f"(≥{SANDBOX_SOFT_EXIT_MIN_MOVE_PCT:g}%有利)"
                )
                out.append(
                    SandboxSignal(
                        action="exit",
                        side=side,
                        logic=logic,
                        price=price,
                        message=msg,
                        meta=_exit_meta("bb_mid", "exit_tp", msg, held_bars=held),
                    )
                )
                return out
            if side == "SHORT" and price <= bb_m:
                msg = (
                    f"布林中轨止盈 · 持仓{held}根 · 收盘触及中轨 "
                    f"(≥{SANDBOX_SOFT_EXIT_MIN_MOVE_PCT:g}%有利)"
                )
                out.append(
                    SandboxSignal(
                        action="exit",
                        side=side,
                        logic=logic,
                        price=price,
                        message=msg,
                        meta=_exit_meta("bb_mid", "exit_tp", msg, held_bars=held),
                    )
                )
                return out
        if soft_ok and atr > 0 and entry_price > 0:
            move = abs(price - entry_price)
            if move >= atr * SANDBOX_HUNTER_ATR_MULT and _price_pnl_pct(
                side, entry_price, price
            ) > 0:
                msg = (
                    f"ATR止盈 · 持仓{held}根 · 有利波动≥{SANDBOX_HUNTER_ATR_MULT:.0f}×ATR"
                )
                out.append(
                    SandboxSignal(
                        action="exit",
                        side=side,
                        logic=logic,
                        price=price,
                        message=msg,
                        meta=_exit_meta("atr2", "exit_tp", msg, held_bars=held),
                    )
                )
                return out
        if out:
            return out
        out.append(
            SandboxSignal(
                action="trail",
                side=side,
                logic=logic,
                price=price,
                sl=working_sl,
                message="",
                meta=_sync_meta(reason="extreme_sync", event="sync", silent=True),
            )
        )
        return out

    # —— 长线维加斯 T：分阶段 ——
    if logic != "T":
        return out

    be_pct = float(meta.get("be_price_pct") or SANDBOX_TREND_BE_PRICE_PCT)
    partial_pct = float(meta.get("partial_price_pct") or SANDBOX_TREND_PARTIAL_PRICE_PCT)
    partial_frac = float(meta.get("partial_frac") or SANDBOX_TREND_PARTIAL_FRAC)
    trail_pct = float(meta.get("trail_pct") or SANDBOX_TREND_TRAIL_PCT) / 100.0
    pnl_now = _price_pnl_pct(side, entry_price, price)

    # 阶段 3：跟踪止损（已减仓后）— 与阶梯锁利取更优
    if partial_done or stage >= 2:
        if side == "LONG":
            trail_sl = _improve_sl(side, highest * (1.0 - trail_pct), step_sl)
            if low <= trail_sl:
                msg = f"跟踪止损 · 持仓{held}根 · SL={trail_sl:.6g}"
                out.append(
                    SandboxSignal(
                        action="exit",
                        side=side,
                        logic=logic,
                        price=trail_sl,
                        message=msg,
                        meta=_sync_meta(**_exit_meta("trail", "exit_trail", msg)),
                    )
                )
                return out
            if step_upgraded or abs(trail_sl - incoming_sl) / max(incoming_sl, 1e-12) >= 0.0005:
                reason = "step_trail" if step_upgraded else "trailing_update"
                msg = (
                    f"阶梯移止损 · 峰值≥{step_n * SANDBOX_STEP_TRAIL_PROFIT_PCT:.1f}% "
                    f"锁定+{step_n * SANDBOX_STEP_TRAIL_SL_LIFT_PCT:.1f}% · SL→{trail_sl:.6g}"
                    if step_upgraded
                    else f"跟踪移止损 · SL→{trail_sl:.6g}"
                )
                out.append(
                    SandboxSignal(
                        action="trail",
                        side=side,
                        logic=logic,
                        price=price,
                        sl=trail_sl,
                        message=msg,
                        meta=_sync_meta(
                            reason=reason,
                            event="trail_update",
                            exit_code=reason,
                            exit_label=exit_reason_label(reason, msg),
                            breakeven_armed=True,
                        ),
                    )
                )
                return out
            out.append(
                SandboxSignal(
                    action="trail",
                    side=side,
                    logic=logic,
                    price=price,
                    sl=working_sl,
                    message="",
                    meta=_sync_meta(
                        reason="extreme_sync",
                        event="sync",
                        silent=True,
                    ),
                )
            )
            return out
        # SHORT
        trail_sl = _improve_sl(side, lowest * (1.0 + trail_pct), step_sl)
        if high >= trail_sl:
            msg = f"跟踪止损 · 持仓{held}根 · SL={trail_sl:.6g}"
            out.append(
                SandboxSignal(
                    action="exit",
                    side=side,
                    logic=logic,
                    price=trail_sl,
                    message=msg,
                    meta=_sync_meta(**_exit_meta("trail", "exit_trail", msg)),
                )
            )
            return out
        if step_upgraded or abs(trail_sl - incoming_sl) / max(incoming_sl, 1e-12) >= 0.0005:
            reason = "step_trail" if step_upgraded else "trailing_update"
            msg = (
                f"阶梯移止损 · 峰值≥{step_n * SANDBOX_STEP_TRAIL_PROFIT_PCT:.1f}% "
                f"锁定+{step_n * SANDBOX_STEP_TRAIL_SL_LIFT_PCT:.1f}% · SL→{trail_sl:.6g}"
                if step_upgraded
                else f"跟踪移止损 · SL→{trail_sl:.6g}"
            )
            out.append(
                SandboxSignal(
                    action="trail",
                    side=side,
                    logic=logic,
                    price=price,
                    sl=trail_sl,
                    message=msg,
                    meta=_sync_meta(
                        reason=reason,
                        event="trail_update",
                        exit_code=reason,
                        exit_label=exit_reason_label(reason, msg),
                        breakeven_armed=True,
                    ),
                )
            )
            return out
        out.append(
            SandboxSignal(
                action="trail",
                side=side,
                logic=logic,
                price=price,
                sl=working_sl,
                message="",
                meta=_sync_meta(
                    reason="extreme_sync",
                    event="sync",
                    silent=True,
                ),
            )
        )
        return out


    # 阶段 2：减仓 30%（同样要求最短持仓，避免刚进场就减）
    if not partial_done and soft_ok and pnl_now >= partial_pct:
        msg = f"阶段减仓 · 持仓{held}根 · 价变≥{partial_pct}% 减仓{partial_frac*100:.0f}%"
        out.append(
            SandboxSignal(
                action="partial",
                side=side,
                logic=logic,
                price=price,
                message=msg,
                meta=_sync_meta(
                    **_exit_meta("partial", "partial_tp", msg),
                    partial_frac=partial_frac,
                    stage=2,
                    partial_done=True,
                    breakeven_armed=True,
                ),
            )
        )
        be_sl = entry_price * (1.0 - 1e-6) if side == "LONG" else entry_price * (1.0 + 1e-6)
        if side == "LONG":
            new_sl = max(working_sl, be_sl, highest * (1.0 - trail_pct))
        else:
            new_sl = min(working_sl, be_sl, lowest * (1.0 + trail_pct))
        out.append(
            SandboxSignal(
                action="trail",
                side=side,
                logic=logic,
                price=price,
                sl=new_sl,
                message=f"减仓后开启跟踪 · SL→{new_sl:.6g}",
                meta=_sync_meta(
                    reason="post_partial_trail",
                    event="trail_update",
                    exit_code="trail",
                    exit_label=exit_reason_label("trail"),
                    stage=2,
                    partial_done=True,
                    breakeven_armed=True,
                ),
            )
        )
        return out

    # 阶梯上移（未进尾仓跟踪前也生效）
    if step_upgraded:
        out.append(_emit_step_trail(working_sl))
        return out

    # 阶段 1：保本
    if not breakeven_armed and stage < 1 and pnl_now >= be_pct:
        be_sl = entry_price * (1.0 - 1e-6) if side == "LONG" else entry_price * (1.0 + 1e-6)
        be_sl = _improve_sl(side, be_sl, step_sl)
        improve = (side == "LONG" and be_sl > incoming_sl * 1.0001) or (
            side == "SHORT" and be_sl < incoming_sl * 0.9999
        )
        if improve:
            msg = f"保本移损 · 持仓{held}根 · 价变≥{be_pct}% 止损移至保本/阶梯"
            out.append(
                SandboxSignal(
                    action="trail",
                    side=side,
                    logic=logic,
                    price=price,
                    sl=be_sl,
                    message=msg,
                    meta=_sync_meta(
                        **_exit_meta("breakeven", "trail_be", msg),
                        stage=1,
                        breakeven_armed=True,
                    ),
                )
            )
            return out

    out.append(
        SandboxSignal(
            action="trail",
            side=side,
            logic=logic,
            price=price,
            sl=working_sl,
            message="",
            meta=_sync_meta(reason="extreme_sync", event="sync", silent=True),
        )
    )
    return out



def bar_time_sec(df: pd.DataFrame) -> int:
    return _ts_sec(int(df.iloc[-1]["open_time"]))
