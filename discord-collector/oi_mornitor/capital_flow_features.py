"""资金流特征（信号时刻无前瞻；纯函数，供 Live / 回测 / 共振共用）。"""
from __future__ import annotations

import math
from typing import Any

from oi_mornitor.capital_flow_config import (
    CF_DIST_PRICE_PROG_MAX,
    CF_DIST_VOL_RATIO_MIN,
    CF_FUNDING_CROWDED_LONG,
    CF_FUNDING_CROWDED_SHORT,
    CF_FUNDING_NEUTRAL_ABS,
    CF_LIQ_PROXY_OI_DROP,
    CF_LIQ_PROXY_OI_WINDOW,
    CF_LIQ_PROXY_VOL_RATIO,
    CF_LIQ_RECLAIM_BARS,
    CF_LIQ_RECLAIM_WICK_FRAC,
    CF_OI_FLUSH_DROP_PCT,
    CF_OI_FLUSH_LOOKBACK_BARS,
    CF_QUIET_ATR_PCT_MAX,
    CF_QUIET_OI_RISE_PCT,
    CF_REBUILD_BARS,
    CF_REBUILD_OI_RISE_PCT,
    CF_WICK_BODY_MIN_RATIO,
)
from oi_mornitor.capital_flow_fetch import oi_coverage_days

Bar = dict[str, float | int]

_INTERVAL_MS: dict[str, int] = {
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "2h": 7_200_000,
    "4h": 14_400_000,
    "6h": 21_600_000,
    "8h": 28_800_000,
    "12h": 43_200_000,
    "1d": 86_400_000,
    "1w": 604_800_000,
}


def _interval_ms(interval: str) -> int:
    s = (interval or "15m").strip().lower()
    if s in ("60m", "60"):
        return _INTERVAL_MS["1h"]
    if s in ("240m", "240"):
        return _INTERVAL_MS["4h"]
    return _INTERVAL_MS.get(s, 900_000)


def signal_interval_cutoff_ms(signal_at_ms: int, interval: str) -> int:
    """允许纳入的最后一根 K 的收盘时刻上界（= signalAt，已与 5m 核实网格对齐）。"""
    return int(signal_at_ms)


def _bar_from_kline(row: list[Any], *, interval: str) -> Bar | None:
    try:
        ot = int(row[0])
        o, h, l, c = float(row[1]), float(row[2]), float(row[3]), float(row[4])
        vol = float(row[5])
        close_ms = int(row[6]) if len(row) > 6 else ot + _interval_ms(interval) - 1
    except (TypeError, ValueError, IndexError):
        return None
    # OI/多空比快照对齐 period 结束时刻（open+interval），非 close_ms//1000
    close_lookup_sec = (int(close_ms) + 1) // 1000
    return {
        "open_time_ms": ot,
        "close_time_ms": close_ms,
        "time_sec": ot // 1000,
        "close_time_sec": close_lookup_sec,
        "o": o,
        "h": h,
        "l": l,
        "c": c,
        "v": vol,
    }


def klines_to_bars(
    klines: list[list[Any]],
    *,
    signal_at_ms: int,
    interval: str = "15m",
) -> list[Bar]:
    """仅保留收盘时间 <= cutoff 的 K 线（cutoff = signalAt 按周期取整）。"""
    cutoff = signal_interval_cutoff_ms(signal_at_ms, interval)
    bars: list[Bar] = []
    for row in klines:
        b = _bar_from_kline(row, interval=interval)
        if not b:
            continue
        if int(b["close_time_ms"]) > cutoff:
            continue
        bars.append(b)
    return bars


def _value_at_or_before(series: list[tuple[int, float]], time_sec: int) -> float | None:
    val: float | None = None
    for ts, v in series:
        if ts > time_sec:
            break
        val = v
    return val


def _series_slice_upto(series: list[tuple[int, float]], time_sec: int) -> list[tuple[int, float]]:
    return [(t, v) for t, v in series if t <= time_sec]


def _oi_at_bar_close(oi_series: list[tuple[int, float]], bar: Bar) -> float | None:
    return _value_at_or_before(oi_series, int(bar["close_time_sec"]))


def _taker_at_bar_open(taker_series: list[tuple[int, float]], bar: Bar) -> float | None:
    """Taker ratio 时间戳为 period 起点，与 K 线 open 对齐。"""
    return _value_at_or_before(taker_series, int(bar["time_sec"]))


def _atr_pct(bars: list[Bar], lookback: int = 14) -> float | None:
    if len(bars) < lookback + 1:
        return None
    trs: list[float] = []
    for i in range(-lookback, 0):
        cur, prev = bars[i], bars[i - 1]
        h, l, pc = float(cur["h"]), float(cur["l"]), float(prev["c"])
        tr = max(h - l, abs(h - pc), abs(l - pc))
        trs.append(tr)
    if not trs:
        return None
    atr = sum(trs) / len(trs)
    close = float(bars[-1]["c"])
    if close <= 0:
        return None
    return atr / close * 100.0


def _wick_parts(bar: Bar) -> tuple[float, float, float, str]:
    o, h, l, c = float(bar["o"]), float(bar["h"]), float(bar["l"]), float(bar["c"])
    body = max(abs(c - o), (h - l) * 0.02)
    upper = h - max(o, c)
    lower = min(o, c) - l
    if upper >= lower and upper >= body * 0.5:
        return upper, lower, body, "upper"
    if lower > upper:
        return upper, lower, body, "lower"
    return upper, lower, body, "none"


def _long_wick(bar: Bar) -> tuple[bool, str]:
    upper, lower, body, dom = _wick_parts(bar)
    ratio = CF_WICK_BODY_MIN_RATIO
    if dom == "upper" and upper >= body * ratio:
        return True, "upper"
    if dom == "lower" and lower >= body * ratio:
        return True, "lower"
    return False, dom


def _flush_at_bar(
    oi_series: list[tuple[int, float]],
    bars: list[Bar],
    end_idx: int,
) -> dict[str, Any] | None:
    look = min(CF_OI_FLUSH_LOOKBACK_BARS, end_idx + 1)
    window = bars[end_idx - look + 1 : end_idx + 1]
    oi_vals: list[float] = []
    for b in window:
        v = _oi_at_bar_close(oi_series, b)
        if v is not None and v > 0:
            oi_vals.append(v)
    if len(oi_vals) < 2:
        return None
    peak = max(oi_vals)
    cur = oi_vals[-1]
    drop = (peak - cur) / peak if peak > 0 else 0.0
    wick_ok, wick_side = _long_wick(bars[end_idx])
    if drop >= CF_OI_FLUSH_DROP_PCT and wick_ok:
        bias = "long" if wick_side == "lower" else "short"
        return {
            "active": True,
            "dropPct": round(drop * 100, 2),
            "wick": wick_side,
            "bias": bias,
            "barIdx": end_idx,
        }
    return None


def _oi_flush_state(
    oi_series: list[tuple[int, float]],
    bars: list[Bar],
) -> dict[str, Any]:
    out: dict[str, Any] = {"active": False, "dropPct": None, "wick": None, "bias": None}
    if not bars or len(oi_series) < 3:
        return out
    hit = _flush_at_bar(oi_series, bars, len(bars) - 1)
    if hit:
        out.update({k: hit[k] for k in ("active", "dropPct", "wick", "bias")})
    return out


def _find_past_flush(
    oi_series: list[tuple[int, float]],
    bars: list[Bar],
    *,
    max_bars_back: int = 24,
) -> dict[str, Any] | None:
    if len(bars) < 4:
        return None
    start = max(0, len(bars) - max_bars_back)
    for idx in range(len(bars) - 2, start - 1, -1):
        hit = _flush_at_bar(oi_series, bars, idx)
        if hit:
            return hit
    return None


def _oi_rebuild_against(
    oi_series: list[tuple[int, float]],
    bars: list[Bar],
) -> dict[str, Any]:
    out: dict[str, Any] = {"active": False, "priceDir": None, "oiRisePct": None}
    flush = _find_past_flush(oi_series, bars)
    if not flush:
        return out
    flush_idx = int(flush.get("barIdx") or 0)
    tail = bars[flush_idx + 1 :]
    if len(tail) < 2 or len(tail) > CF_REBUILD_BARS + 2:
        tail = bars[flush_idx + 1 : flush_idx + 1 + CF_REBUILD_BARS]
    if len(tail) < 2:
        return out
    oi_start = _oi_at_bar_close(oi_series, bars[flush_idx])
    oi_end = _oi_at_bar_close(oi_series, tail[-1])
    if oi_start is None or oi_end is None or oi_start <= 0:
        return out
    oi_rise = (oi_end - oi_start) / oi_start
    price_chg = (float(tail[-1]["c"]) - float(tail[0]["o"])) / float(tail[0]["o"])
    if oi_rise < CF_REBUILD_OI_RISE_PCT:
        return out
    price_dir = "up" if price_chg > 0.001 else ("down" if price_chg < -0.001 else "flat")
    if price_dir == "flat":
        return out
    out.update(
        {
            "active": True,
            "priceDir": price_dir,
            "oiRisePct": round(oi_rise * 100, 2),
        }
    )
    return out


def _funding_state(rate: float | None, *, funding_interval_hours: float = 8.0) -> dict[str, Any]:
    out: dict[str, Any] = {
        "rate": rate,
        "ratePct": None,
        "bias": None,
        "extreme": False,
        "fundingIntervalHours": funding_interval_hours,
    }
    if rate is None:
        return out
    scale = 8.0 / max(float(funding_interval_hours), 1.0)
    norm = rate * scale
    out["ratePct"] = round(rate * 100, 4)
    out["ratePct8h"] = round(norm * 100, 4)
    if norm >= CF_FUNDING_CROWDED_LONG:
        out.update({"bias": "short", "extreme": True})
    elif norm <= CF_FUNDING_CROWDED_SHORT:
        out.update({"bias": "long", "extreme": True})
    return out


def _whale_retail(
    global_series: list[tuple[int, float]],
    top_series: list[tuple[int, float]],
    time_sec: int,
) -> dict[str, Any]:
    g = _value_at_or_before(global_series, time_sec)
    t = _value_at_or_before(top_series, time_sec)
    out: dict[str, Any] = {"global": g, "top": t, "diverge": False, "whaleBias": None}
    if g is None or t is None:
        return out
    g_ex = g - 1.0
    t_ex = t - 1.0
    if g_ex * t_ex < 0 and abs(g_ex) > 0.02 and abs(t_ex) > 0.02:
        out["diverge"] = True
        out["whaleBias"] = "long" if t_ex > 0 else "short"
    return out


def _normalize_funding_rate(rate: float | None, funding_interval_hours: float) -> float | None:
    if rate is None:
        return None
    scale = 8.0 / max(float(funding_interval_hours), 1.0)
    return rate * scale


def _quiet_accumulation(
    bars: list[Bar],
    oi_series: list[tuple[int, float]],
    funding_rate: float | None,
    taker_series: list[tuple[int, float]],
    *,
    funding_interval_hours: float = 8.0,
) -> dict[str, Any]:
    out: dict[str, Any] = {"active": False}
    atr = _atr_pct(bars)
    if atr is None or atr > CF_QUIET_ATR_PCT_MAX:
        return out
    norm_fund = _normalize_funding_rate(funding_rate, funding_interval_hours)
    if norm_fund is not None and abs(norm_fund) > CF_FUNDING_NEUTRAL_ABS:
        return out
    if len(bars) < 6 or len(oi_series) < 4:
        return out
    last = bars[-1]
    oi_end = _oi_at_bar_close(oi_series, last)
    oi_start = _oi_at_bar_close(oi_series, bars[-6])
    if oi_end is None or oi_start is None or oi_start <= 0:
        return out
    oi_rise = (oi_end - oi_start) / oi_start
    if oi_rise < CF_QUIET_OI_RISE_PCT:
        return out
    taker_tail = _series_slice_upto(taker_series, int(last["time_sec"]))
    if len(taker_tail) < 4:
        return out
    recent = [v for _, v in taker_tail[-3:]]
    older = [v for _, v in taker_tail[-6:-3]] or recent
    if sum(recent) / len(recent) <= sum(older) / len(older) + 0.02:
        return out
    out["active"] = True
    out["oiRisePct"] = round(oi_rise * 100, 2)
    out["atrPct"] = round(atr, 3)
    return out


def _distribution(
    bars: list[Bar],
    oi_series: list[tuple[int, float]],
    taker_series: list[tuple[int, float]],
) -> dict[str, Any]:
    out: dict[str, Any] = {"active": False}
    if len(bars) < 22:
        return out
    last = bars[-1]
    vols = [float(b["v"]) for b in bars[-21:-1]]
    avg_vol = sum(vols) / len(vols) if vols else 0.0
    if avg_vol <= 0 or float(last["v"]) < avg_vol * CF_DIST_VOL_RATIO_MIN:
        return out
    prog = abs(float(last["c"]) - float(last["o"])) / float(last["o"]) * 100.0
    if prog > CF_DIST_PRICE_PROG_MAX:
        return out
    oi_end = _oi_at_bar_close(oi_series, last)
    oi_prev = _oi_at_bar_close(oi_series, bars[-4])
    if oi_end is None or oi_prev is None or oi_prev <= 0:
        return out
    if oi_end >= oi_prev:
        return out
    taker = _taker_at_bar_open(taker_series, last)
    if taker is None or taker > 0.48:
        return out
    highs = [float(b["h"]) for b in bars[-20:]]
    if float(last["c"]) < max(highs) * 0.97:
        return out
    out["active"] = True
    out["volRatio"] = round(float(last["v"]) / avg_vol, 2)
    return out


def _proxy_liq_spike_at(
    bars: list[Bar],
    oi_series: list[tuple[int, float]],
    i: int,
) -> tuple[bool, str]:
    b = bars[i]
    vols = [float(x["v"]) for x in bars[max(0, i - 20) : i]]
    avg_v = sum(vols) / len(vols) if vols else 0.0
    wick_ok, wick_side = _long_wick(b)
    if not wick_ok:
        return False, wick_side
    vol_spike = avg_v > 0 and float(b["v"]) >= avg_v * CF_LIQ_PROXY_VOL_RATIO
    if not vol_spike:
        return False, wick_side
    win = min(CF_LIQ_PROXY_OI_WINDOW, i)
    if win < 1:
        return False, wick_side
    oi_start = _oi_at_bar_close(oi_series, bars[i - win])
    oi_end = _oi_at_bar_close(oi_series, b)
    if oi_start is None or oi_end is None or oi_start <= 0:
        return False, wick_side
    oi_drop = (oi_start - oi_end) / oi_start
    return oi_drop >= CF_LIQ_PROXY_OI_DROP, wick_side


def _bar_index_for_event(bars: list[Bar], event_ms: int) -> int | None:
    for i, b in enumerate(bars):
        ot = int(b["open_time_ms"])
        ct = int(b["close_time_ms"])
        if ot <= event_ms <= ct:
            return i
    return None


def _liquidation_reclaim(
    bars: list[Bar],
    oi_series: list[tuple[int, float]],
    liq_events: list[dict[str, Any]],
) -> dict[str, Any]:
    out: dict[str, Any] = {"active": False, "source": None, "reclaimBias": None}
    if len(bars) < CF_LIQ_RECLAIM_BARS + 2:
        return out
    spike_idx: int | None = None
    spike_bar: Bar | None = None
    for i in range(len(bars) - CF_LIQ_RECLAIM_BARS - 1, max(0, len(bars) - 16), -1):
        ok, _ = _proxy_liq_spike_at(bars, oi_series, i)
        if ok:
            spike_idx = i
            spike_bar = bars[i]
            out["source"] = "proxy"
            break
    if spike_idx is None and liq_events:
        last_ms = int(bars[-1]["close_time_ms"])
        recent = sorted(
            [e for e in liq_events if int(e.get("eventTimeMs") or 0) >= last_ms - 12 * 3600_000],
            key=lambda e: int(e.get("eventTimeMs") or 0),
            reverse=True,
        )
        for ev in recent:
            idx = _bar_index_for_event(bars, int(ev.get("eventTimeMs") or 0))
            if idx is None or idx >= len(bars) - CF_LIQ_RECLAIM_BARS:
                continue
            b = bars[idx]
            vols = [float(x["v"]) for x in bars[max(0, idx - 20) : idx]]
            avg_v = sum(vols) / len(vols) if vols else 0.0
            wick_ok, _ = _long_wick(b)
            vol_ok = avg_v <= 0 or float(b["v"]) >= avg_v * (CF_LIQ_PROXY_VOL_RATIO * 0.85)
            if wick_ok and vol_ok:
                spike_idx = idx
                spike_bar = b
                out["source"] = "ws"
                break
    if spike_idx is None or spike_bar is None:
        return out
    upper, lower, body, wick_side = _wick_parts(spike_bar)
    reclaim_bars = bars[spike_idx + 1 : spike_idx + 1 + CF_LIQ_RECLAIM_BARS]
    if not reclaim_bars:
        return out
    o, c = float(spike_bar["o"]), float(spike_bar["c"])
    if wick_side == "lower":
        target = min(o, c) + lower * CF_LIQ_RECLAIM_WICK_FRAC
        reclaimed = any(float(b["c"]) >= target for b in reclaim_bars)
        bias = "long"
    elif wick_side == "upper":
        target = max(o, c) - upper * CF_LIQ_RECLAIM_WICK_FRAC
        reclaimed = any(float(b["c"]) <= target for b in reclaim_bars)
        bias = "short"
    else:
        return out
    if reclaimed:
        out.update({"active": True, "reclaimBias": bias})
    return out


def compute_capital_flow(
    *,
    signal_at_ms: int,
    klines: list[list[Any]],
    oi_series: list[tuple[int, float]],
    funding_rate: float | None,
    global_ls: list[tuple[int, float]],
    top_pos_ls: list[tuple[int, float]],
    taker_buy: list[tuple[int, float]],
    liq_events: list[dict[str, Any]] | None = None,
    interval: str = "15m",
    funding_interval_hours: float = 8.0,
) -> dict[str, Any]:
    bars = klines_to_bars(klines, signal_at_ms=signal_at_ms, interval=interval)
    flags: dict[str, bool] = {}
    raw: dict[str, Any] = {}
    bias: dict[str, str | None] = {}

    flush = _oi_flush_state(oi_series, bars)
    flags["oi_flush"] = bool(flush.get("active"))
    raw["oiFlushDropPct"] = flush.get("dropPct")
    bias["oi_flush"] = flush.get("bias")

    rebuild = _oi_rebuild_against(oi_series, bars)
    flags["oi_rebuild_against"] = bool(rebuild.get("active"))
    raw["oiRebuildOirisePct"] = rebuild.get("oiRisePct")
    raw["oiRebuildPriceDir"] = rebuild.get("priceDir")

    fund = _funding_state(funding_rate, funding_interval_hours=funding_interval_hours)
    flags["funding_extreme"] = bool(fund.get("extreme"))
    raw["fundingRate"] = fund.get("rate")
    raw["fundingRatePct"] = fund.get("ratePct")
    bias["funding_extreme"] = fund.get("bias")

    t_sec = int(bars[-1]["close_time_sec"]) if bars else signal_at_ms // 1000
    whale = _whale_retail(global_ls, top_pos_ls, t_sec)
    flags["whale_retail_divergence"] = bool(whale.get("diverge"))
    raw["globalLsRatio"] = whale.get("global")
    raw["topPosLsRatio"] = whale.get("top")
    bias["whale_retail_divergence"] = whale.get("whaleBias")

    quiet = _quiet_accumulation(
        bars,
        oi_series,
        funding_rate,
        taker_buy,
        funding_interval_hours=funding_interval_hours,
    )
    flags["quiet_accumulation"] = bool(quiet.get("active"))
    raw["quietAtrPct"] = quiet.get("atrPct")
    raw["quietOiRisePct"] = quiet.get("oiRisePct")
    bias["quiet_accumulation"] = "long" if quiet.get("active") else None

    dist = _distribution(bars, oi_series, taker_buy)
    flags["distribution"] = bool(dist.get("active"))
    raw["distVolRatio"] = dist.get("volRatio")
    bias["distribution"] = "short" if dist.get("active") else None

    liq = _liquidation_reclaim(bars, oi_series, liq_events or [])
    flags["liquidation_reclaim"] = bool(liq.get("active"))
    raw["liqReclaimSource"] = liq.get("source")
    bias["liquidation_reclaim"] = liq.get("reclaimBias")

    cov_days = oi_coverage_days(_series_slice_upto(oi_series, t_sec))
    return {
        "raw": raw,
        "flags": flags,
        "bias": bias,
        "coverage": {
            "oiDays": cov_days,
            "barCount": len(bars),
            "oiPoints": len(_series_slice_upto(oi_series, t_sec)),
        },
    }


def capital_flow_aligns_side(cf: dict[str, Any], side: str) -> dict[str, bool]:
    """各特征是否支持信号方向（long/short/bull/bear）。"""
    s = "long" if side in ("long", "bull") else ("short" if side in ("short", "bear") else "")
    if not s:
        return {}
    bias = cf.get("bias") if isinstance(cf.get("bias"), dict) else {}
    flags = cf.get("flags") if isinstance(cf.get("flags"), dict) else {}
    out: dict[str, bool] = {}
    for key in (
        "oi_flush",
        "funding_extreme",
        "whale_retail_divergence",
        "quiet_accumulation",
        "distribution",
        "liquidation_reclaim",
    ):
        if not flags.get(key):
            out[key] = False
            continue
        b = bias.get(key)
        out[key] = b == s if b else False
    if flags.get("oi_rebuild_against"):
        pd = (cf.get("raw") or {}).get("oiRebuildPriceDir")
        rebuild_side = "long" if pd == "up" else ("short" if pd == "down" else None)
        out["oi_rebuild_penalty"] = rebuild_side is not None and rebuild_side != s
        out["oi_rebuild_align"] = rebuild_side == s
    else:
        out["oi_rebuild_penalty"] = False
        out["oi_rebuild_align"] = False
    return out


def confluence_feature_keys(cf: dict[str, Any], side: str) -> set[str]:
    """映射到共振特征键（加性权重）。"""
    align = capital_flow_aligns_side(cf, side)
    feats: set[str] = set()
    mapping = {
        "oi_flush": "feat:cf_oi_flush_align",
        "funding_extreme": "feat:cf_funding_align",
        "whale_retail_divergence": "feat:cf_whale_align",
        "quiet_accumulation": "feat:cf_quiet_accum",
        "liquidation_reclaim": "feat:cf_liq_reclaim",
        "oi_rebuild_align": "feat:cf_oi_rebuild_align",
    }
    for k, feat_key in mapping.items():
        if align.get(k):
            feats.add(feat_key)
    if align.get("oi_rebuild_penalty"):
        feats.add("feat:cf_oi_rebuild_penalty")
    flags = cf.get("flags") if isinstance(cf.get("flags"), dict) else {}
    if flags.get("funding_extreme") and not align.get("funding_extreme"):
        feats.add("feat:cf_funding_against")
    if flags.get("distribution"):
        s = "long" if side in ("long", "bull") else ("short" if side in ("short", "bear") else "")
        if s == "short" and align.get("distribution"):
            feats.add("feat:cf_distribution")
        elif s == "long":
            feats.add("feat:cf_distribution_against")
    return feats


def format_capital_flow_tg_line(cf: dict[str, Any] | None) -> str:
    if not cf or not isinstance(cf, dict):
        return ""
    raw = cf.get("raw") if isinstance(cf.get("raw"), dict) else {}
    parts: list[str] = []
    if raw.get("oiFlushDropPct") is not None:
        parts.append(f"OI骤降{raw['oiFlushDropPct']}%")
    if raw.get("fundingRatePct") is not None:
        parts.append(f"费率{raw['fundingRatePct']:+.3f}%")
    if raw.get("topPosLsRatio") is not None:
        top = float(raw["topPosLsRatio"])
        parts.append("大户偏多" if top > 1.02 else ("大户偏空" if top < 0.98 else "大户均衡"))
    if raw.get("quietOiRisePct") is not None and (cf.get("flags") or {}).get("quiet_accumulation"):
        parts.append("吸筹")
    if (cf.get("flags") or {}).get("distribution"):
        parts.append("派发")
    if (cf.get("flags") or {}).get("liquidation_reclaim"):
        parts.append("清算回收")
    if not parts:
        return ""
    return "资金：" + "·".join(parts[:5])
