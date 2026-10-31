"""区间极值末端放量（AICoin 新高/新低末端 + 放量）— 仅作共振评分特征，非独立自动交易。

定义（与用户 AICoin 脚本口径对齐）
--------------------------------
- ``hhv/llv``：近 50 根最高价 / 最低价；``newHigh`` / ``newLow`` 为当根触及。
- ``len = |high-low|``，``maLen = SMA(len, 50)``；``lenLimit = len > maLen``（实体区间偏大）。
- ``newHighEnd``：当前或上一根为新高，且 ``close < open``，且 ``lenLimit``。
- ``newLowEnd``：当前或上一根为新低，且 ``close > open``，且 ``lenLimit``。
- ``degree = (close-open)/open*100``；``maVol = SMA(volume, 120)``；
  ``volUp`` = 放量且 degree≥0.2；``volDown`` = 放量且 degree≤-0.2。
- ``signal = +1``：volUp 且近 5 根（含当根）任一 ``newLowEnd``，且前 1..4 根无买入信号。
- ``signal = -1``：volDown 且近 5 根任一 ``newHighEnd``，且前 1..4 根无卖出信号。

组合用法见 ``confluence_features``：与倒锤子 / 射击之星 / TD9 / 放量共振加分；
与方向冲突时不给本特征加分（忽略 boost）。**不**接 enterLong/enterShort。
"""
from __future__ import annotations

from typing import Any, Sequence

HHV_LEN = 50
LLV_LEN = 50
MA_LEN = 50
MA_VOL = 120
DEGREE_THRESHOLD = 0.2
LOOKBACK = 4  # new*End / 信号冷却：bars 0..4 / 1..4


def _f(x: Any) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _sma(vals: Sequence[float | None], end: int, window: int) -> float | None:
    if end + 1 < window:
        return None
    chunk = vals[end + 1 - window : end + 1]
    if any(v is None for v in chunk):
        return None
    return sum(chunk) / float(window)  # type: ignore[arg-type]


def _rolling_max(vals: Sequence[float | None], end: int, window: int) -> float | None:
    if end + 1 < window:
        return None
    chunk = vals[end + 1 - window : end + 1]
    nums = [v for v in chunk if v is not None]
    if len(nums) < window:
        return None
    return max(nums)


def _rolling_min(vals: Sequence[float | None], end: int, window: int) -> float | None:
    if end + 1 < window:
        return None
    chunk = vals[end + 1 - window : end + 1]
    nums = [v for v in chunk if v is not None]
    if len(nums) < window:
        return None
    return min(nums)


def range_extreme_signal_series(
    highs: Sequence[float | int],
    lows: Sequence[float | int],
    opens: Sequence[float | int],
    closes: Sequence[float | int],
    volumes: Sequence[float | int],
    *,
    hhv_len: int = HHV_LEN,
    ma_len: int = MA_LEN,
    ma_vol: int = MA_VOL,
    degree_threshold: float = DEGREE_THRESHOLD,
    lookback: int = LOOKBACK,
) -> list[int]:
    """返回与输入等长的 signed 信号序列（+1 买 / -1 卖 / 0）。"""
    n = min(len(highs), len(lows), len(opens), len(closes), len(volumes))
    out = [0] * n
    if n == 0:
        return out

    h = [_f(highs[i]) for i in range(n)]
    l = [_f(lows[i]) for i in range(n)]
    o = [_f(opens[i]) for i in range(n)]
    c = [_f(closes[i]) for i in range(n)]
    v = [_f(volumes[i]) for i in range(n)]

    lens: list[float | None] = [None] * n
    new_high = [False] * n
    new_low = [False] * n
    new_high_end = [False] * n
    new_low_end = [False] * n
    vol_up = [False] * n
    vol_down = [False] * n

    for i in range(n):
        if h[i] is None or l[i] is None or o[i] is None or c[i] is None:
            continue
        lens[i] = abs(h[i] - l[i])  # type: ignore[operator]
        hhv = _rolling_max(h, i, hhv_len)
        llv = _rolling_min(l, i, hhv_len if hhv_len == LLV_LEN else LLV_LEN)
        if hhv is not None and h[i] == hhv:
            new_high[i] = True
        if llv is not None and l[i] == llv:
            new_low[i] = True

        ma_len_v = _sma(lens, i, ma_len)
        len_limit = ma_len_v is not None and lens[i] is not None and lens[i] > ma_len_v
        change = c[i] - o[i]  # type: ignore[operator]
        prev_nh = new_high[i - 1] if i >= 1 else False
        prev_nl = new_low[i - 1] if i >= 1 else False
        # ((newHigh[1] && !newHigh) || newHigh) ≡ newHigh || newHigh[1]
        if (new_high[i] or prev_nh) and change < 0 and len_limit:
            new_high_end[i] = True
        if (new_low[i] or prev_nl) and change > 0 and len_limit:
            new_low_end[i] = True

        if o[i] and o[i] != 0:
            degree = ((c[i] - o[i]) / o[i]) * 100.0  # type: ignore[operator]
        else:
            degree = 0.0
        ma_vol_v = _sma(v, i, ma_vol)
        vol_cond = ma_vol_v is not None and v[i] is not None and v[i] > ma_vol_v
        if vol_cond and degree >= degree_threshold:
            vol_up[i] = True
        if vol_cond and degree <= -degree_threshold:
            vol_down[i] = True

    for i in range(n):
        # any(newLowEnd over 0..lookback)
        any_nl = any(new_low_end[j] for j in range(max(0, i - lookback), i + 1))
        any_nh = any(new_high_end[j] for j in range(max(0, i - lookback), i + 1))
        # 前 1..lookback 无同向 signal（递推依赖已写入的 out）
        no_prior_buy = all(out[j] != 1 for j in range(max(0, i - lookback), i))
        no_prior_sell = all(out[j] != -1 for j in range(max(0, i - lookback), i))

        if vol_up[i] and any_nl and no_prior_buy:
            out[i] = 1
        elif vol_down[i] and any_nh and no_prior_sell:
            out[i] = -1
        else:
            out[i] = 0
    return out


def range_extreme_signal_at(
    highs: Sequence[float | int],
    lows: Sequence[float | int],
    opens: Sequence[float | int],
    closes: Sequence[float | int],
    volumes: Sequence[float | int],
    index: int = -1,
    **kwargs: Any,
) -> int:
    series = range_extreme_signal_series(highs, lows, opens, closes, volumes, **kwargs)
    if not series:
        return 0
    i = index if index >= 0 else len(series) + index
    if i < 0 or i >= len(series):
        return 0
    return int(series[i])


def is_rev_buy(sig: int) -> bool:
    return int(sig) == 1


def is_rev_sell(sig: int) -> bool:
    return int(sig) == -1


def rev_vol_label_zh(sig: int) -> str:
    """UI 中文：新低末端放量买 / 新高末端放量卖。"""
    v = int(sig)
    if v == 1:
        return "新低末端放量买"
    if v == -1:
        return "新高末端放量卖"
    return ""


def ohlcv_from_df(df: Any) -> tuple[list[float], list[float], list[float], list[float], list[float]]:
    """从带 open/high/low/close/volume 列的 DataFrame 取序列。"""
    if df is None:
        return [], [], [], [], []
    try:
        o = [float(x) for x in df["open"].tolist()]
        h = [float(x) for x in df["high"].tolist()]
        l = [float(x) for x in df["low"].tolist()]
        c = [float(x) for x in df["close"].tolist()]
        v = [float(x) for x in df["volume"].tolist()]
        return o, h, l, c, v
    except Exception:  # noqa: BLE001
        return [], [], [], [], []



def find_last_closed_rev_vol_hit(
    df: Any,
    *,
    now_ms: int | None = None,
    index: int | None = None,
) -> dict[str, Any] | None:
    """最近一根已收盘 K 上的 NLV/revVol 信号；无信号返回 None。"""
    if df is None:
        return None
    try:
        if bool(df.empty):
            return None
    except Exception:  # noqa: BLE001
        return None
    if index is None:
        from oi_mornitor.strategy.candle_signals import closed_bar_index

        idx = closed_bar_index(df, now_ms=now_ms)
    else:
        idx = int(index)
    if idx < 0:
        return None
    o, h, l, c, v = ohlcv_from_df(df)
    need = max(HHV_LEN, LLV_LEN, MA_LEN, MA_VOL) + 2
    if len(o) < need or idx >= len(o):
        return None
    sig = range_extreme_signal_at(h, l, o, c, v, index=idx)
    if int(sig) == 0:
        return None
    row = df.iloc[idx]
    try:
        ot = int(row["open_time"])
    except Exception:  # noqa: BLE001
        return None
    close_ts = ot // 1000 if ot > 10_000_000_000 else ot
    lab = rev_vol_label_zh(sig)
    side = "bull" if int(sig) == 1 else "bear"
    kind = "rev_vol_buy" if int(sig) == 1 else "rev_vol_sell"
    vol_ratio: float | None = None
    try:
        vol = float(row["volume"]) if "volume" in df.columns else float(v[idx])
        vol_ma = None
        if "vol_ma20" in df.columns:
            try:
                raw = row["vol_ma20"]
                if raw is not None and raw == raw:  # NaN != NaN
                    vol_ma = float(raw)
            except Exception:  # noqa: BLE001
                vol_ma = None
        if vol_ma is None:
            vs = v[max(0, idx - 19) : idx + 1]
            nums = [float(x) for x in vs if x is not None]
            if nums:
                vol_ma = sum(nums) / len(nums)
        if vol_ma and vol_ma > 0:
            vol_ratio = vol / vol_ma
    except Exception:  # noqa: BLE001
        vol_ratio = None
    return {
        "kind": kind,
        "signal_kind": kind,
        "side": side,
        "type_label": lab,
        "pattern_label": lab,
        "text": lab,
        "revVolSignal": int(sig),
        "revVolLabel": lab,
        "time": close_ts,
        "open_time": ot,
        "open": float(o[idx]),
        "high": float(h[idx]),
        "low": float(l[idx]),
        "close": float(c[idx]),
        "price": float(c[idx]),
        "vol_ratio": vol_ratio,
        "bar_index": idx,
    }


def attach_range_extreme_volume(
    alert: dict[str, Any],
    *,
    df: Any = None,
    opens: Sequence[float | int] | None = None,
    highs: Sequence[float | int] | None = None,
    lows: Sequence[float | int] | None = None,
    closes: Sequence[float | int] | None = None,
    volumes: Sequence[float | int] | None = None,
    index: int = -1,
) -> int:
    """就地写入 ``revVolSignal`` / ``revVolLabel``；返回 signed 值。"""
    o = list(opens) if opens is not None else []
    h = list(highs) if highs is not None else []
    l = list(lows) if lows is not None else []
    c = list(closes) if closes is not None else []
    v = list(volumes) if volumes is not None else []
    if (not o or not h) and df is not None:
        o, h, l, c, v = ohlcv_from_df(df)
    sig = 0
    if o and h and l and c and v and len(o) == len(h) == len(l) == len(c) == len(v):
        sig = range_extreme_signal_at(h, l, o, c, v, index=index)
    alert["revVolSignal"] = int(sig)
    lab = rev_vol_label_zh(sig)
    if lab:
        alert["revVolLabel"] = lab
    else:
        alert.pop("revVolLabel", None)
    return int(sig)


def _self_check() -> None:
    # 构造：长平台后新低末端阳线 + 放量 → 买；新高末端阴线 + 放量 → 卖
    n = 130
    opens = [100.0] * n
    highs = [101.0] * n
    lows = [99.0] * n
    closes = [100.0] * n
    volumes = [1000.0] * n

    # 末段：制造新低（压低 low）+ 阳线 + 大实体 + 放量
    i = n - 1
    lows[i] = 90.0
    highs[i] = 102.0
    opens[i] = 95.0
    closes[i] = 101.0  # change>0, degree 大
    volumes[i] = 5000.0
    # 上一根仅压低低点、阴线缩量，避免提前触发买入（留给 lookback 的 newLow 语境即可）
    lows[i - 1] = 91.0
    highs[i - 1] = 100.5
    opens[i - 1] = 100.2
    closes[i - 1] = 99.5  # change < 0 → 非 newLowEnd
    volumes[i - 1] = 900.0

    series_buy = range_extreme_signal_series(highs, lows, opens, closes, volumes)
    assert is_rev_buy(series_buy[i]), series_buy[i - 5 :]
    assert rev_vol_label_zh(1) == "新低末端放量买"

    # 卖：新高末端阴线放量
    opens2 = [100.0] * n
    highs2 = [101.0] * n
    lows2 = [99.0] * n
    closes2 = [100.0] * n
    volumes2 = [1000.0] * n
    highs2[i] = 110.0
    lows2[i] = 98.0
    opens2[i] = 108.0
    closes2[i] = 99.0  # change<0
    volumes2[i] = 5000.0
    highs2[i - 1] = 109.0
    series_sell = range_extreme_signal_series(highs2, lows2, opens2, closes2, volumes2)
    assert is_rev_sell(series_sell[i]), series_sell[i - 5 :]
    assert rev_vol_label_zh(-1) == "新高末端放量卖"

    alert: dict[str, Any] = {}
    attach_range_extreme_volume(
        alert, opens=opens, highs=highs, lows=lows, closes=closes, volumes=volumes
    )
    assert alert.get("revVolSignal") == 1
    assert alert.get("revVolLabel") == "新低末端放量买"
    print(
        "range_extreme_volume self-check OK",
        {"buy": series_buy[i], "sell": series_sell[i]},
    )


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="区间极值末端放量 调试 / 自检")
    p.add_argument("--self-check", action="store_true", help="跑内置夹具断言")
    args = p.parse_args()
    _self_check()
