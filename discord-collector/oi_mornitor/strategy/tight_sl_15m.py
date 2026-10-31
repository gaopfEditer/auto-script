"""BTC & ETH 15m 小止损策略（15m Tight Stop-Loss Resonance Strategy）.

核心设计：
- 标的与周期：主打 BTC (BTCUSDT) 与 ETH (ETHUSDT) 的 15m 级别（兼容任意 15m K 线 DataFrame）。
- 三维共振触发（满足「形态 + 支撑压力」「形态 + 均线交叉/共振」「支撑压力 + 均线交叉 + K线同向」或三者共振）：
  1) 形态（Pattern）：
     - 多头：锤子线/长下影Pinbar、阳吞阴（看涨吞没）、双针探底/连续下影、假跌破前低收回（2B破底翻）、放量反转阳线
     - 空头：射击之星/长上影Pinbar、阴吞阳（看跌吞没）、双针摸顶/连续上影、假突破前高收回（2B破顶翻）、放量反转阴线
  2) 压力支撑位（Support / Resistance）：
     - 前低/前高（近期4h/12h/24h波段高低点及已确认枢轴高低点，严格无未来函数）
     - 布林带下轨/上轨/中轨（BB Lower / Upper / Basis）
     - 维加斯通道（Vegas 144/169 隧道、576/676 大级别通道）
  3) 均线交叉与均线共振（MA Crossover & Alignment）：
     - EMA9 × EMA21 金叉/死叉（近1~3根内交叉或快线拐头站上/跌破慢线）
     - EMA13 × EMA33 金叉/死叉（近1~3根内交叉）
     - MACD 金叉/死叉或柱体翻红/翻绿（近1~2根内）
     - 回踩/站上 EMA21 / EMA55 / Vegas144 企稳或受阻
- 小止损（Tight Stop-Loss）与分批止盈（Multi-R TP）：
  - 止损锚定结构失效位：形态极值 AND 支撑/压力外侧，再加可抗 15m 噪音的 ATR 缓冲（默认 `0.45*ATR14`，区间约 `0.35~0.55*ATR`）。
  - 百分比区间（仍相对波段交易偏紧的「小止损」）：
    * BTC 15m：`0.40% ~ 1.00%`
    * ETH 15m：`0.45% ~ 1.10%`
  - 止盈按新的风险距离重算 R 倍数：
    * TP1 = `1.9R`（若前方关键阻力/支撑在 `1.6R~2.3R` 之间则微调吸附）
    * TP2 = `2.9R`
    * 跟踪规则：`浮盈达 1R 推保本；TP1 减半仓，余仓沿 15m EMA13/21 跟踪止盈`
  - 入场质量门禁：信心≥80（三维全共振可≥75）；至少 2/3 柱有实质得分；无均线时信心≥85；TP1 R:R≥1.5；强逆大周期需≥90。
- 信心指数（Confidence Index, 0~100% + 高/中/低）：
  - 基于形态质量、支撑压力精准度、均线交叉/共振、量能与OI配合、1h/4h大周期顺逆势量化打分，输出 `confidence_pct` (0~100)、`confidence` (0~1)、`confidence_band` (高/中/低) 与得分明细。
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from oi_mornitor.pattern_monitor import enrich_indicators

# --- Actionable quality + fee defaults (survive ~万4 taker fees) ---
TIGHT_SL_MIN_CONF_ENTER = 80
TIGHT_SL_MIN_CONF_THREE_PILLAR = 75
TIGHT_SL_MIN_CONF_NO_MA = 85
TIGHT_SL_MIN_RR_TP1 = 1.5
TIGHT_SL_MIN_CONF_AGAINST_HTF = 90
# ATR buffer outside structural invalidation (pattern extreme ∩ S/R)
TIGHT_SL_ATR_BUF_LO = 0.35
TIGHT_SL_ATR_BUF_HI = 0.55
TIGHT_SL_ATR_BUF_DEFAULT = 0.45
# Fee formula:
#   fee_total_pct = fee_per_side * (1 + sum(leg.size))
#   complete exit (sum size=1) → 2 * fee_per_side (e.g. 0.08%)
#   net_realized_pct = realized_pct_gross - fee_total_pct
TIGHT_SL_FEE_PCT_PER_SIDE = 0.04


def _price_decimals(price: float, symbol: str = "") -> int:
    s = (symbol or "").upper()
    if "BTC" in s or price >= 10000:
        return 1
    if "ETH" in s or price >= 500:
        return 2
    if price >= 10:
        return 3
    if price >= 1:
        return 4
    return 5


def _tight_sl_bounds(symbol: str = "") -> tuple[float, float]:
    """Return (min_sl_pct, max_sl_pct) in percent.

    Wider than pure wick-noise stops so SL sits beyond structural invalidation
    and survives normal 15m noise, while still capped as a 「小止损」 vs swing.
    """
    s = (symbol or "").upper()
    if "BTC" in s:
        return (0.40, 1.00)
    if "ETH" in s:
        return (0.45, 1.10)
    return (0.45, 1.20)



def _composite_sl_bounds(symbol: str = "", interval: str = "15m") -> tuple[float, float]:
    """Wider structural SL band for main AI / multi-TF 综合止盈止损 (not glued 0.2%).

    Still anchored to pattern extreme ∩ S/R + ATR buffer, but allows more room
    than the dedicated 15m tight-SL strategy so noise on 1h/4h does not dominate fees.
    """
    s = (symbol or "").upper()
    iv = (interval or "15m").lower()
    is_btc = "BTC" in s
    is_eth = "ETH" in s
    if iv in ("15m", "15"):
        return (0.50, 1.60) if is_btc else ((0.55, 1.80) if is_eth else (0.60, 2.00))
    if iv in ("1h", "60m", "60"):
        return (0.80, 2.50) if is_btc else ((0.90, 2.80) if is_eth else (1.00, 3.20))
    if iv in ("4h", "240"):
        return (1.20, 4.00) if is_btc else ((1.40, 4.50) if is_eth else (1.50, 5.00))
    # 1d / fallback
    return (2.00, 6.00) if is_btc else ((2.20, 6.50) if is_eth else (2.50, 7.00))


def compute_composite_trade_plan(
    df: pd.DataFrame,
    idx: int,
    *,
    side: str,
    symbol: str = "BTCUSDT",
    interval: str = "15m",
    signal_name: str = "",
    htf_trends: dict[str, Any] | None = None,
    oi_chg_pct: float | None = None,
) -> dict[str, Any]:
    """综合考量止盈止损 for original pattern/structure signals (any TF).

    Synthesizes: pattern extreme / invalidation, nearby S/R, MA/EMA/Vegas, ATR buffer.
    Always returns usable entry/sl/tp1/tp2/trail for settlement — not gated on 3-pillar
    resonance (that gate belongs to the separate 15m tight-SL strategy).
    """
    side_n = "short" if str(side or "").lower() in ("short", "bear", "sell") else "long"
    if df is None or df.empty or idx < 0 or idx >= len(df):
        return {}
    # Reuse the same structure/MA/pattern scanner; then re-clamp to composite bounds.
    ev = evaluate_bar_15m_tight_sl(
        df,
        idx,
        symbol=symbol,
        htf_trends=htf_trends,
        oi_chg_pct=oi_chg_pct,
        preferred_side=side_n,
        existing_signal_name=str(signal_name or "") or None,
    )
    if not ev:
        return {}

    c = float(ev.get("entry") or 0.0)
    if c <= 0:
        return {}
    dec = _price_decimals(c, symbol)
    min_sl, max_sl = _composite_sl_bounds(symbol, interval)
    atr = float(ev.get("atr14") or 0.0)
    atr_pct = float(ev.get("atr14_pct") or 0.0)
    # Prefer structural raw_sl if present; else rebuild from current sl then clamp.
    raw_sl_pct = float(ev.get("raw_sl_pct") or ev.get("sl_pct") or min_sl)
    # Extra ATR cushion for higher TFs (抗噪音)
    atr_extra = 0.0
    iv = (interval or "15m").lower()
    if atr > 0 and atr_pct > 0:
        mult = 0.15 if iv in ("15m", "15") else (0.25 if iv in ("1h", "60m", "60") else 0.35)
        atr_extra = atr_pct * mult
    target_sl_pct = float(np.clip(raw_sl_pct + atr_extra, min_sl, max_sl))
    if side_n == "long":
        sl_price = round(c * (1.0 - target_sl_pct / 100.0), dec)
    else:
        sl_price = round(c * (1.0 + target_sl_pct / 100.0), dec)
    risk = abs(c - sl_price)
    if risk <= 0:
        risk = c * (min_sl / 100.0)
        sl_price = round(c - risk, dec) if side_n == "long" else round(c + risk, dec)
        target_sl_pct = abs(c - sl_price) / c * 100.0

    # Rebuild TP from new risk; keep S/R snap if original tp1 already near a level
    old_tp1 = float(ev.get("tp1") or ev.get("tp") or 0.0)
    old_tp2 = float(ev.get("tp2") or 0.0)
    if side_n == "long":
        tp1 = round(c + 1.8 * risk, dec)
        tp2 = round(c + 2.8 * risk, dec)
        be = round(c + 1.0 * risk, dec)
        # Prefer original tp1 if it still sits in 1.5R~2.3R band (likely S/R snap)
        if old_tp1 > c:
            rr_old = (old_tp1 - c) / risk
            if 1.5 <= rr_old <= 2.3:
                tp1 = round(old_tp1, dec)
        if old_tp2 > tp1:
            tp2 = round(old_tp2, dec)
    else:
        tp1 = round(c - 1.8 * risk, dec)
        tp2 = round(c - 2.8 * risk, dec)
        be = round(c - 1.0 * risk, dec)
        if 0 < old_tp1 < c:
            rr_old = (c - old_tp1) / risk
            if 1.5 <= rr_old <= 2.3:
                tp1 = round(old_tp1, dec)
        if 0 < old_tp2 < tp1:
            tp2 = round(old_tp2, dec)

    tp1_pct = round(abs(tp1 - c) / c * 100.0, 2)
    tp2_pct = round(abs(tp2 - c) / c * 100.0, 2)
    rr1 = round(abs(tp1 - c) / max(risk, 1e-9), 2)
    rr2 = round(abs(tp2 - c) / max(risk, 1e-9), 2)
    sl_pct = round(abs(c - sl_price) / c * 100.0, 2)
    iv_label = interval if interval else "信号周期"
    trail = (
        f"浮盈达 1R({be}) 推保本；TP1({tp1}, +{tp1_pct:.2f}%, {rr1:.1f}R) 减半仓，"
        f"余仓沿 {iv_label} EMA13/21 移损博 TP2({tp2}, +{tp2_pct:.2f}%, {rr2:.1f}R)"
    )
    components = []
    if ev.get("patterns"):
        components.append("形态极值/" + "+".join(list(ev.get("patterns") or [])[:2]))
    if ev.get("sr_matched"):
        components.append(f"支撑压力({ev.get('sr_type')} {ev.get('sr_level')})")
    if ev.get("ma_matched") or ev.get("ma_tags"):
        components.append("均线/" + str(ev.get("ma_summary") or "+".join(ev.get("ma_tags") or []) or "EMA"))
    components.append(f"ATR缓冲({sl_pct}%)")
    out = dict(ev)
    out.update(
        {
            "strategy_id": "composite_sl_tp",
            "strategy_name": "综合止盈止损（形态极值+支撑压力+均线+ATR）",
            "plan_kind": "composite",
            "matched": True,  # levels always usable for settlement
            "should_enter": False,  # entry decision belongs to AI / gates, not this plan
            "recommended_action": "LONG" if side_n == "long" else "SHORT",
            "side": side_n,
            "interval": interval,
            "entry": round(c, dec),
            "sl": sl_price,
            "sl_pct": sl_pct,
            "tp": tp1,
            "tp1": tp1,
            "tp1_pct": tp1_pct,
            "rr1": rr1,
            "rr_tp1": rr1,
            "tp2": tp2,
            "tp2_pct": tp2_pct,
            "rr2": rr2,
            "rr_tp2": rr2,
            "breakeven_price": be,
            "trail": trail,
            "resonance_summary": "综合止盈止损（" + " + ".join(components) + "）",
            "signal_label": f"{iv_label}综合止盈止损",
            "components": components,
        }
    )
    return out


def enrich_tight_sl_df(df: pd.DataFrame) -> pd.DataFrame:
    """Enrich 15m DataFrame with EMA9/21/13/33/55, ATR14, Bollinger, MACD, Vegas.
    Strictly causal (rolling/ewm only).
    """
    if df is None or df.empty:
        return df
    if "bb_lower" not in df.columns or "vegas_e1" not in df.columns or "macd_hist" not in df.columns:
        out = enrich_indicators(df)
    else:
        out = df.copy()

    close = out["close"].astype(float)
    high = out["high"].astype(float)
    low = out["low"].astype(float)

    out["ema9"] = close.ewm(span=9, adjust=False).mean()
    out["ema21"] = close.ewm(span=21, adjust=False).mean()
    out["ema13"] = close.ewm(span=13, adjust=False).mean()
    out["ema33"] = close.ewm(span=33, adjust=False).mean()
    out["ema55"] = close.ewm(span=55, adjust=False).mean()

    prev_close = close.shift(1)
    tr = pd.concat(
        [
            (high - low).abs(),
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    out["atr14"] = tr.rolling(14, min_periods=3).mean()
    return out


def _collect_causal_sr_levels(df: pd.DataFrame, idx: int) -> tuple[list[tuple[str, float]], list[tuple[str, float]]]:
    """Return (support_levels, resistance_levels) visible at bar `idx` using ONLY bars <= idx.
    Pivot highs/lows use bars `<= idx - 2` so right-side confirmation is strictly causal (zero lookahead).
    """
    row = df.iloc[idx]
    c = float(row["close"])
    l = float(row["low"])
    h = float(row["high"])

    supports: list[tuple[str, float]] = []
    resistances: list[tuple[str, float]] = []

    # 1. Prior wave extremes (strictly prior bars [idx-lookback : idx])
    if idx >= 6:
        win16 = df.iloc[max(0, idx - 16) : idx]
        win48 = df.iloc[max(0, idx - 48) : idx]
        win96 = df.iloc[max(0, idx - 96) : idx]

        low16 = float(win16["low"].min())
        high16 = float(win16["high"].max())
        supports.append(("4h前低支撑", low16))
        resistances.append(("4h前高压力", high16))

        if len(win48) > 16:
            low48 = float(win48["low"].min())
            high48 = float(win48["high"].max())
            if abs(low48 - low16) / max(c, 1e-9) > 0.0012:
                supports.append(("12h波段支撑", low48))
            if abs(high48 - high16) / max(c, 1e-9) > 0.0012:
                resistances.append(("12h波段压力", high48))

        if len(win96) > 48:
            low96 = float(win96["low"].min())
            high96 = float(win96["high"].max())
            if abs(low96 - low16) / max(c, 1e-9) > 0.0018:
                supports.append(("24h结构低点", low96))
            if abs(high96 - high16) / max(c, 1e-9) > 0.0018:
                resistances.append(("24h结构高点", high96))

    # 2. Causal local swing pivots (bars up to idx - 2 confirmed with 2 bars on each side)
    if idx >= 10:
        lo_arr = df["low"].astype(float).values
        hi_arr = df["high"].astype(float).values
        start_k = max(2, idx - 60)
        end_k = idx - 2
        for k in range(end_k, start_k - 1, -1):
            lk = float(lo_arr[k])
            if lk <= lo_arr[k - 1] and lk <= lo_arr[k - 2] and lk <= lo_arr[k + 1] and lk <= lo_arr[k + 2]:
                supports.append(("枢轴低点支撑", lk))
                break
        for k in range(end_k, start_k - 1, -1):
            hk = float(hi_arr[k])
            if hk >= hi_arr[k - 1] and hk >= hi_arr[k - 2] and hk >= hi_arr[k + 1] and hk >= hi_arr[k + 2]:
                resistances.append(("枢轴高点压力", hk))
                break

    # 3. Bollinger bands & Vegas tunnel & EMA55
    bb_lower = float(row.get("bb_lower") or np.nan)
    bb_upper = float(row.get("bb_upper") or np.nan)
    bb_basis = float(row.get("bb_basis") or np.nan)
    vegas_144 = float(row.get("vegas_e1") or np.nan)
    vegas_169 = float(row.get("vegas_e2") or np.nan)
    vegas_576 = float(row.get("vegas_e3") or np.nan)
    ema55 = float(row.get("ema55") or np.nan)

    if pd.notna(bb_lower) and bb_lower > 0:
        supports.append(("布林下轨支撑", bb_lower))
    if pd.notna(bb_upper) and bb_upper > 0:
        resistances.append(("布林上轨压力", bb_upper))
    if pd.notna(bb_basis) and bb_basis > 0:
        if c >= bb_basis and l <= bb_basis * 1.0025:
            supports.append(("布林中轨支撑", bb_basis))
        elif c <= bb_basis and h >= bb_basis * 0.9975:
            resistances.append(("布林中轨压力", bb_basis))

    if pd.notna(vegas_144) and vegas_144 > 0:
        v_mid = (vegas_144 + vegas_169) / 2.0 if pd.notna(vegas_169) and vegas_169 > 0 else vegas_144
        if c >= v_mid * 0.998:
            supports.append(("Vegas144/169通道支撑", v_mid))
        if c <= v_mid * 1.002:
            resistances.append(("Vegas144/169通道压力", v_mid))

    if pd.notna(vegas_576) and vegas_576 > 0:
        if c >= vegas_576 * 0.998:
            supports.append(("Vegas576大周期支撑", vegas_576))
        if c <= vegas_576 * 1.002:
            resistances.append(("Vegas576大周期压力", vegas_576))

    if pd.notna(ema55) and ema55 > 0:
        if c >= ema55 and l <= ema55 * 1.0025:
            supports.append(("EMA55动态支撑", ema55))
        elif c <= ema55 and h >= ema55 * 0.9975:
            resistances.append(("EMA55动态压力", ema55))

    return supports, resistances


def evaluate_bar_15m_tight_sl(
    df: pd.DataFrame,
    idx: int,
    *,
    symbol: str = "BTCUSDT",
    htf_trends: dict[str, dict[str, Any]] | None = None,
    oi_chg_pct: float | None = None,
    preferred_side: str | None = None,
    existing_signal_name: str | None = None,
) -> dict[str, Any]:
    """Evaluate bar `idx` of a 15m DataFrame for the 15m Tight Stop-Loss Strategy.

    Always returns a complete structured dict (even if `matched=False`, it provides
    the tight SL/TP plan, S/R proximity, MA cross status, and confidence index for the bar).
    """
    if df is None or df.empty or idx < 5 or idx >= len(df):
        return {"matched": False, "confidence_pct": 0, "confidence": 0.0}

    if "ema9" not in df.columns or "atr14" not in df.columns:
        df = enrich_tight_sl_df(df)

    row = df.iloc[idx]
    prev = df.iloc[idx - 1]
    prev2 = df.iloc[idx - 2] if idx >= 2 else prev

    o = float(row["open"])
    h = float(row["high"])
    l = float(row["low"])
    c = float(row["close"])
    vol = float(row.get("volume") or 0.0)
    vol_sma = float(row.get("vol_sma20") or 0.0)
    vol_ratio = round(vol / vol_sma, 2) if vol_sma > 0 else 1.0

    atr = float(row.get("atr14") or 0.0)
    if pd.isna(atr) or atr <= 0:
        atr = max(h - l, c * 0.0025)
    atr_pct = (atr / max(c, 1e-9)) * 100.0

    body = abs(c - o)
    rng = max(h - l, 1e-9)
    upper_w = h - max(o, c)
    lower_w = min(o, c) - l

    prev_o = float(prev["open"])
    prev_h = float(prev["high"])
    prev_l = float(prev["low"])
    prev_c = float(prev["close"])
    prev_body = abs(prev_c - prev_o)
    prev_upper_w = prev_h - max(prev_o, prev_c)
    prev_lower_w = min(prev_o, prev_c) - prev_l

    # --- 1) Pattern Detection (bullish & bearish) ---
    bull_patterns: list[str] = []
    bear_patterns: list[str] = []

    # Pinbar / Hammer / Shooting Star
    if lower_w >= max(body * 1.65, rng * 0.42) and upper_w <= lower_w * 0.45 and (c - l) / rng >= 0.52:
        bull_patterns.append("长下影锤子Pinbar")
    if upper_w >= max(body * 1.65, rng * 0.42) and lower_w <= upper_w * 0.45 and (h - c) / rng >= 0.52:
        bear_patterns.append("长上影射击之星Pinbar")

    # Double wicks (双针探底 / 双针摸顶)
    if lower_w >= max(body * 1.2, rng * 0.35) and prev_lower_w >= max(prev_body * 1.2, max(prev_h - prev_l, 1e-9) * 0.35):
        if abs(l - prev_l) / max(c, 1e-9) <= 0.0035:
            bull_patterns.append("双针探底")
    if upper_w >= max(body * 1.2, rng * 0.35) and prev_upper_w >= max(prev_body * 1.2, max(prev_h - prev_l, 1e-9) * 0.35):
        if abs(h - prev_h) / max(c, 1e-9) <= 0.0035:
            bear_patterns.append("双针摸顶")

    # Bullish / Bearish Engulfing (阳吞阴 / 阴吞阳)
    if c > o and prev_c < prev_o and c >= prev_o and o <= prev_c * 1.0005 and body >= max(prev_body * 0.95, atr * 0.32):
        bull_patterns.append("看涨吞没(阳吞阴)")
    if c < o and prev_c > prev_o and c <= prev_o and o >= prev_c * 0.9995 and body >= max(prev_body * 0.95, atr * 0.32):
        bear_patterns.append("看跌吞没(阴吞阳)")

    # Liquidity Sweep / 2B Fakeout Reclaim (破底翻 / 破顶翻)
    if idx >= 8:
        prior_win = df.iloc[max(0, idx - 20) : idx]
        p_low = float(prior_win["low"].min())
        p_high = float(prior_win["high"].max())
        if l < p_low and c > p_low and (c > o or lower_w > body):
            bull_patterns.append("破底翻(假跌破收回)")
        if h > p_high and c < p_high and (c < o or upper_w > body):
            bear_patterns.append("破顶翻(假突破收回)")

    # Volume momentum reversal bar (放量阳线 / 放量阴线)
    if c > o and vol_ratio >= 1.25 and body >= rng * 0.58 and body >= atr * 0.45:
        bull_patterns.append(f"放量反转阳线({vol_ratio:.1f}x)")
    if c < o and vol_ratio >= 1.25 and body >= rng * 0.58 and body >= atr * 0.45:
        bear_patterns.append(f"放量反转阴线({vol_ratio:.1f}x)")

    # Include caller's existing signal if provided (skip generic 15m小止损 label to avoid self-triggering)
    if existing_signal_name and "15m小止损" not in existing_signal_name:
        if preferred_side == "long" and existing_signal_name not in bull_patterns:
            bull_patterns.append(existing_signal_name)
        elif preferred_side == "short" and existing_signal_name not in bear_patterns:
            bear_patterns.append(existing_signal_name)

    # --- 2) Support / Resistance Proximity ---
    supports, resistances = _collect_causal_sr_levels(df, idx)
    tol_pct = max(0.0028, min(0.0060, (atr / max(c, 1e-9)) * 0.85))

    matched_supports: list[tuple[str, float, float]] = []
    for name, lvl in supports:
        if lvl <= 0:
            continue
        # Tested support if low came within tol_pct of lvl (or wicked slightly below) AND close held >= lvl * (1 - tol_pct*0.6)
        dist_low = abs(l - lvl) / c
        dist_close = abs(c - lvl) / c
        wicked_and_held = (l <= lvl * (1 + tol_pct)) and (c >= lvl * (1 - tol_pct * 0.5)) and (l >= lvl * (1 - tol_pct * 1.4))
        if wicked_and_held or min(dist_low, dist_close) <= tol_pct:
            matched_supports.append((name, lvl, min(dist_low, dist_close) * 100.0))

    matched_resistances: list[tuple[str, float, float]] = []
    for name, lvl in resistances:
        if lvl <= 0:
            continue
        dist_high = abs(h - lvl) / c
        dist_close = abs(c - lvl) / c
        wicked_and_rejected = (h >= lvl * (1 - tol_pct)) and (c <= lvl * (1 + tol_pct * 0.5)) and (h <= lvl * (1 + tol_pct * 1.4))
        if wicked_and_rejected or min(dist_high, dist_close) <= tol_pct:
            matched_resistances.append((name, lvl, min(dist_high, dist_close) * 100.0))

    matched_supports.sort(key=lambda x: x[2])
    matched_resistances.sort(key=lambda x: x[2])

    # --- 3) MA / EMA / MACD Crossover & Resonance ---
    ema9 = float(row["ema9"])
    ema21 = float(row["ema21"])
    ema13 = float(row["ema13"])
    ema33 = float(row["ema33"])
    ema55 = float(row["ema55"])
    vegas144 = float(row.get("vegas_e1") or ema55)

    p_ema9 = float(prev["ema9"])
    p_ema21 = float(prev["ema21"])
    p2_ema9 = float(prev2["ema9"])
    p2_ema21 = float(prev2["ema21"])

    p_ema13 = float(prev["ema13"])
    p_ema33 = float(prev["ema33"])
    p2_ema13 = float(prev2["ema13"])
    p2_ema33 = float(prev2["ema33"])

    macd_val = float(row.get("macd") or 0.0)
    macd_sig = float(row.get("macd_signal") or 0.0)
    macd_hist = float(row.get("macd_hist") or 0.0)
    p_macd_hist = float(prev.get("macd_hist") or 0.0)

    bull_ma_tags: list[str] = []
    bear_ma_tags: list[str] = []

    # EMA9 x EMA21 crossover (within last 2 bars)
    if ema9 >= ema21 and (p_ema9 <= p_ema21 or p2_ema9 <= p2_ema21):
        bull_ma_tags.append("EMA9/21金叉")
    elif ema9 <= ema21 and (p_ema9 >= p_ema21 or p2_ema9 >= p2_ema21):
        bear_ma_tags.append("EMA9/21死叉")

    # EMA13 x EMA33 crossover (within last 2 bars)
    if ema13 >= ema33 and (p_ema13 <= p_ema33 or p2_ema13 <= p2_ema33):
        bull_ma_tags.append("EMA13/33金叉")
    elif ema13 <= ema33 and (p_ema13 >= p_ema33 or p2_ema13 >= p2_ema33):
        bear_ma_tags.append("EMA13/33死叉")

    # MACD golden / death cross or histogram flip
    if macd_hist > 0 and p_macd_hist <= 0:
        bull_ma_tags.append("MACD金叉翻红")
    elif macd_hist < 0 and p_macd_hist >= 0:
        bear_ma_tags.append("MACD死叉翻绿")
    elif macd_hist > p_macd_hist and p_macd_hist < 0 and abs(macd_hist) < abs(p_macd_hist) * 0.65 and c > ema9:
        bull_ma_tags.append("MACD绿柱收敛拐头")
    elif macd_hist < p_macd_hist and p_macd_hist > 0 and abs(macd_hist) < abs(p_macd_hist) * 0.65 and c < ema9:
        bear_ma_tags.append("MACD红柱收敛拐头")

    # Price reclaiming or bouncing off EMA21 / EMA55 / Vegas144
    if l <= ema21 * 1.0012 and c > ema21 and ema9 >= p_ema9:
        bull_ma_tags.append("回踩站上EMA21")
    if h >= ema21 * 0.9988 and c < ema21 and ema9 <= p_ema9:
        bear_ma_tags.append("反抽受阻EMA21")

    if abs(l - vegas144) / c <= 0.0030 and c > vegas144:
        bull_ma_tags.append("Vegas144均线共振支撑")
    if abs(h - vegas144) / c <= 0.0030 and c < vegas144:
        bear_ma_tags.append("Vegas144均线共振压力")

    # Determine candidate side
    bull_pillars = int(bool(bull_patterns)) + int(bool(matched_supports)) + int(bool(bull_ma_tags))
    bear_pillars = int(bool(bear_patterns)) + int(bool(matched_resistances)) + int(bool(bear_ma_tags))

    if preferred_side in ("long", "short"):
        side = preferred_side
    else:
        if bull_pillars > bear_pillars:
            side = "long"
        elif bear_pillars > bull_pillars:
            side = "short"
        else:
            side = "long" if c >= o else "short"

    if side == "long":
        patterns = bull_patterns
        sr_hits = matched_supports
        ma_tags = bull_ma_tags
        opp_sr = [lvl for _, lvl in resistances if lvl > c * 1.002]
    else:
        patterns = bear_patterns
        sr_hits = matched_resistances
        ma_tags = bear_ma_tags
        opp_sr = [lvl for _, lvl in supports if lvl < c * 0.998]

    has_pattern = len(patterns) > 0
    has_sr = len(sr_hits) > 0
    has_ma = len(ma_tags) > 0
    pillar_count = int(has_pattern) + int(has_sr) + int(has_ma)

    # Check if strategy resonance is matched: require explicit K-line pattern OR explicit MA/MACD cross, plus S/R or MA resonance
    has_cross = any(("金叉" in m or "死叉" in m) for m in ma_tags)
    dir_candle_ok = (c >= o or lower_w > body * 1.3) if side == "long" else (c <= o or upper_w > body * 1.3)
    matched = bool(
        (has_pattern and (has_sr or has_ma))
        or (has_sr and has_cross and dir_candle_ok)
    )

    # --- 4) Tight Stop-Loss & Multi-R Take-Profit ---
    dec = _price_decimals(c, symbol)
    min_sl_pct, max_sl_pct = _tight_sl_bounds(symbol)
    entry_price = round(c, dec)

    primary_sr_name = sr_hits[0][0] if sr_hits else ("前低防守位" if side == "long" else "前高防守位")
    primary_sr_lvl = round(sr_hits[0][1], dec) if sr_hits else (round(l, dec) if side == "long" else round(h, dec))
    sr_names_joined = "+".join(dict.fromkeys([x[0] for x in sr_hits[:2]])) if sr_hits else primary_sr_name

    # Structural invalidation: beyond pattern extreme ∩ nearest S/R, plus ATR noise buffer.
    # Prefer wider of (pattern wick, SR level) so SL is not glued to a single wick tip.
    atr_buf = float(np.clip(TIGHT_SL_ATR_BUF_DEFAULT * atr, TIGHT_SL_ATR_BUF_LO * atr, TIGHT_SL_ATR_BUF_HI * atr)) if atr > 0 else 0.0

    if side == "long":
        anchor = l
        if sr_hits:
            # take the more conservative (lower) of wick low and nearby support zone
            sr_lvl = float(sr_hits[0][1])
            if sr_lvl <= c:
                anchor = min(l, sr_lvl)
            elif abs(sr_lvl - l) / c <= 0.006:
                anchor = min(l, sr_lvl)
        raw_sl = anchor - atr_buf
        raw_sl_pct = max(0.05, (c - raw_sl) / c * 100.0)
        sl_pct = float(np.clip(raw_sl_pct, min_sl_pct, max_sl_pct))
        sl_price = round(c * (1.0 - sl_pct / 100.0), dec)
        # Prefer structural raw_sl when it already sits inside the allowed band
        if min_sl_pct <= raw_sl_pct <= max_sl_pct:
            sl_price = round(raw_sl, dec)
            sl_pct = abs(c - sl_price) / c * 100.0
        risk = max(c - sl_price, c * (min_sl_pct / 100.0))

        tp1_raw = c + 1.9 * risk
        near_res = [r for r in opp_sr if c + 1.6 * risk <= r <= c + 2.3 * risk]
        if near_res:
            tp1_raw = min(near_res) * 0.9995
        tp1_price = round(tp1_raw, dec)
        tp2_price = round(c + 2.9 * risk, dec)
        be_price = round(c + 1.0 * risk, dec)
    else:
        anchor = h
        if sr_hits:
            sr_lvl = float(sr_hits[0][1])
            if sr_lvl >= c:
                anchor = max(h, sr_lvl)
            elif abs(sr_lvl - h) / c <= 0.006:
                anchor = max(h, sr_lvl)
        raw_sl = anchor + atr_buf
        raw_sl_pct = max(0.05, (raw_sl - c) / c * 100.0)
        sl_pct = float(np.clip(raw_sl_pct, min_sl_pct, max_sl_pct))
        sl_price = round(c * (1.0 + sl_pct / 100.0), dec)
        if min_sl_pct <= raw_sl_pct <= max_sl_pct:
            sl_price = round(raw_sl, dec)
            sl_pct = abs(sl_price - c) / c * 100.0
        risk = max(sl_price - c, c * (min_sl_pct / 100.0))

        tp1_raw = c - 1.9 * risk
        near_sup = [s for s in opp_sr if c - 2.3 * risk <= s <= c - 1.6 * risk]
        if near_sup:
            tp1_raw = max(near_sup) * 1.0005
        tp1_price = round(tp1_raw, dec)
        tp2_price = round(c - 2.9 * risk, dec)
        be_price = round(c - 1.0 * risk, dec)

    tp1_pct = round(abs(tp1_price - c) / c * 100.0, 2)
    tp2_pct = round(abs(tp2_price - c) / c * 100.0, 2)
    rr1 = round(abs(tp1_price - c) / max(risk, 1e-9), 2)
    rr2 = round(abs(tp2_price - c) / max(risk, 1e-9), 2)
    sl_pct_round = round(sl_pct, 2)

    # --- 5) Quantitative Confidence Index (0~100%) ---
    base_score = 26
    # Pattern score (0..22)
    pattern_score = 0
    if has_pattern:
        pattern_score += 14
        if len(patterns) >= 2:
            pattern_score += 5
        if any("吞没" in p or "破底翻" in p or "破顶翻" in p or "双针" in p for p in patterns):
            pattern_score += 3
    elif dir_candle_ok:
        pattern_score += 5
    pattern_score = min(22, pattern_score)

    # S/R score (0..20)
    sr_score = 0
    if has_sr:
        best_dist = sr_hits[0][2]
        sr_score += 13 if best_dist <= 0.18 else 10
        if len(sr_hits) >= 2:
            sr_score += 5
        if any("Vegas" in x[0] or "枢轴" in x[0] or "24h" in x[0] for x in sr_hits):
            sr_score += 2
    sr_score = min(20, sr_score)

    # MA Cross / Resonance score (0..18)
    ma_score = 0
    if has_ma:
        if any("金叉" in m or "死叉" in m for m in ma_tags):
            ma_score += 12
        else:
            ma_score += 8
        if len(ma_tags) >= 2:
            ma_score += 4
        if any("Vegas" in m for m in ma_tags):
            ma_score += 2
    else:
        # Check basic EMA trend alignment
        if (side == "long" and c >= ema21) or (side == "short" and c <= ema21):
            ma_score += 4
    ma_score = min(18, ma_score)

    # Volume & OI score (0..12)
    vol_oi_score = 0
    if vol_ratio >= 1.4:
        vol_oi_score += 8
    elif vol_ratio >= 1.05:
        vol_oi_score += 5
    elif vol_ratio >= 0.80:
        vol_oi_score += 3

    if oi_chg_pct is not None:
        try:
            oi_v = float(oi_chg_pct)
            if abs(oi_v) >= 0.5:
                vol_oi_score += 4
            elif abs(oi_v) >= 0.15:
                vol_oi_score += 2
        except (TypeError, ValueError):
            pass
    else:
        vol_oi_score += 2
    vol_oi_score = min(12, vol_oi_score)

    # Higher-TF (1h / 4h) trend alignment score (-10..+12)
    htf_score = 2
    htf_note = "1h/4h中性"
    if isinstance(htf_trends, dict):
        t1h = str((htf_trends.get("1h") or {}).get("trend") or "").lower()
        t4h = str((htf_trends.get("4h") or {}).get("trend") or "").lower()
        cb1h = str((htf_trends.get("1h") or {}).get("color_band") or "").lower()
        cb4h = str((htf_trends.get("4h") or {}).get("color_band") or "").lower()

        if side == "long":
            if cb4h == "bull" or "green" in t4h or "up" in t4h:
                htf_score += 6
                htf_note = "4h多头顺势"
            elif "red_trend" in t4h or "down" in t4h:
                htf_score -= 7
                htf_note = "逆4h空头趋势(轻仓快进快出)"
            if cb1h == "bull" or "green" in t1h or "up" in t1h:
                htf_score += 4
                htf_note = f"{htf_note}+1h偏多"
        else:
            if cb4h == "bear" or "red" in t4h or "down" in t4h:
                htf_score += 6
                htf_note = "4h空头顺势"
            elif "green_trend" in t4h or "up" in t4h:
                htf_score -= 7
                htf_note = "逆4h多头趋势(轻仓快进快出)"
            if cb1h == "bear" or "red" in t1h or "down" in t1h:
                htf_score += 4
                htf_note = f"{htf_note}+1h偏空"

    # Tight SL quality bonus: if structural raw_sl_pct naturally fits inside max_sl_pct without clipping
    sl_natural_fit = raw_sl_pct <= max_sl_pct * 1.15
    sl_fit_bonus = 4 if sl_natural_fit else -3

    raw_total = base_score + pattern_score + sr_score + ma_score + vol_oi_score + htf_score + sl_fit_bonus
    if pillar_count == 3:
        raw_total += 5  # 三维全共振加成

    confidence_pct = int(round(float(np.clip(raw_total, 35, 95))))
    confidence = round(confidence_pct / 100.0, 2)
    if confidence_pct >= 72:
        confidence_band = "高"
    elif confidence_pct >= 55:
        confidence_band = "中"
    else:
        confidence_band = "低"

    # Construct human-readable resonance summary
    parts: list[str] = []
    if sr_hits:
        parts.append(f"{sr_names_joined}({primary_sr_lvl})")
    if patterns:
        parts.append("+".join(patterns[:2]))
    if ma_tags:
        parts.append("+".join(ma_tags[:2]))
    resonance_summary = " + ".join(parts) if parts else ("15m多头小止损结构" if side == "long" else "15m空头小止损结构")

    short_signal_parts: list[str] = ["15m小止损"]
    if sr_hits:
        short_signal_parts.append(sr_hits[0][0].replace("支撑", "").replace("压力", ""))
    if patterns:
        short_signal_parts.append(patterns[0])
    if ma_tags:
        short_signal_parts.append(ma_tags[0])
    signal_label = "·".join(short_signal_parts[:3])

    # --- Actionable quality gates (causal; no lookahead) ---
    reject_reasons: list[str] = []
    has_meaningful_ma = bool(has_ma and ma_score >= 8)
    has_meaningful_pattern = bool(has_pattern and pattern_score >= 10)
    has_meaningful_sr = bool(has_sr and sr_score >= 10)
    meaningful_pillars = int(has_meaningful_pattern) + int(has_meaningful_sr) + int(has_meaningful_ma)

    if matched and meaningful_pillars < 2 and pillar_count < 3:
        reject_reasons.append("pillars_lt_2")
    if matched and has_pattern and has_sr and not has_meaningful_ma and confidence_pct < TIGHT_SL_MIN_CONF_NO_MA:
        reject_reasons.append(f"no_ma_conf<{TIGHT_SL_MIN_CONF_NO_MA}")
    if matched and rr1 < TIGHT_SL_MIN_RR_TP1:
        reject_reasons.append(f"rr_tp1<{TIGHT_SL_MIN_RR_TP1}")
    if matched and (not sl_natural_fit) and raw_sl_pct > max_sl_pct * 1.35:
        reject_reasons.append("sl_structure_too_wide_for_cap")
    htf_strongly_against = ("逆4h" in (htf_note or "")) or htf_score <= -5
    if matched and htf_strongly_against and confidence_pct < TIGHT_SL_MIN_CONF_AGAINST_HTF:
        reject_reasons.append(f"htf_against_conf<{TIGHT_SL_MIN_CONF_AGAINST_HTF}")
    conf_floor = TIGHT_SL_MIN_CONF_THREE_PILLAR if pillar_count >= 3 else TIGHT_SL_MIN_CONF_ENTER
    if matched and confidence_pct < conf_floor:
        reject_reasons.append(f"conf<{conf_floor}")

    should_enter = bool(matched and not reject_reasons)
    if should_enter:
        recommended_action = "LONG" if side == "long" else "SHORT"
    elif matched:
        recommended_action = "NO_TRADE"
    else:
        recommended_action = "WATCH"

    trail_text = (
        f"浮盈达 1R({be_price}) 推保本；TP1({tp1_price}, +{tp1_pct:.2f}%, {rr1:.1f}R) 减半仓，"
        f"余仓沿 15m EMA13/21 移损博 TP2({tp2_price}, +{tp2_pct:.2f}%, {rr2:.1f}R)"
    )

    return {
        "strategy_id": "tight_sl_15m",
        "strategy_name": "15m小止损策略（形态+支撑压力+均线共振）",
        "plan_kind": "tight_sl_15m",
        "matched": matched,
        "should_enter": should_enter,
        "reject_reasons": reject_reasons,
        "meaningful_pillars": meaningful_pillars,
        "side": side,
        "recommended_action": recommended_action,
        "signal_label": signal_label,
        "resonance_summary": resonance_summary,
        "pillar_count": pillar_count,
        "patterns": patterns,
        "pattern_tags": patterns,
        "sr_matched": has_sr,
        "sr_type": sr_names_joined if has_sr else "近期结构极值",
        "sr_level": primary_sr_lvl,
        "sr_dist_pct": round(sr_hits[0][2], 3) if has_sr else round(abs(c - primary_sr_lvl) / c * 100.0, 3),
        "ma_matched": has_ma,
        "ma_tags": ma_tags,
        "ma_summary": "+".join(ma_tags) if ma_tags else ("站上EMA21" if (side == "long" and c >= ema21) else ("受阻EMA21" if (side == "short" and c <= ema21) else "均线震荡")),
        "ma_cross_summary": "+".join(ma_tags) if ma_tags else ("站上EMA21" if (side == "long" and c >= ema21) else ("受阻EMA21" if (side == "short" and c <= ema21) else "均线震荡")),
        "ema9": round(ema9, dec),
        "ema21": round(ema21, dec),
        "ema13": round(ema13, dec),
        "ema33": round(ema33, dec),
        "atr14": round(atr, dec),
        "atr14_pct": round(atr_pct, 3),
        "volume_spike_x": vol_ratio,
        "entry": entry_price,
        "sl": sl_price,
        "sl_pct": sl_pct_round,
        "raw_sl_pct": round(raw_sl_pct, 2),
        "sl_natural_fit": sl_natural_fit,
        "tp": tp1_price,
        "tp1": tp1_price,
        "tp1_pct": tp1_pct,
        "rr1": rr1,
        "rr_tp1": rr1,
        "tp2": tp2_price,
        "tp2_pct": tp2_pct,
        "rr2": rr2,
        "rr_tp2": rr2,
        "breakeven_price": be_price,
        "trail": trail_text,
        "confidence_pct": confidence_pct,
        "confidence": confidence,
        "confidence_band": confidence_band,
        "htf_note": htf_note,
        "score_breakdown": {
            "base": base_score,
            "pattern": pattern_score,
            "sr": sr_score,
            "ma": ma_score,
            "vol_oi": vol_oi_score,
            "htf": htf_score,
            "sl_fit": sl_fit_bonus,
            "three_pillar_bonus": 5 if pillar_count == 3 else 0,
        },
    }


def scan_15m_tight_sl_signals(
    df: pd.DataFrame,
    *,
    symbol: str = "BTCUSDT",
    start_sec: int = 0,
    end_sec: int = 0,
    min_confidence_pct: int = TIGHT_SL_MIN_CONF_ENTER,
    cooldown_bars: int = 3,
) -> list[dict[str, Any]]:
    """Scan a 15m DataFrame across `[start_sec, end_sec]` and return matched 15m Tight-SL signals."""
    if df is None or df.empty or len(df) < 25:
        return []

    df_e = enrich_tight_sl_df(df)
    ts_arr = (df_e["open_time"].astype("int64") // 1000).astype("int64").values

    results: list[dict[str, Any]] = []
    last_bar_by_side: dict[str, int] = {"long": -999, "short": -999}

    for idx in range(25, len(df_e)):
        t_sec = int(ts_arr[idx])
        if start_sec and t_sec < start_sec:
            continue
        if end_sec and t_sec > end_sec:
            break

        info = evaluate_bar_15m_tight_sl(df_e, idx, symbol=symbol)
        if not info.get("matched"):
            continue
        if float(info.get("volume_spike_x") or 0.0) < 0.65:
            continue
        if int(info.get("confidence_pct") or 0) < min_confidence_pct:
            continue
        if not info.get("should_enter"):
            continue
        # Require either explicit pattern + (sr or ma) or 3-pillar resonance
        if not info.get("patterns") and int(info.get("pillar_count") or 0) < 2:
            continue

        side = str(info.get("side") or "long")
        if idx - last_bar_by_side.get(side, -999) < cooldown_bars:
            continue
        last_bar_by_side[side] = idx

        results.append(
            {
                "bar_idx": idx,
                "bar_open_sec": t_sec,
                "side": side,
                "signal_type": "tight_sl_15m",
                "signal_name": info["signal_label"],
                "patterns": [info["signal_label"]] + list(info.get("patterns") or [])[:2],
                "price": float(df_e.iloc[idx]["close"]),
                "tight_sl_strategy": info,
            }
        )

    return results


def _side_pnl_pct(side: str, entry: float, exit_px: float) -> float:
    """Directional PnL% from entry → exit (long: (exit-entry)/entry; short: (entry-exit)/entry)."""
    if entry <= 0 or exit_px <= 0:
        return 0.0
    if side == "long":
        return (exit_px - entry) / entry * 100.0
    return (entry - exit_px) / entry * 100.0


def _stop_fill(side: str, stop: float, o: float, h: float, l: float) -> float | None:
    """Return stop fill price if touched this bar; gap-through fills at open. Else None."""
    if side == "long":
        if l > stop:
            return None
        return float(o) if o <= stop else float(stop)
    if h < stop:
        return None
    return float(o) if o >= stop else float(stop)


def _tp_fill(side: str, tp: float, o: float, h: float, l: float) -> float | None:
    """Return TP fill price if touched this bar; gap-through fills at open. Else None."""
    if side == "long":
        if h < tp:
            return None
        return float(o) if o >= tp else float(tp)
    if l > tp:
        return None
    return float(o) if o <= tp else float(tp)


def simulate_tight_sl_outcome(
    tight_info: dict[str, Any],
    df_future: pd.DataFrame,
    *,
    max_bars: int = 48,
    fee_pct_per_side: float | None = None,
) -> dict[str, Any]:
    """Simulate one 15m tight-SL trade with the SAME rules as the live push copy.

    Rules (no lookahead; each future bar in order):
      1. Entry / SL / TP1 / TP2 / 1R-breakeven taken from the signal's own levels
         (`tight_info["entry"|"sl"|"tp1"|"tp2"|"breakeven_price"]`).
      2. Conservative same-bar: if stop and TP both touch, stop wins unless open already
         cleared the TP level.
      3. Float to 1R → move stop to breakeven (entry).
      4. Hit TP1 → close 50% at TP1; remainder stop = breakeven, then trail along
         15m EMA13/EMA21 toward TP2 (long: ratchet stop up via min(ema13,ema21);
         short: ratchet stop down via max(ema13,ema21); never worse than breakeven).
      5. Hit TP2 / trail stop / initial SL / time exit → settle remaining size.
      6. `realized_pct` = Σ (size_i × side_pnl% at exit_i)  — computed from **prices**,
         not from R × sl_pct approximations. This is **gross** (before fees).
      7. Fees (taker, % of notional):
         `fee_total_pct = fee_per_side * (1 + Σ leg.size)`
         complete exit → `2 * fee_per_side` (default 0.08%).
         `realized_pct_net = realized_pct - fee_total_pct`.
    """
    pending = {
        "status": "pending",
        "result": "pending",
        "label": "⏳ 待走完",
        "summary": "⏳ 待走完",
        "sim_label": "⏳ 待走完",
        "sim_outcome": "pending",
        "realized_r": 0.0,
        "realized_pct": 0.0,
        "realized_pct_gross": 0.0,
        "realized_pct_net": 0.0,
        "fee_total_pct": 0.0,
        "fee_pct_per_side": float(TIGHT_SL_FEE_PCT_PER_SIDE if fee_pct_per_side is None else fee_pct_per_side),
        "bars_to_resolve": 0,
        "bars_held": 0,
        "hit_tp1": False,
        "hit_tp2": False,
        "hit_sl": False,
        "moved_be": False,
        "legs": [],
        "exit_price": None,
    }
    if not tight_info or df_future is None or df_future.empty:
        return dict(pending)

    side = str(tight_info.get("side") or "long").lower()
    if side not in ("long", "short"):
        side = "long"
    entry = float(tight_info.get("entry") or 0.0)
    sl0 = float(tight_info.get("sl") or 0.0)
    tp1 = float(tight_info.get("tp1") or tight_info.get("tp") or 0.0)
    tp2 = float(tight_info.get("tp2") or tp1)
    be = float(tight_info.get("breakeven_price") or entry)
    sl_pct = float(tight_info.get("sl_pct") or 0.0)
    if sl_pct <= 0 and entry > 0 and sl0 > 0:
        sl_pct = abs(entry - sl0) / entry * 100.0

    if entry <= 0 or sl0 <= 0 or tp1 <= 0:
        return dict(pending)

    risk = abs(entry - sl0)
    if risk <= 0:
        risk = entry * max(sl_pct, 0.2) / 100.0

    slice_df = df_future.iloc[:max_bars]
    if slice_df.empty:
        return dict(pending)

    has_ema = "ema13" in slice_df.columns and "ema21" in slice_df.columns

    remaining = 1.0
    realized_pct = 0.0
    legs: list[dict[str, Any]] = []
    tp1_taken = False
    be_armed = False
    cur_stop = sl0
    bars_elapsed = 0
    last_exit = None
    status = "time_exit"
    result = "open"
    hit_sl = False
    hit_tp2 = False

    def _close(size: float, px: float, why: str) -> None:
        nonlocal remaining, realized_pct, last_exit
        if size <= 0 or px <= 0:
            return
        size = min(size, remaining)
        pnl = _side_pnl_pct(side, entry, px)
        realized_pct += size * pnl
        remaining = round(remaining - size, 10)
        if remaining < 1e-9:
            remaining = 0.0
        last_exit = px
        legs.append({"size": round(size, 4), "price": round(px, 8), "pnl_pct": round(pnl, 4), "why": why})

    def _arm_be() -> None:
        nonlocal be_armed, cur_stop
        be_armed = True
        cur_stop = entry

    def _update_ema_trail(row: Any) -> None:
        """After TP1: trail remainder along EMA13/21, never worse than breakeven."""
        nonlocal cur_stop
        if not tp1_taken or not has_ema:
            return
        try:
            e13 = float(row["ema13"])
            e21 = float(row["ema21"])
        except Exception:
            return
        if not (e13 > 0 and e21 > 0):
            return
        if side == "long":
            trail = min(e13, e21)
            # only ratchet up; floor at breakeven
            cur_stop = max(cur_stop, entry, trail) if trail >= entry else max(cur_stop, entry)
        else:
            trail = max(e13, e21)
            cur_stop = min(cur_stop, entry, trail) if trail <= entry else min(cur_stop, entry)

    for _, f_row in slice_df.iterrows():
        bars_elapsed += 1
        o = float(f_row["open"])
        h = float(f_row["high"])
        l = float(f_row["low"])

        if tp1_taken:
            _update_ema_trail(f_row)

        # Same-bar priority: if open already cleared TP2 / TP1, honor that before stop.
        open_cleared_tp2 = (side == "long" and o >= tp2) or (side == "short" and o <= tp2)
        open_cleared_tp1 = (not tp1_taken) and (
            (side == "long" and o >= tp1) or (side == "short" and o <= tp1)
        )

        stop_px = None if open_cleared_tp2 or open_cleared_tp1 else _stop_fill(side, cur_stop, o, h, l)
        if stop_px is not None:
            why = "sl"
            if tp1_taken and abs(stop_px - entry) < max(entry * 1e-8, 1e-8):
                why = "be_after_tp1"
            elif tp1_taken:
                why = "ema_trail"
            elif be_armed and abs(stop_px - entry) < max(entry * 1e-8, 1e-8):
                why = "breakeven"
            _close(remaining, stop_px, why)
            hit_sl = why in ("sl",)
            if why == "sl":
                status, result = "sl_hit", "sl_loss"
            elif why == "ema_trail":
                status, result = "trail_exit", ("tp1_win" if realized_pct > 0 else "breakeven_after_1r")
            elif why == "be_after_tp1":
                status, result = "tp1_then_be", "tp1_win"
            else:
                status, result = "breakeven", "breakeven_after_1r"
            break

        # TP2 on remaining
        tp2_px = _tp_fill(side, tp2, o, h, l)
        if tp2_px is not None:
            if not tp1_taken:
                # price traded through TP1 on the way — take half at TP1, rest at TP2
                _close(0.5, tp1, "tp1")
                tp1_taken = True
                _arm_be()
            _close(remaining, tp2_px, "tp2")
            hit_tp2 = True
            status, result = "tp2_hit", "tp2_win"
            break

        # TP1 half-close
        if not tp1_taken:
            tp1_px = _tp_fill(side, tp1, o, h, l)
            if tp1_px is not None:
                _close(0.5, tp1_px, "tp1")
                tp1_taken = True
                _arm_be()
                _update_ema_trail(f_row)
                # same bar: remainder may also hit TP2 or bounce into BE/EMA stop
                tp2_px2 = _tp_fill(side, tp2, o, h, l)
                if tp2_px2 is not None:
                    _close(remaining, tp2_px2, "tp2")
                    hit_tp2 = True
                    status, result = "tp2_hit", "tp2_win"
                    break
                stop_px2 = _stop_fill(side, cur_stop, o, h, l)
                if stop_px2 is not None:
                    why = "be_after_tp1" if abs(stop_px2 - entry) < max(entry * 1e-8, 1e-8) else "ema_trail"
                    _close(remaining, stop_px2, why)
                    status, result = ("tp1_then_be", "tp1_win") if why == "be_after_tp1" else (
                        "trail_exit",
                        "tp1_win" if realized_pct > 0 else "breakeven_after_1r",
                    )
                    break
                continue

        # 1R → arm breakeven (full size still open)
        if not be_armed:
            be_hit = (side == "long" and h >= be) or (side == "short" and l <= be)
            if be_hit:
                _arm_be()
    else:
        # exhausted window without full exit
        last_c = float(slice_df.iloc[-1]["close"])
        if remaining > 0:
            why = "time_exit_after_tp1" if tp1_taken else "time_exit"
            _close(remaining, last_c, why)
            status = "tp1_hit" if tp1_taken else "time_exit"
            result = "tp1_win" if tp1_taken else "open"

    realized_pct = round(realized_pct, 4)
    realized_r = round(realized_pct / sl_pct, 2) if sl_pct > 1e-9 else 0.0

    if status == "sl_hit":
        label = f"❌ 触及小止损 (-1.0R / {realized_pct:+.2f}%)"
    elif status == "tp2_hit":
        label = f"🎯 止盈TP2全满 ({realized_r:+.2f}R / {realized_pct:+.2f}%)"
    elif status == "tp1_then_be":
        label = f"✅ 止盈TP1+保本 ({realized_r:+.2f}R / {realized_pct:+.2f}%)"
    elif status == "trail_exit":
        label = f"📈 TP1后EMA移损出场 ({realized_r:+.2f}R / {realized_pct:+.2f}%)"
    elif status == "breakeven":
        label = f"🛡 触达1R后保本出局 (0.0R / {realized_pct:+.2f}%)"
    elif status == "tp1_hit":
        label = f"✅ 止盈TP1命中·余仓到期 ({realized_r:+.2f}R / {realized_pct:+.2f}%)"
    else:
        label = f"⏱ 到期收盘 ({realized_r:+.2f}R / {realized_pct:+.2f}%)"

    fee_side = float(TIGHT_SL_FEE_PCT_PER_SIDE if fee_pct_per_side is None else fee_pct_per_side)
    legs_size_sum = float(sum(float(lg.get("size") or 0.0) for lg in legs))
    # open once + close each leg: fee_side * (1 + Σ size); full exit → 2*fee_side
    fee_total_pct = round(fee_side * (1.0 + legs_size_sum), 6) if legs else 0.0
    realized_pct_gross = round(realized_pct, 4)
    realized_pct_net = round(realized_pct_gross - fee_total_pct, 4)
    # Keep realized_pct as GROSS for backward compat; UI prefers net via realized_pct_net
    realized_pct = round(realized_pct_gross, 2)
    realized_r = round(realized_pct_gross / sl_pct, 2) if sl_pct > 1e-9 else 0.0

    return {
        "status": status,
        "result": result,
        "label": label,
        "summary": label,
        "sim_label": label,
        "sim_outcome": status,
        "realized_r": realized_r,
        "realized_pct": realized_pct,
        "realized_pct_gross": round(realized_pct_gross, 2),
        "realized_pct_net": round(realized_pct_net, 2),
        "fee_total_pct": round(fee_total_pct, 4),
        "fee_pct_per_side": fee_side,
        "bars_to_resolve": bars_elapsed,
        "bars_held": bars_elapsed,
        "hit_tp1": bool(tp1_taken),
        "hit_tp2": bool(hit_tp2),
        "hit_sl": bool(hit_sl),
        "moved_be": bool(be_armed),
        "legs": legs,
        "exit_price": round(float(last_exit), 8) if last_exit is not None else None,
        "entry": entry,
        "sl": sl0,
        "tp1": tp1,
        "tp2": tp2,
        "side": side,
        "settlement": "entry_sl_tp_trail",
    }
