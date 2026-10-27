"""扫流动性 / 反转持续性评分 — 对齐形态页 charts 的最新 K + OI。

规则（与前端 sweepMomentum.ts 一致）：
- Pinbar/Sweep：影线占全幅 >50% 且收盘方向一致
- vol_ratio：最新量 / 前 14 根均量
- oi_delta_pct：最新 OI 相对前一根变化 %
- 得分：扫荡 +30；OI 断崖（<-1.5%）+40；OI 对攻（>+2%）-20；放量（>2x）+30
"""
from __future__ import annotations

from typing import Any, Sequence

import pandas as pd

VOL_LOOKBACK = 14
OI_FLUSH_PCT = -1.5
OI_ATTACK_PCT = 2.0
VOL_SPIKE_MULT = 2.0
SWEEP_WICK_RATIO = 0.5


def evaluate_sweep_momentum(
    opens: Sequence[float],
    highs: Sequence[float],
    lows: Sequence[float],
    closes: Sequence[float],
    volumes: Sequence[float],
    oi_values: Sequence[float | None] | None = None,
    *,
    symbol: str = "",
    timestamp: str | None = None,
) -> dict[str, Any] | None:
    """对最后一根 K 评估持续性。数据不足返回 None。"""
    n = len(closes)
    if n < 2:
        return None
    i = n - 1
    o = float(opens[i])
    h = float(highs[i])
    l = float(lows[i])
    c = float(closes[i])
    total_range = h - l
    if total_range <= 0 or not all(map(lambda x: x == x, (o, h, l, c))):  # NaN check
        return None

    body = abs(c - o)
    lower_shadow = min(o, c) - l
    upper_shadow = h - max(o, c)

    # 均量：前 VOL_LOOKBACK 根（不含当前）
    start = max(0, i - VOL_LOOKBACK)
    prev_vols = [float(volumes[j]) for j in range(start, i) if float(volumes[j] or 0) > 0]
    avg_vol = sum(prev_vols) / len(prev_vols) if prev_vols else 0.0
    cur_vol = float(volumes[i] or 0)
    vol_ratio = (cur_vol / avg_vol) if avg_vol > 0 else 0.0

    oi_delta_pct: float | None = None
    if oi_values is not None and i >= 1:
        cur_oi = oi_values[i]
        prev_oi = oi_values[i - 1]
        if (
            cur_oi is not None
            and prev_oi is not None
            and float(prev_oi) > 0
            and float(cur_oi) == float(cur_oi)
            and float(prev_oi) == float(prev_oi)
        ):
            oi_delta_pct = ((float(cur_oi) - float(prev_oi)) / float(prev_oi)) * 100.0

    is_bullish_sweep = (lower_shadow / total_range > SWEEP_WICK_RATIO) and (c > o)
    is_bearish_sweep = (upper_shadow / total_range > SWEEP_WICK_RATIO) and (c < o)

    score = 0
    reasons: list[str] = []

    if is_bullish_sweep or is_bearish_sweep:
        score += 30
        reasons.append("K线呈现明显长影线探针 (Pinbar/Sweep)")

    if oi_delta_pct is not None:
        if oi_delta_pct < OI_FLUSH_PCT:
            score += 40
            reasons.append(
                f"OI 出现断崖式下跌 ({oi_delta_pct:.2f}%)，高倍杠杆已被系统强制清算"
            )
        elif oi_delta_pct > OI_ATTACK_PCT:
            score -= 20
            reasons.append(
                f"OI 不降反升 (+{oi_delta_pct:.2f}%)，存在主力单边主动开仓对攻风险，易二次击穿"
            )

    if vol_ratio > VOL_SPIKE_MULT:
        score += 30
        reasons.append(f"成交量异常放大 ({vol_ratio:.1f}x 均量)，说明对手盘大量承接换手")

    if is_bullish_sweep:
        signal_type = "看涨反转扫荡"
    elif is_bearish_sweep:
        signal_type = "看跌反转扫荡"
    else:
        signal_type = "普通震荡"

    return {
        "symbol": symbol,
        "timestamp": timestamp,
        "price_close": c,
        "vol_ratio": round(vol_ratio, 2),
        "oi_delta_pct": round(oi_delta_pct, 2) if oi_delta_pct is not None else None,
        "sustainability_score": max(0, min(100, score)),
        "signal_type": signal_type,
        "is_bullish_sweep": is_bullish_sweep,
        "is_bearish_sweep": is_bearish_sweep,
        "lower_shadow_ratio": round(lower_shadow / total_range, 3),
        "upper_shadow_ratio": round(upper_shadow / total_range, 3),
        "body_ratio": round(body / total_range, 3) if total_range else 0.0,
        "reasons": reasons,
    }


def evaluate_sweep_momentum_from_df(
    df: pd.DataFrame,
    *,
    symbol: str = "",
) -> dict[str, Any] | None:
    """从 enrich 后的 DataFrame（含 open/high/low/close/volume，可选 oi）评估最新一根。"""
    if df is None or df.empty or len(df) < 2:
        return None
    opens = df["open"].astype(float).tolist()
    highs = df["high"].astype(float).tolist()
    lows = df["low"].astype(float).tolist()
    closes = df["close"].astype(float).tolist()
    volumes = (
        df["volume"].astype(float).tolist()
        if "volume" in df.columns
        else [0.0] * len(df)
    )
    oi_values: list[float | None] | None = None
    if "oi" in df.columns:
        oi_values = []
        for v in df["oi"].tolist():
            if v is None or (isinstance(v, float) and pd.isna(v)):
                oi_values.append(None)
            else:
                try:
                    fv = float(v)
                    oi_values.append(fv if fv > 0 else None)
                except (TypeError, ValueError):
                    oi_values.append(None)

    ts = None
    last = df.iloc[-1]
    ot = last.get("open_time") if hasattr(last, "get") else getattr(last, "open_time", None)
    if ot is not None and pd.notna(ot):
        try:
            ts = pd.to_datetime(int(ot), unit="ms").strftime("%Y-%m-%d %H:%M:%S")
        except (TypeError, ValueError):
            ts = str(ot)

    return evaluate_sweep_momentum(
        opens,
        highs,
        lows,
        closes,
        volumes,
        oi_values,
        symbol=symbol,
        timestamp=ts,
    )
