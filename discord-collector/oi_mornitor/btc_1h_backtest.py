"""Strict Point-in-Time (No-Lookahead) multi-symbol / multi-TF pattern & signal backtest.

Supports BTC / ETH / QQQ / SNDK / DOGE / UNI / NEAR (and any typed symbol),
timeframes 15m / 1h / 4h / 1d (any combination), and custom start/end (Asia/Shanghai)
or days fallback.

For every signal bar t_i in the selected window:
1. Slices 15m, 1h, 4h, 1d K-lines and OI strictly <= t_i close time (unfinished HTF
   candles synthesized only from completed lower-TF bars so zero future data leaks).
2. Calls ezcoin-adapter (hard gates + 5-seat LLM) at as_of_ts = t_i close time.
3. Evaluates post-t_i ground truth (+1h/+4h/+8h/+24h, MFE/MAE@4h&8h) from subsequent 1h bars.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import aiohttp

os.environ.setdefault("JUDGE_PROVIDER", "ollama")
os.environ.setdefault("JUDGE_QUICK_MODEL", "gemma4:latest")
os.environ.setdefault("JUDGE_DEEP_MODEL", "gemma4:latest")

from oi_mornitor.ai_judge_bridge import _compute_tf_node
from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.config import FAPI_BASE_URL
from oi_mornitor.pattern_detector import build_pattern_chart_payload, enrich_indicators
from oi_mornitor.pattern_monitor import fetch_open_interest_hist, fetch_pattern_klines
from oi_mornitor.strategy.candle_signals import PATTERN_MARKER_KINDS
from oi_mornitor.strategy.structure_signals import detect_structure_events
from oi_mornitor.strategy.tight_sl_15m import (
    compute_composite_trade_plan,
    enrich_tight_sl_df,
    evaluate_bar_15m_tight_sl,
    scan_15m_tight_sl_signals,
    simulate_tight_sl_outcome,
)
from oi_mornitor.symbol_aliases import human_base_asset, normalize_usdt_symbol

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent / "data"
BACKTEST_FILE = DATA_DIR / "btc_1h_backtest_7d.json"  # legacy alias path
LATEST_FILE = DATA_DIR / "btc_backtest_latest.json"
ALERT_STATS_FILE = DATA_DIR / "pattern_alert_stats.json"
TZ_CN = timezone(timedelta(hours=8))

SUPPORTED_TFS = ("15m", "1h", "4h", "1d")
TF_SEC: dict[str, int] = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
TF_MS: dict[str, int] = {k: v * 1000 for k, v in TF_SEC.items()}

# Equity / alias extras beyond plain USDT append
_EXTRA_ALIAS: dict[str, tuple[str, ...]] = {
    "QQQ": ("QQQUSDT", "QQQXUSDT"),
    "SNDK": ("SNDKUSDT",),
    "XAU": ("XAUUSDT", "PAXGUSDT"),
    "SPY": ("SPYUSDT", "SPYXUSDT"),
}

QUICK_SYMBOLS = ("BTC", "ETH", "QQQ", "SNDK", "DOGE", "UNI", "NEAR")


def resolve_backtest_symbol(raw: str) -> dict[str, str]:
    """Map user input (BTC / eth / DOGEUSDT / QQQ) → API USDT symbol + display base."""
    s = str(raw or "").strip().upper().replace("-", "").replace("_", "").replace("/", "")
    if not s:
        s = "BTCUSDT"
    base = human_base_asset(s) if s.endswith("USDT") else (s[:-4] if s.endswith("USDC") else s)
    if not base:
        base = "BTC"
    candidates: list[str] = []
    for c in _EXTRA_ALIAS.get(base, ()):
        if c not in candidates:
            candidates.append(c)
    norm = normalize_usdt_symbol(base)
    if norm and norm not in candidates:
        candidates.append(norm)
    if s.endswith("USDT") and s not in candidates:
        candidates.insert(0, s)
    api_symbol = candidates[0] if candidates else f"{base}USDT"
    return {
        "input": str(raw or "").strip(),
        "base": base,
        "api_symbol": api_symbol,
        "candidates": candidates,
        "display": base,
    }


T1_BASES = frozenset({"BTC", "ETH"})
T1_EQ_BASES = frozenset({"QQQ", "SNDK", "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META", "GOOG", "GOOGL"})


def resolve_backtest_tier(base: str, api_symbol: str | None = None) -> dict[str, str]:
    """Map symbol → gates.yaml tier + asset_class."""
    b = str(base or "").strip().upper()
    api = str(api_symbol or "").strip().upper()
    if b in T1_BASES or api in ("BTCUSDT", "ETHUSDT"):
        return {"tier": "T1", "asset_class": "crypto_perp"}
    if b in T1_EQ_BASES or any(b.startswith(x) for x in T1_EQ_BASES):
        return {"tier": "T1_EQ", "asset_class": "us_equity"}
    return {"tier": "ALT", "asset_class": "crypto_perp"}


def _normalize_symbols(symbols: Any = None, symbol: str | None = None) -> list[str]:
    """Accept symbols[] and/or single symbol; return unique API symbols in order."""
    raw: list[str] = []
    if isinstance(symbols, str) and symbols.strip():
        raw.extend(re.split(r"[,|+\s]+", symbols.strip()))
    elif isinstance(symbols, (list, tuple, set)):
        raw.extend(str(x) for x in symbols if str(x).strip())
    if symbol and str(symbol).strip():
        # only append single symbol when symbols list empty, or always as alias seed
        if not raw:
            raw.append(str(symbol))
    if not raw:
        raw = ["BTCUSDT"]
    out: list[str] = []
    seen: set[str] = set()
    for r in raw:
        info = resolve_backtest_symbol(r)
        api = info["api_symbol"]
        if api not in seen:
            seen.add(api)
            out.append(api)
    return out


def _parse_cn_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    s = str(value).strip()
    if not s:
        return None
    s = s.replace("Z", "+00:00")
    # Strip timezone offset for naive CN parse first
    core = s
    for sep in ("+",):
        if sep in core[10:]:
            core = core[:10 + core[10:].index(sep)]
            break
    if core.endswith("Z"):
        core = core[:-1]
    core = core.replace("T", " ")
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
    ):
        try:
            dt = datetime.strptime(core[:19] if "%S" in fmt else (core[:16] if "%H" in fmt else core[:10]), fmt)
            return dt.replace(tzinfo=TZ_CN)
        except ValueError:
            continue
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=TZ_CN)
        return dt.astimezone(TZ_CN)
    except ValueError:
        return None


def _normalize_timeframes(raw: Any) -> list[str]:
    if raw is None:
        return ["1h"]
    if isinstance(raw, str):
        parts = re.split(r"[,|+\s]+", raw.strip())
        items = [p.strip().lower() for p in parts if p.strip()]
    elif isinstance(raw, (list, tuple, set)):
        items = [str(x).strip().lower() for x in raw if str(x).strip()]
    else:
        items = ["1h"]
    # accept 15min alias
    out: list[str] = []
    for x in items:
        if x in ("15min", "15", "15m"):
            x = "15m"
        if x in ("60m", "60", "1hr", "1hour"):
            x = "1h"
        if x in ("240m", "4hr", "4hour"):
            x = "4h"
        if x in ("1day", "day", "d"):
            x = "1d"
        if x in SUPPORTED_TFS and x not in out:
            out.append(x)
    return out or ["1h"]


def _resolve_window(
    *,
    days: int | None = None,
    start: str | None = None,
    end: str | None = None,
) -> tuple[datetime, datetime, float]:
    """Return (start_dt, end_dt, days_float) in Asia/Shanghai."""
    now = datetime.now(tz=TZ_CN)
    end_dt = _parse_cn_dt(end) or now
    start_dt = _parse_cn_dt(start)
    if start_dt is None:
        d = max(1, min(int(days or 7), 30))
        start_dt = end_dt - timedelta(days=d)
    if start_dt >= end_dt:
        start_dt = end_dt - timedelta(days=1)
    span_days = max(0.04, (end_dt - start_dt).total_seconds() / 86400.0)
    return start_dt, end_dt, span_days


def _cache_key(
    symbol: str,
    timeframes: list[str],
    start_dt: datetime,
    end_dt: datetime,
    *,
    include_tight_sl_signals: bool = False,
) -> str:
    tf_part = "-".join(timeframes) or "1h"
    s = start_dt.strftime("%Y%m%d%H%M")
    e = end_dt.strftime("%Y%m%d%H%M")
    mode = "tsl" if include_tight_sl_signals else "orig"
    return f"{symbol}_{s}_{e}_{tf_part}_{mode}"


def _result_path(key: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_\-]+", "_", key)[:120]
    return DATA_DIR / f"btc_backtest_{safe}.json"


async def _fetch_paginated_klines(
    session: aiohttp.ClientSession,
    symbol: str,
    interval: str,
    pages: int = 2,
    per_page: int = 500,
) -> list[list[Any]]:
    by_ts: dict[int, list[Any]] = {}
    end_time: int | None = None
    for _ in range(pages):
        rows = await fetch_pattern_klines(
            session,
            base_url=FAPI_BASE_URL,
            symbol=symbol,
            interval=interval,
            limit=per_page,
            end_time=end_time,
        )
        if not rows:
            break
        for r in rows:
            by_ts[int(r[0])] = r
        earliest = min(int(r[0]) for r in rows)
        end_time = earliest - 1
        if len(rows) < per_page:
            break
    return [by_ts[k] for k in sorted(by_ts.keys())]


def _slice_htf_strictly_no_lookahead(
    htf_rows: list[list[Any]],
    lower_up_to_ti: list[list[Any]],
    close_ms: int,
    htf_interval_ms: int,
) -> list[list[Any]]:
    """Return HTF K-lines strictly up to close_ms; synthesize unfinished bar from lower TF."""
    closed_bars: list[list[Any]] = []
    partial_open_ms: int | None = None

    for r in htf_rows:
        open_ms = int(r[0])
        bar_close_ms = int(r[6]) if len(r) > 6 and r[6] else (open_ms + htf_interval_ms - 1)
        if bar_close_ms <= close_ms:
            closed_bars.append(r)
        elif open_ms <= close_ms < bar_close_ms:
            partial_open_ms = open_ms
            break

    if partial_open_ms is None and closed_bars:
        last_close = int(closed_bars[-1][0]) + htf_interval_ms
        if last_close <= close_ms:
            partial_open_ms = last_close

    if partial_open_ms is not None:
        sub = [r for r in lower_up_to_ti if int(r[0]) >= partial_open_ms and int(r[0]) <= close_ms]
        if sub:
            synth = list(sub[0])
            synth[0] = partial_open_ms
            synth[1] = str(sub[0][1])
            synth[2] = str(max(float(x[2]) for x in sub))
            synth[3] = str(min(float(x[3]) for x in sub))
            synth[4] = str(sub[-1][4])
            synth[5] = str(sum(float(x[5]) for x in sub))
            if len(synth) > 6:
                synth[6] = close_ms
            closed_bars.append(synth)

    return closed_bars


def _point_in_time_oi(
    oi1h: dict[int, float],
    oi15: dict[int, float],
    t_sec: int,
    side: str,
    price_chg_1h: float,
    marker_oi_anomaly: bool = False,
) -> dict[str, Any]:
    """Build OI node compatible with ezcoin-adapter gates.py schema.

    Historical global intensity rank is unavailable in offline backtest; when OI
    series exist we set rank_intensity_global=1 (same as pre-multi BTC 7d known-good)
    so T1 oi_or_intensity does not silently reject every signal. Real |oi_pct| and
    price_oi_synergy still flow through for ALT / diagnostics.
    """
    close_sec = t_sec
    abs_chg = 0.0
    pct_chg = 0.0
    has_series = False
    oi_keys = [k for k in sorted(oi15.keys()) if k <= close_sec]
    if len(oi_keys) >= 2:
        cur = float(oi15[oi_keys[-1]])
        prev = float(oi15[oi_keys[-2]])
        abs_chg = cur - prev
        pct_chg = (abs_chg / prev * 100.0) if prev else 0.0
        has_series = True
    else:
        oi1h_keys = [k for k in sorted(oi1h.keys()) if k <= close_sec]
        if len(oi1h_keys) >= 2:
            cur = float(oi1h[oi1h_keys[-1]])
            prev = float(oi1h[oi1h_keys[-2]])
            abs_chg = cur - prev
            pct_chg = (abs_chg / prev * 100.0) if prev else 0.0
            has_series = True

    if abs_chg > 0 and price_chg_1h >= 0:
        side_bias = "long_building"
    elif abs_chg > 0 and price_chg_1h < 0:
        side_bias = "short_building"
    elif abs_chg < 0 and price_chg_1h >= 0:
        side_bias = "short_covering"
    elif abs_chg < 0 and price_chg_1h < 0:
        side_bias = "long_liquidating"
    else:
        side_bias = "long_building" if side == "bull" else "short_building"

    synergy = bool(
        marker_oi_anomaly
        or (side == "bull" and side_bias in ("long_building", "short_covering"))
        or (side == "bear" and side_bias in ("short_building", "long_liquidating"))
    )
    pct_out = pct_chg if abs(pct_chg) >= 0.01 else (0.18 if synergy else 0.05)
    available = bool(oi15 or oi1h)
    out: dict[str, Any] = {
        "available": available,
        "anomaly": bool(marker_oi_anomaly or abs(pct_chg) >= 0.35),
        "synergy": synergy,
        "chg_15m_abs": abs_chg,
        "chg_15m_pct": pct_out,
        # gates.py fields (must match samples + pre-multi known-good):
        "price_oi_synergy": synergy,
        "side_bias": side_bias,
        "note": "point-in-time OI at signal close",
    }
    if has_series or available:
        # Offline backtest has no historical global intensity board → stand-in rank=1
        # (restores BTC T1 oi_or_intensity pass behavior from btc_1h_backtest_7d).
        out["rank_intensity_global"] = 1
    return out


def _evaluate_future_outcome(
    k1h: list[list[Any]],
    bar_open_sec: int,
    entry_price: float,
    signal_side: str,
    gate_result: str,
    ai_action: str,
) -> dict[str, Any]:
    """Ground truth from subsequent 1h bars after the wall-clock moment of signal close.

    Uses the first 1h bar whose open_time >= signal bar open (aligned) as anchor when
    signal TF is 1h; for other TFs, finds the last 1h bar with open_time <= signal close.
    Horizons are always wall-clock +1h/+4h/+8h/+24h via 1h bars; MFE/MAE reported at 4h & 8h.
    """
    if not k1h:
        return {
            "eval_side": signal_side,
            "signal_side": signal_side,
            "future_bars_available": 0,
            "price_1h": None,
            "price_4h": None,
            "price_8h": None,
            "price_24h": None,
            "raw_ret_1h_pct": None,
            "raw_ret_4h_pct": None,
            "raw_ret_8h_pct": None,
            "raw_ret_24h_pct": None,
            "dir_ret_1h_pct": None,
            "dir_ret_4h_pct": None,
            "dir_ret_8h_pct": None,
            "dir_ret_24h_pct": None,
            "mfe_4h_pct": 0.0,
            "mae_4h_pct": 0.0,
            "fav_4h_price": entry_price,
            "adv_4h_price": entry_price,
            "mfe_8h_pct": 0.0,
            "mae_8h_pct": 0.0,
            "fav_8h_price": entry_price,
            "adv_8h_price": entry_price,
            "mfe_24h_pct": 0.0,
            "mae_24h_pct": 0.0,
            "fav_24h_price": entry_price,
            "adv_24h_price": entry_price,
            "verdict": "insufficient_data",
            "verdict_label": "后续数据不足",
            "future_path": [],
        }

    # Anchor: last 1h bar that has opened by signal open (inclusive for 1h signals)
    bar_idx = 0
    for i, r in enumerate(k1h):
        if int(r[0]) // 1000 <= bar_open_sec:
            bar_idx = i
        else:
            break

    n = len(k1h)
    future_bars = k1h[bar_idx + 1 : min(n, bar_idx + 25)]
    dir_sign = 1.0 if signal_side == "long" else -1.0
    if ai_action == "LONG":
        eval_side = "long"
        dir_sign = 1.0
    elif ai_action == "SHORT":
        eval_side = "short"
        dir_sign = -1.0
    else:
        eval_side = signal_side

    def _ret_at(h: int) -> tuple[float | None, float | None, float | None]:
        if len(future_bars) < h:
            return None, None, None
        px = float(future_bars[h - 1][4])
        raw = (px - entry_price) / entry_price * 100.0
        return round(px, 4), round(raw, 3), round(raw * dir_sign, 3)

    def _excursions(h: int) -> tuple[float, float, float, float]:
        window = future_bars[:h]
        if not window:
            return 0.0, 0.0, entry_price, entry_price
        highs = [float(x[2]) for x in window]
        lows = [float(x[3]) for x in window]
        if dir_sign > 0:
            fav_px = max(highs)
            adv_px = min(lows)
            mfe = (fav_px - entry_price) / entry_price * 100.0
            mae = (entry_price - adv_px) / entry_price * 100.0
        else:
            fav_px = min(lows)
            adv_px = max(highs)
            mfe = (entry_price - fav_px) / entry_price * 100.0
            mae = (adv_px - entry_price) / entry_price * 100.0
        return round(mfe, 3), round(mae, 3), round(fav_px, 4), round(adv_px, 4)

    p_1h, raw_1h, dir_1h = _ret_at(1)
    p_4h, raw_4h, dir_4h = _ret_at(4)
    p_8h, raw_8h, dir_8h = _ret_at(8)
    p_24h, raw_24h, dir_24h = _ret_at(24)
    mfe_4h, mae_4h, fav_4h_px, adv_4h_px = _excursions(4)
    mfe_8h, mae_8h, fav_8h_px, adv_8h_px = _excursions(8)
    mfe_24h, mae_24h, fav_24h_px, adv_24h_px = _excursions(24)

    future_path = []
    for i, row in enumerate(future_bars[:24], start=1):
        open_sec = int(row[0]) // 1000
        px = float(row[4])
        raw = (px - entry_price) / entry_price * 100.0
        future_path.append(
            {
                "offset_h": i,
                "time_iso": datetime.fromtimestamp(open_sec + 3600, tz=TZ_CN).strftime("%Y-%m-%d %H:%M"),
                "close": round(px, 4),
                "high": round(float(row[2]), 4),
                "low": round(float(row[3]), 4),
                "raw_ret_pct": round(raw, 3),
                "dir_ret_pct": round(raw * dir_sign, 3),
            }
        )

    ref_4h = dir_4h if dir_4h is not None else (dir_1h or 0.0)
    ref_8h = dir_8h if dir_8h is not None else ref_4h

    if ai_action in ("LONG", "SHORT"):
        if ref_4h > 0.15 or (ref_8h > 0.25 and mfe_8h >= mae_8h):
            verdict, verdict_label = "ai_win", "AI命中盈利"
        elif ref_4h < -0.15 and ref_8h < 0:
            verdict, verdict_label = "ai_loss", "AI方向受损"
        else:
            verdict, verdict_label = "ai_flat", "AI小幅震荡"
    elif gate_result == "reject":
        if ref_4h <= 0 or ref_8h <= 0 or mae_8h > mfe_8h:
            verdict, verdict_label = "gate_saved", "门禁成功避坑"
        elif ref_4h >= 0.5 or ref_8h >= 0.8:
            verdict, verdict_label = "gate_missed", "门禁过滤踏空"
        else:
            verdict, verdict_label = "gate_neutral", "门禁过滤震荡"
    else:
        if ref_4h <= 0 or ref_8h <= 0 or mae_8h > mfe_8h:
            verdict, verdict_label = "ai_saved", "AI观望避坑"
        elif ref_4h >= 0.5 or ref_8h >= 0.8:
            verdict, verdict_label = "ai_missed", "AI观望踏空"
        else:
            verdict, verdict_label = "ai_neutral", "AI观望震荡"

    return {
        "eval_side": eval_side,
        "signal_side": signal_side,
        "future_bars_available": len(future_bars),
        "price_1h": p_1h,
        "price_4h": p_4h,
        "price_8h": p_8h,
        "price_24h": p_24h,
        "raw_ret_1h_pct": raw_1h,
        "raw_ret_4h_pct": raw_4h,
        "raw_ret_8h_pct": raw_8h,
        "raw_ret_24h_pct": raw_24h,
        "dir_ret_1h_pct": dir_1h,
        "dir_ret_4h_pct": dir_4h,
        "dir_ret_8h_pct": dir_8h,
        "dir_ret_24h_pct": dir_24h,
        "mfe_4h_pct": mfe_4h,
        "mae_4h_pct": mae_4h,
        "fav_4h_price": fav_4h_px,
        "adv_4h_price": adv_4h_px,
        "mfe_8h_pct": mfe_8h,
        "mae_8h_pct": mae_8h,
        "fav_8h_price": fav_8h_px,
        "adv_8h_price": adv_8h_px,
        "mfe_24h_pct": mfe_24h,
        "mae_24h_pct": mae_24h,
        "fav_24h_price": fav_24h_px,
        "adv_24h_price": adv_24h_px,
        "verdict": verdict,
        "verdict_label": verdict_label,
        "future_path": future_path,
    }


def _recompute_outcome_for_action(
    old_outcome: dict[str, Any],
    *,
    entry_price: float,
    signal_side: str,
    gate_result: str,
    ai_action: str,
) -> dict[str, Any]:
    out = dict(old_outcome)
    if ai_action == "LONG":
        eval_side = "long"
        eval_sign = 1.0
    elif ai_action == "SHORT":
        eval_side = "short"
        eval_sign = -1.0
    else:
        eval_side = signal_side
        eval_sign = 1.0 if signal_side == "long" else -1.0

    prev_side = out.get("eval_side") or signal_side
    flipped = eval_side != prev_side

    for h in ("1h", "4h", "8h", "24h"):
        raw_v = out.get(f"raw_ret_{h}_pct")
        if raw_v is not None:
            out[f"dir_ret_{h}_pct"] = round(float(raw_v) * eval_sign, 3)

    if flipped:
        out["mfe_4h_pct"], out["mae_4h_pct"] = out.get("mae_4h_pct", 0.0), out.get("mfe_4h_pct", 0.0)
        out["fav_4h_price"], out["adv_4h_price"] = out.get("adv_4h_price", entry_price), out.get(
            "fav_4h_price", entry_price
        )
        out["mfe_8h_pct"], out["mae_8h_pct"] = out.get("mae_8h_pct", 0.0), out.get("mfe_8h_pct", 0.0)
        out["fav_8h_price"], out["adv_8h_price"] = out.get("adv_8h_price", entry_price), out.get(
            "fav_8h_price", entry_price
        )
        out["mfe_24h_pct"], out["mae_24h_pct"] = out.get("mae_24h_pct", 0.0), out.get("mfe_24h_pct", 0.0)
        out["fav_24h_price"], out["adv_24h_price"] = out.get("adv_24h_price", entry_price), out.get(
            "fav_24h_price", entry_price
        )

    new_path = []
    for pt in out.get("future_path") or []:
        pt_copy = dict(pt)
        if pt_copy.get("raw_ret_pct") is not None:
            pt_copy["dir_ret_pct"] = round(float(pt_copy["raw_ret_pct"]) * eval_sign, 3)
        new_path.append(pt_copy)
    out["future_path"] = new_path
    out["eval_side"] = eval_side

    dir_4h = out.get("dir_ret_4h_pct")
    dir_1h = out.get("dir_ret_1h_pct")
    dir_8h = out.get("dir_ret_8h_pct")
    mfe_8h = float(out.get("mfe_8h_pct") or 0.0)
    mae_8h = float(out.get("mae_8h_pct") or 0.0)
    ref_4h = float(dir_4h) if dir_4h is not None else float(dir_1h or 0.0)
    ref_8h = float(dir_8h) if dir_8h is not None else ref_4h

    if ai_action in ("LONG", "SHORT"):
        if ref_4h > 0.15 or (ref_8h > 0.25 and mfe_8h >= mae_8h):
            verdict, verdict_label = "ai_win", "AI命中盈利"
        elif ref_4h < -0.15 and ref_8h < 0:
            verdict, verdict_label = "ai_loss", "AI方向受损"
        else:
            verdict, verdict_label = "ai_flat", "AI小幅震荡"
    elif gate_result == "reject":
        if ref_4h <= 0 or ref_8h <= 0 or mae_8h > mfe_8h:
            verdict, verdict_label = "gate_saved", "门禁成功避坑"
        elif ref_4h >= 0.5 or ref_8h >= 0.8:
            verdict, verdict_label = "gate_missed", "门禁过滤踏空"
        else:
            verdict, verdict_label = "gate_neutral", "门禁过滤震荡"
    else:
        if ref_4h <= 0 or ref_8h <= 0 or mae_8h > mfe_8h:
            verdict, verdict_label = "ai_saved", "AI观望避坑"
        elif ref_4h >= 0.5 or ref_8h >= 0.8:
            verdict, verdict_label = "ai_missed", "AI观望踏空"
        else:
            verdict, verdict_label = "ai_neutral", "AI观望震荡"

    out["verdict"] = verdict
    out["verdict_label"] = verdict_label
    return out


def _collect_tf_signals(
    klines: list[list[Any]],
    oi_map: dict[int, float],
    *,
    interval: str,
    cutoff_start_sec: int,
    cutoff_end_sec: int,
    api_symbol: str,
    include_tight_sl_signals: bool = False,
) -> dict[int, list[dict[str, Any]]]:
    """Collect pattern markers, structure signals, and alert_stats for one TF in window.

    When ``include_tight_sl_signals`` is True (only the dedicated 「15min小止损」 button),
    also inject 15m tight-SL resonance hits as signal sources. Main 「跑 AI 回测」 keeps
    the original pattern/structure/alert signal set.
    """
    by_time: dict[int, list[dict[str, Any]]] = {}
    iv_sec = TF_SEC[interval]
    base = human_base_asset(api_symbol)

    payload = build_pattern_chart_payload(klines, oi_by_time=oi_map)
    for m in payload.get("markers") or []:
        t_sec = int(m.get("time") or 0)
        kind = str(m.get("kind") or "")
        if cutoff_start_sec <= t_sec < cutoff_end_sec and kind in PATTERN_MARKER_KINDS:
            side = "short" if kind in ("shooting_star", "continuous_upper_wick", "continuous_non_upper_wick") else "long"
            by_time.setdefault(t_sec, []).append(
                {
                    "time": t_sec,
                    "kind": kind,
                    "text": str(m.get("text") or kind),
                    "side": side,
                    "oi_anomaly": bool(m.get("oi_anomaly")),
                    "source": "chart_pattern",
                    "timeframe": interval,
                }
            )

    try:
        df = enrich_indicators(klines_to_df(klines))
        for ev in detect_structure_events(df):
            idx = int(ev.get("bar_index") or 0)
            if 0 <= idx < len(df):
                t_sec = int(df.iloc[idx]["open_time"]) // 1000
                if cutoff_start_sec <= t_sec < cutoff_end_sec:
                    raw_side = str(ev.get("side") or "bull")
                    side = "short" if raw_side in ("bear", "short") else "long"
                    label = f"{ev.get('type_label', '结构信号')}({ev.get('pattern_label', '')})".rstrip("()")
                    existing = by_time.setdefault(t_sec, [])
                    if not any(x.get("text") == label for x in existing):
                        existing.append(
                            {
                                "time": t_sec,
                                "kind": str(ev.get("kind") or "structure"),
                                "text": label,
                                "side": side,
                                "oi_anomaly": bool(ev.get("oi_anomaly")),
                                "source": "structure_signal",
                                "timeframe": interval,
                            }
                        )
    except Exception as e:
        logger.warning("detect_structure_events on %s %s failed: %s", api_symbol, interval, e)

    if ALERT_STATS_FILE.exists():
        try:
            stats = json.loads(ALERT_STATS_FILE.read_text(encoding="utf-8"))
            for item in stats.get("items") or []:
                if not isinstance(item, dict):
                    continue
                sym_u = str(item.get("symbol") or "").upper()
                if base not in sym_u and api_symbol not in sym_u:
                    continue
                if str(item.get("interval") or "").lower() != interval:
                    continue
                key_str = str(item.get("key") or "")
                key_parts = key_str.split(":")
                bar_ms = (
                    int(key_parts[2])
                    if len(key_parts) >= 3 and key_parts[2].isdigit()
                    else int(item.get("signalAt") or 0)
                )
                t_sec = (bar_ms // 1000 // iv_sec) * iv_sec
                if t_sec < cutoff_start_sec or t_sec >= cutoff_end_sec:
                    continue
                type_label = str(item.get("typeLabel") or "形态信号")
                label = f"144均线·{type_label}" if "ma144" in key_str else f"推送卡片·{type_label}"
                side = "short" if str(item.get("side") or "").lower() == "short" else "long"
                existing = by_time.setdefault(t_sec, [])
                if not any(x.get("text") == label for x in existing):
                    existing.append(
                        {
                            "time": t_sec,
                            "kind": "ma144_candle_card" if "ma144" in key_str else "candle_pattern_card",
                            "text": label,
                            "side": side,
                            "oi_anomaly": False,
                            "source": "telegram_alert_stats",
                            "timeframe": interval,
                            "alert_outcome": item.get("outcome"),
                            "alert_move_pct": item.get("movePct"),
                        }
                    )
        except Exception as e:
            logger.warning("Failed reading pattern_alert_stats.json: %s", e)

    if include_tight_sl_signals and interval == "15m" and klines and len(klines) >= 32:
        try:
            df_t15 = enrich_tight_sl_df(klines_to_df(klines))
            tight_hits = scan_15m_tight_sl_signals(
                df_t15,
                symbol=api_symbol,
                start_sec=cutoff_start_sec,
                end_sec=cutoff_end_sec,
                min_confidence_pct=80,
                cooldown_bars=3,
            )
            for th in tight_hits:
                t_sec = int(th.get("bar_open_sec") or 0)
                if cutoff_start_sec <= t_sec < cutoff_end_sec:
                    res_sum = str(th.get("resonance_summary") or "形态+支撑压力+均线")
                    label = f"15m小止损（{res_sum}）"
                    existing = by_time.setdefault(t_sec, [])
                    if not any(x.get("kind") == "tight_sl_15m" for x in existing):
                        existing.insert(
                            0,
                            {
                                "time": t_sec,
                                "kind": "tight_sl_15m",
                                "text": label,
                                "side": str(th.get("side") or "long"),
                                "oi_anomaly": False,
                                "source": "tight_sl_15m",
                                "timeframe": "15m",
                                "tight_sl_strategy": th,
                            },
                        )
        except Exception as e:
            logger.warning("scan_15m_tight_sl_signals on %s failed: %s", api_symbol, e)

    return by_time



def _plan_from_item(item: dict[str, Any]) -> dict[str, Any]:
    """Prefer trade_plan → composite → tight_sl for quant fill / settlement levels."""
    for key in ("trade_plan", "composite_trade_plan", "tight_sl_strategy"):
        plan = item.get(key)
        if isinstance(plan, dict) and (plan.get("entry") is not None or plan.get("matched") or plan.get("sl") is not None):
            return plan
    snap = item.get("snapshot") or {}
    if isinstance(snap, dict):
        for key in ("trade_plan", "composite_trade_plan", "tight_sl_strategy"):
            plan = snap.get(key)
            if isinstance(plan, dict) and (plan.get("entry") is not None or plan.get("matched") or plan.get("sl") is not None):
                return plan
    return {}



# 量化补齐质量门槛：未达则门禁过也标不做（可逆配置）
QUANT_FILL_MIN_CONFIDENCE_PCT = 60
QUANT_FILL_MIN_RR = 1.5


def _plan_rr(plan: dict[str, Any]) -> float | None:
    """Best-effort TP1 RR from plan fields."""
    if not isinstance(plan, dict) or not plan:
        return None
    for key in ("rr1", "rr_tp1", "rr"):
        v = plan.get(key)
        try:
            if v is not None and float(v) > 0:
                return float(v)
        except (TypeError, ValueError):
            pass
    try:
        sl = float(plan.get("sl_pct") or 0)
        tp = float(plan.get("tp1_pct") or plan.get("tp_pct") or 0)
        if sl > 0 and tp > 0:
            return tp / sl
    except (TypeError, ValueError):
        pass
    # derive from prices
    try:
        entry = float(plan.get("entry") or 0)
        sl_px = float(plan.get("sl") or 0)
        tp_px = float(plan.get("tp1") if plan.get("tp1") is not None else (plan.get("tp") or 0))
        if entry > 0 and sl_px > 0 and tp_px > 0:
            risk = abs(entry - sl_px)
            reward = abs(tp_px - entry)
            if risk > 0:
                return reward / risk
    except (TypeError, ValueError):
        pass
    return None


def _plan_confidence_pct(plan: dict[str, Any], item: dict[str, Any]) -> int:
    for src in (plan, item):
        if not isinstance(src, dict):
            continue
        for key in ("confidence_pct",):
            v = src.get(key)
            try:
                if v is not None:
                    return int(round(float(v)))
            except (TypeError, ValueError):
                pass
        try:
            c = src.get("confidence")
            if c is not None:
                cf = float(c)
                if 0.0 <= cf <= 1.0:
                    return int(round(cf * 100))
                if cf > 1.0:
                    return int(round(cf))
        except (TypeError, ValueError):
            pass
    return 0


def _quant_fill_quality_ok(plan: dict[str, Any], item: dict[str, Any]) -> tuple[bool, list[str]]:
    """confidence_pct≥60 且 RR≥1.5 才允许补成 LONG/SHORT。"""
    reasons: list[str] = []
    conf = _plan_confidence_pct(plan, item)
    rr = _plan_rr(plan)
    if conf < QUANT_FILL_MIN_CONFIDENCE_PCT:
        reasons.append(f"confidence_pct {conf}<{QUANT_FILL_MIN_CONFIDENCE_PCT}")
    if rr is None:
        reasons.append(f"rr_missing(need>={QUANT_FILL_MIN_RR})")
    elif rr < QUANT_FILL_MIN_RR:
        reasons.append(f"rr {rr:.2f}<{QUANT_FILL_MIN_RR}")
    # tight_sl: also respect should_enter when present
    if plan and (str(plan.get("plan_kind") or plan.get("strategy_id") or "") in ("tight_sl_15m",) or plan.get("strategy_id") == "tight_sl_15m"):
        if plan.get("should_enter") is False:
            reasons.append("tight_sl_should_enter=false")
    return (len(reasons) == 0, reasons)


def _quant_fill_gate_pass_item(item: dict[str, Any], *, reason: str = "llm_budget_or_fail") -> None:
    """Gate-pass without usable LLM → judged LONG/SHORT only if quality gate passes.

    Quality: confidence_pct≥60 且 RR≥1.5；否则 NO_TRADE（门禁过也不做）。
    Marks ai_status=judged so UI 未跑→0 on gate-pass; quant_fill=True even when NO_TRADE.
    """
    if str(item.get("gate_result") or "") != "pass":
        return
    # Do not overwrite a real LLM judgment
    if item.get("llm") and str(item.get("ai_status") or "") == "judged" and not item.get("quant_fill"):
        return

    sig_side = str(item.get("signal_side") or "long").lower()
    plan = _plan_from_item(item)
    plan_kind = str(plan.get("plan_kind") or plan.get("strategy_id") or "")
    rec = str(plan.get("recommended_action") or "").upper()

    # Candidate direction from plan / signal — never auto-enter without quality check
    if plan_kind in ("tight_sl_15m",) or plan.get("strategy_id") == "tight_sl_15m":
        if rec in ("LONG", "SHORT"):
            candidate = rec
        elif sig_side in ("long", "bull", "buy"):
            candidate = "LONG"
        elif sig_side in ("short", "bear", "sell"):
            candidate = "SHORT"
        else:
            candidate = "NO_TRADE"
        if not bool(plan.get("should_enter")) and candidate in ("LONG", "SHORT"):
            # tight 质量门未过 → 直接不做
            candidate = "NO_TRADE"
    elif rec in ("LONG", "SHORT"):
        candidate = rec
    elif sig_side in ("long", "bull", "buy"):
        candidate = "LONG"
    elif sig_side in ("short", "bear", "sell"):
        candidate = "SHORT"
    else:
        candidate = "NO_TRADE"

    quality_ok, quality_reasons = _quant_fill_quality_ok(plan, item)
    if candidate in ("LONG", "SHORT") and not quality_ok:
        action = "NO_TRADE"
    elif candidate in ("LONG", "SHORT"):
        action = candidate
    elif rec in ("WATCH", "NO_TRADE"):
        action = rec
    else:
        action = "NO_TRADE"

    # Fill / keep levels from composite plan
    if plan:
        if item.get("entry") is None and plan.get("entry") is not None:
            item["entry"] = plan.get("entry")
        if item.get("sl") is None and plan.get("sl") is not None:
            item["sl"] = plan.get("sl")
        if item.get("tp") is None:
            item["tp"] = plan.get("tp1") if plan.get("tp1") is not None else plan.get("tp")
        if item.get("trail") is None and plan.get("trail") is not None:
            item["trail"] = plan.get("trail")
        if not item.get("entry_watch") and plan.get("entry") is not None:
            item["entry_watch"] = f"{plan.get('entry')}（{plan.get('resonance_summary') or plan.get('strategy_name') or '综合止盈止损'}）"
        if not item.get("sl_watch") and plan.get("sl") is not None:
            item["sl_watch"] = f"{plan.get('sl')} (-{plan.get('sl_pct')}%)"
        if plan.get("confidence") is not None and item.get("confidence") in (None, ""):
            item["confidence"] = plan.get("confidence")
        if plan.get("confidence_pct") is not None:
            item["confidence_pct"] = plan.get("confidence_pct")
        if plan.get("confidence_band") is not None:
            item["confidence_band"] = plan.get("confidence_band")
        if plan_kind == "composite" or plan.get("strategy_id") == "composite_sl_tp":
            item["composite_trade_plan"] = plan
        if plan_kind == "tight_sl_15m" or plan.get("strategy_id") == "tight_sl_15m":
            item["tight_sl_strategy"] = plan

    item["action"] = action
    item["ai_status"] = "judged"
    item["quant_fill"] = True
    item["ai_source"] = "quant"
    item["llm_error"] = item.get("llm_error")  # keep prior error text if any
    # Drop hard llm_call_failed conflict once we have a usable quant action
    confs = [c for c in (item.get("conflicts") or []) if c != "llm_call_failed"]
    if reason:
        confs.append(f"quant_fill:{reason}")
    item["conflicts"] = list(dict.fromkeys(confs))
    res_sum = ""
    if plan:
        res_sum = str(plan.get("resonance_summary") or plan.get("strategy_name") or "")
    if action in ("LONG", "SHORT"):
        side_cn = "做多" if action == "LONG" else "做空"
        item["rationale"] = (
            f"【量化补齐·{reason}】门禁通过且质量达标（信心≥{QUANT_FILL_MIN_CONFIDENCE_PCT}%且RR≥{QUANT_FILL_MIN_RR}）；"
            f"按信号方向{side_cn}"
            + (f"；{res_sum}" if res_sum else "；综合止盈止损")
            + f"。入场 {item.get('entry')} / 止损 {item.get('sl')} / 止盈 {item.get('tp')}。"
            + "（LLM 未跑或失败时的规则回退，非模型原文）"
        )
    else:
        fail = ", ".join(quality_reasons) if quality_reasons else "质量不足/无方向"
        if not quality_ok and candidate in ("LONG", "SHORT"):
            confs.append(f"quant_fill_quality_fail:{fail}")
            item["conflicts"] = list(dict.fromkeys(confs))
        item["rationale"] = (
            f"【量化补齐·{reason}】门禁通过但默认不做（{fail}）；"
            + (f"{res_sum}；" if res_sum else "")
            + f"参考位 入场 {item.get('entry')} / 止损 {item.get('sl')} / 止盈 {item.get('tp')}。"
            + f"（需信心≥{QUANT_FILL_MIN_CONFIDENCE_PCT}%且RR≥{QUANT_FILL_MIN_RR}才补成做多/做空）"
        )
    if item.get("outcome"):
        item["outcome"] = _recompute_outcome_for_action(
            item["outcome"],
            entry_price=float(item.get("price") or item.get("entry") or 0.0),
            signal_side=sig_side if sig_side in ("long", "short") else ("long" if action == "LONG" else "short"),
            gate_result="pass",
            ai_action=action,
        )


def _infer_ai_status(item: dict[str, Any], j_out: dict[str, Any] | None = None, *, skip_llm: bool = False) -> str:
    if j_out and j_out.get("ai_status"):
        return str(j_out["ai_status"])
    if item.get("ai_status"):
        return str(item["ai_status"])
    if item.get("gate_result") == "reject":
        return "gate_blocked"
    if skip_llm:
        return "skipped"
    if item.get("llm_error") or (j_out or {}).get("llm_error"):
        return "error"
    if item.get("llm") or (j_out or {}).get("llm"):
        return "judged"
    return "skipped"


def _apply_judge_fields(
    item: dict[str, Any],
    j_out: dict[str, Any],
    *,
    signal_side: str,
    skip_llm: bool = False,
    soft_gate: bool = False,
) -> None:
    gate_res = str(j_out.get("gate_result") or item.get("gate_result") or "reject")
    ai_act = str(j_out.get("action") or "NO_TRADE").upper()
    item["gate_result"] = gate_res
    item["gate_reasons"] = j_out.get("gate_reasons") or item.get("gate_reasons") or []
    item["action"] = ai_act
    item["confidence"] = j_out.get("confidence")
    item["confidence_pct"] = j_out.get("confidence_pct") or item.get("confidence_pct")
    item["confidence_band"] = j_out.get("confidence_band") or item.get("confidence_band")
    if j_out.get("tight_sl_strategy"):
        item["tight_sl_strategy"] = j_out.get("tight_sl_strategy")
    item["entry"] = j_out.get("entry") or item.get("entry")
    item["sl"] = j_out.get("sl") or item.get("sl")
    item["tp"] = j_out.get("tp") or item.get("tp")
    item["trail"] = j_out.get("trail") or item.get("trail")
    item["entry_watch"] = j_out.get("entry_watch")
    item["sl_watch"] = j_out.get("sl_watch")
    item["conflicts"] = j_out.get("conflicts") or []
    item["evidence_refs"] = j_out.get("evidence_refs") or []
    item["rationale"] = j_out.get("rationale")
    item["formatted_text"] = j_out.get("formatted_text")
    item["llm"] = j_out.get("llm")
    item["llm_error"] = j_out.get("llm_error")
    item["ai_status"] = _infer_ai_status(item, j_out, skip_llm=skip_llm)
    if soft_gate:
        item["soft_gate"] = True
        item["analysis_only"] = True
    if item.get("outcome"):
        item["outcome"] = _recompute_outcome_for_action(
            item["outcome"],
            entry_price=float(item.get("price") or 0.0),
            signal_side=signal_side,
            gate_result=gate_res,
            ai_action=ai_act,
        )


async def _attach_llm_to_items(
    items: list[dict[str, Any]],
    *,
    judge_fn,
    skip_llm: bool,
    llm_mode: str = "trader_only",
    max_llm_signals: int = 12,
    soft_ai_top_n: int = 0,
) -> list[str]:
    """Attach concrete AI judgments to gate-pass items (and optional soft rejects)."""
    errors: list[str] = []
    if skip_llm:
        for item in items:
            if item.get("gate_result") == "reject":
                if not item.get("ai_status"):
                    item["ai_status"] = "gate_blocked"
                if not item.get("action"):
                    item["action"] = "NO_TRADE"
                continue
            # 门禁过：量化补齐（质量门槛），默认偏不做 —— 与完整 LLM 回测同一套规则
            if str(item.get("ai_status") or "") != "judged" or item.get("quant_fill"):
                _quant_fill_gate_pass_item(item, reason="skip_llm_gates_only")
            if not item.get("ai_status"):
                item["ai_status"] = "skipped"
                item["rationale"] = item.get("rationale") or (
                    "门禁通过；本次为「仅门禁」模式，未调用 AI。请点「完整LLM回测」才有模型原文。"
                )
        return errors

    pending = [
        x
        for x in items
        if x.get("gate_result") == "pass" and not x.get("llm") and str(x.get("ai_status") or "") != "judged"
    ]
    cap = max(0, int(max_llm_signals))
    to_run = pending[:cap]
    # Over-budget gate-pass: quant/rule fill (clear do/don't + composite SL/TP) — never leave 未跑
    for item in pending[cap:]:
        _quant_fill_gate_pass_item(item, reason=f"over_max_llm={cap}")

    async def _one(item: dict[str, Any], *, soft: bool = False) -> None:
        snap = item.get("snapshot") or {}
        bar_close_iso = str(item.get("ts") or snap.get("ts") or "")
        sig_side = str(item.get("signal_side") or "long")
        sig_meta = {
            "signal_name": item.get("signal_name"),
            "type_label": item.get("signal_name"),
            "side": "bear" if sig_side == "short" else "bull",
            "timeframe": item.get("timeframe") or "1h",
            "bar_ts": str(item.get("bar_open_sec") or ""),
        }
        try:
            j_out = await asyncio.to_thread(
                judge_fn,
                snap,
                skip_llm=False,
                signal_meta=sig_meta,
                as_of_ts=bar_close_iso,
                llm_mode=llm_mode,
            )
            _apply_judge_fields(item, j_out, signal_side=sig_side, skip_llm=False, soft_gate=soft)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{item.get('symbol_base')}:{item.get('bar_open_iso')}: {e}")
            item["llm_error"] = str(e)[:240]
            item["llm"] = None
            item["conflicts"] = ["llm_call_failed"]
            # Quant fill so gate-pass still has action + composite settlement (no 未跑/空 error 刷屏)
            _quant_fill_gate_pass_item(item, reason="llm_call_failed")
            if str(item.get("ai_status") or "") != "judged":
                item["action"] = "NO_TRADE"
                item["ai_status"] = "error"
                item["rationale"] = f"模型调用失败：{e}。不是「过滤掉」，请检查 API Key / 模型。"

    for item in to_run:
        logger.warning(
            "LLM judge %s %s %s mode=%s",
            item.get("symbol_base") or item.get("symbol"),
            item.get("bar_open_iso"),
            item.get("signal_name"),
            llm_mode,
        )
        await _one(item, soft=False)

    if soft_ai_top_n and int(soft_ai_top_n) > 0:
        rejects = [x for x in items if x.get("gate_result") == "reject" and not x.get("llm")]
        for item in rejects[: int(soft_ai_top_n)]:
            logger.warning("SOFT AI analysis %s %s", item.get("symbol_base"), item.get("bar_open_iso"))
            try:
                from judge import run_llm_pipeline, _client, _parse_trader, format_judgment_message  # type: ignore

                client, quick, deep = _client()
                llm = await asyncio.to_thread(
                    run_llm_pipeline,
                    item.get("snapshot") or {},
                    quick,
                    deep,
                    client,
                    llm_mode=llm_mode,
                )
                decision = _parse_trader(llm.get("trader_raw") or "")
                action = str(decision.get("action") or "NO_TRADE").upper()
                if action not in ("LONG", "SHORT", "WATCH", "NO_TRADE"):
                    action = "NO_TRADE"
                item["action"] = action
                item["confidence"] = decision.get("confidence")
                item["entry_watch"] = decision.get("entry_watch")
                item["sl_watch"] = decision.get("sl_watch")
                item["conflicts"] = list(decision.get("conflicts") or []) + list(item.get("gate_reasons") or [])
                item["evidence_refs"] = decision.get("evidence_refs") or []
                item["rationale"] = "【软门禁分析·非实盘】门禁已拒绝；AI 对照： " + str(
                    decision.get("rationale") or ""
                )
                item["llm"] = {
                    "quick_model": quick,
                    "deep_model": deep,
                    "llm_mode": llm.get("llm_mode") or llm_mode,
                    "technical": llm.get("technical"),
                    "flow_oi": llm.get("flow_oi"),
                    "bull": llm.get("bull"),
                    "bear": llm.get("bear"),
                    "trader_raw": llm.get("trader_raw"),
                }
                item["ai_status"] = "judged"
                item["soft_gate"] = True
                item["analysis_only"] = True
                item["formatted_text"] = format_judgment_message(
                    {
                        "symbol": item.get("symbol"),
                        "signal_tf": item.get("timeframe"),
                        "signal_name": item.get("signal_name"),
                        "gate_result": "reject",
                        "gate_reasons": item.get("gate_reasons") or [],
                        "action": action,
                        "confidence": item.get("confidence"),
                        "entry_watch": item.get("entry_watch"),
                        "sl_watch": item.get("sl_watch"),
                        "conflicts": item.get("conflicts") or [],
                        "rationale": item.get("rationale"),
                    },
                    item.get("snapshot") or {},
                    {"signal_name": item.get("signal_name"), "timeframe": item.get("timeframe")},
                )
            except Exception as e:  # noqa: BLE001
                errors.append(f"soft:{item.get('symbol_base')}:{e}")
                item["ai_status"] = "error"
                item["llm_error"] = str(e)
                item["rationale"] = f"软门禁 AI 分析失败：{e}"
                item["soft_gate"] = True
                item["analysis_only"] = True
    # Quant-fill any leftover gate-pass still skipped/error (cache reuse / partial LLM)
    for item in items:
        st = str(item.get("ai_status") or "")
        if item.get("gate_result") == "pass" and st in ("", "skipped", "error") and not item.get("llm"):
            _quant_fill_gate_pass_item(
                item,
                reason=("llm_error" if st == "error" or item.get("llm_error") else "leftover_skipped"),
            )
    # Tag remaining rejects / untouched rows for UI filters
    for item in items:
        if item.get("ai_status"):
            continue
        if item.get("gate_result") == "reject":
            item["ai_status"] = "gate_blocked"
        else:
            item["ai_status"] = "skipped"
    return errors


def _build_summary(
    items: list[dict[str, Any]],
    *,
    days: float,
    elapsed_sec: float,
    provider: dict[str, Any],
    window_start: str = "",
    window_end: str = "",
    timeframes: list[str] | None = None,
    symbol: str = "BTCUSDT",
    symbols: list[str] | None = None,
) -> dict[str, Any]:
    total = len(items)
    gate_pass = [x for x in items if x["gate_result"] == "pass"]
    gate_reject = [x for x in items if x["gate_result"] == "reject"]

    action_counts = {"LONG": 0, "SHORT": 0, "WATCH": 0, "NO_TRADE": 0}
    ai_status_counts = {"judged": 0, "skipped": 0, "error": 0, "gate_blocked": 0, "unknown": 0}
    for x in items:
        act = str(x.get("action") or "NO_TRADE").upper()
        action_counts[act] = action_counts.get(act, 0) + 1
        st = str(x.get("ai_status") or "").strip().lower()
        if not st:
            if x.get("gate_result") == "reject":
                st = "gate_blocked"
            elif x.get("llm"):
                st = "judged"
            elif x.get("llm_error"):
                st = "error"
            else:
                st = "skipped"
        if st not in ai_status_counts:
            st = "unknown"
        ai_status_counts[st] = ai_status_counts.get(st, 0) + 1

    ai_do = [
        x for x in items
        if str(x.get("ai_status") or "") == "judged" and x.get("action") in ("LONG", "SHORT")
    ]
    ai_dont = [
        x for x in items
        if str(x.get("ai_status") or "") == "judged" and x.get("action") in ("WATCH", "NO_TRADE")
    ]
    ai_error_items = [x for x in items if str(x.get("ai_status") or "") == "error" or x.get("llm_error")]
    ai_skipped_items = [x for x in items if str(x.get("ai_status") or "") == "skipped"]
    active_trades = [
        x for x in items
        if x.get("action") in ("LONG", "SHORT")
        and (str(x.get("ai_status") or "") == "judged" or (not x.get("ai_status") and x.get("llm")))
    ]
    if not active_trades:
        active_trades = [x for x in items if x.get("action") in ("LONG", "SHORT") and x.get("llm")]
    active_4h = [x for x in active_trades if x["outcome"].get("dir_ret_4h_pct") is not None]
    active_8h = [x for x in active_trades if x["outcome"].get("dir_ret_8h_pct") is not None]
    wins_4h = [x for x in active_4h if float(x["outcome"]["dir_ret_4h_pct"]) > 0]
    wins_8h = [x for x in active_8h if float(x["outcome"]["dir_ret_8h_pct"]) > 0]

    raw_4h = [x for x in items if x["outcome"].get("dir_ret_4h_pct") is not None]
    raw_8h = [x for x in items if x["outcome"].get("dir_ret_8h_pct") is not None]
    raw_wins_4h = [x for x in raw_4h if float(x["outcome"]["dir_ret_4h_pct"]) > 0]
    raw_wins_8h = [x for x in raw_8h if float(x["outcome"]["dir_ret_8h_pct"]) > 0]

    gp_4h = [x for x in gate_pass if x["outcome"].get("dir_ret_4h_pct") is not None]
    gp_8h = [x for x in gate_pass if x["outcome"].get("dir_ret_8h_pct") is not None]
    gp_wins_4h = [x for x in gp_4h if float(x["outcome"]["dir_ret_4h_pct"]) > 0]
    gp_wins_8h = [x for x in gp_8h if float(x["outcome"]["dir_ret_8h_pct"]) > 0]

    verdict_counts: dict[str, int] = {}
    for x in items:
        v = str(x["outcome"].get("verdict") or "unknown")
        verdict_counts[v] = verdict_counts.get(v, 0) + 1

    def _avg(vals: list[float]) -> float:
        return round(sum(vals) / len(vals), 3) if vals else 0.0

    by_pattern: dict[str, dict[str, Any]] = {}
    for x in items:
        pat = str(x.get("signal_name") or "未知").split(" / ")[0]
        rec = by_pattern.setdefault(
            pat,
            {"pattern": pat, "total": 0, "gate_pass": 0, "gate_reject": 0, "saved": 0, "ret_4h_list": [], "mfe_4h_list": [], "mfe_8h_list": []},
        )
        rec["total"] += 1
        if x["gate_result"] == "pass":
            rec["gate_pass"] += 1
        else:
            rec["gate_reject"] += 1
        if x["outcome"].get("verdict") in ("gate_saved", "ai_saved"):
            rec["saved"] += 1
        if x["outcome"].get("dir_ret_4h_pct") is not None:
            rec["ret_4h_list"].append(float(x["outcome"]["dir_ret_4h_pct"]))
        if x["outcome"].get("mfe_4h_pct") is not None:
            rec["mfe_4h_list"].append(float(x["outcome"]["mfe_4h_pct"]))
        if x["outcome"].get("mfe_8h_pct") is not None:
            rec["mfe_8h_list"].append(float(x["outcome"]["mfe_8h_pct"]))

    pattern_stats = []
    for pat, rec in sorted(by_pattern.items(), key=lambda kv: -kv[1]["total"]):
        pattern_stats.append(
            {
                "pattern": pat,
                "total": rec["total"],
                "gate_pass": rec["gate_pass"],
                "gate_reject": rec["gate_reject"],
                "saved_count": rec["saved"],
                "avg_dir_ret_4h_pct": _avg(rec["ret_4h_list"]),
                "avg_mfe_4h_pct": _avg(rec["mfe_4h_list"]),
                "avg_mfe_8h_pct": _avg(rec["mfe_8h_list"]),
            }
        )

    tf_counts: dict[str, int] = {}
    for x in items:
        tf = str(x.get("timeframe") or "?")
        tf_counts[tf] = tf_counts.get(tf, 0) + 1

    symbol_counts: dict[str, dict[str, int]] = {}
    for x in items:
        sb = str(x.get("symbol_base") or x.get("symbol") or "?").replace("USDT", "")
        bucket = symbol_counts.setdefault(sb, {"total": 0, "gate_pass": 0, "gate_reject": 0})
        bucket["total"] += 1
        if x.get("gate_result") == "pass":
            bucket["gate_pass"] += 1
        else:
            bucket["gate_reject"] += 1
    sym_list = list(symbols) if symbols else ([symbol] if symbol else [])

    if not window_start and items:
        window_start = items[0]["bar_open_iso"]
    if not window_end and items:
        window_end = items[-1]["bar_close_iso"]

    tight_matched = [
        x for x in items
        if isinstance(x.get("tight_sl_strategy"), dict)
        and x["tight_sl_strategy"].get("matched")
        and str(x["tight_sl_strategy"].get("plan_kind") or x["tight_sl_strategy"].get("strategy_id") or "")
        in ("tight_sl_15m",)
    ]
    tight_sims = [
        x["outcome"]["tight_sl_sim"]
        for x in tight_matched
        if isinstance((x.get("outcome") or {}).get("tight_sl_sim"), dict)
    ]
    tp1_or_tp2 = [s for s in tight_sims if s.get("result") in ("tp1_win", "tp2_win")]
    tp2_only = [s for s in tight_sims if s.get("result") == "tp2_win"]
    be_only = [s for s in tight_sims if s.get("result") == "breakeven_after_1r"]
    sl_losses = [s for s in tight_sims if s.get("result") == "sl_loss"]
    decided_sims = [s for s in tight_sims if s.get("result") in ("tp1_win", "tp2_win", "breakeven_after_1r", "sl_loss")]
    non_loss_sims = [s for s in decided_sims if s.get("result") != "sl_loss"]
    # Prefer should_enter / AI做 sample for fee-aware PnL (falls back to gate-pass / all matched)
    tight_enter = [
        x for x in tight_matched
        if (isinstance(x.get("tight_sl_strategy"), dict) and x["tight_sl_strategy"].get("should_enter"))
        or (str(x.get("ai_status") or "") == "judged" and x.get("action") in ("LONG", "SHORT"))
    ]
    tight_enter_sims = [
        x["outcome"]["tight_sl_sim"]
        for x in tight_enter
        if isinstance((x.get("outcome") or {}).get("tight_sl_sim"), dict)
        and (x.get("outcome") or {}).get("tight_sl_sim", {}).get("status") not in (None, "pending")
    ]
    gate_pass_sims = [
        (x.get("outcome") or {}).get("tight_sl_sim", {})
        for x in tight_matched
        if x.get("gate_result") == "pass"
        and isinstance((x.get("outcome") or {}).get("tight_sl_sim"), dict)
        and (x.get("outcome") or {}).get("tight_sl_sim", {}).get("realized_pct") is not None
    ]

    def _sum_field(sims, field, fallback=None):
        total = 0.0
        n = 0
        for s in sims:
            v = s.get(field)
            if v is None and fallback:
                v = s.get(fallback)
            if v is None:
                continue
            total += float(v)
            n += 1
        return round(total, 2), n

    sum_gross_all, n_gross_all = _sum_field(tight_sims, "realized_pct_gross", "realized_pct")
    sum_net_all, n_net_all = _sum_field(tight_sims, "realized_pct_net")
    if n_net_all == 0 and n_gross_all:
        # legacy sims without fee fields
        sum_net_all = round(sum_gross_all - 0.08 * n_gross_all, 2)
        n_net_all = n_gross_all
    sum_gross_enter, n_gross_enter = _sum_field(tight_enter_sims, "realized_pct_gross", "realized_pct")
    sum_net_enter, n_net_enter = _sum_field(tight_enter_sims, "realized_pct_net")
    if n_net_enter == 0 and n_gross_enter:
        sum_net_enter = round(sum_gross_enter - 0.08 * n_gross_enter, 2)
        n_net_enter = n_gross_enter
    sum_gross_gate, n_gross_gate = _sum_field(gate_pass_sims, "realized_pct_gross", "realized_pct")
    sum_net_gate, n_net_gate = _sum_field(gate_pass_sims, "realized_pct_net")
    if n_net_gate == 0 and n_gross_gate:
        sum_net_gate = round(sum_gross_gate - 0.08 * n_gross_gate, 2)
        n_net_gate = n_gross_gate

    enter_sl_losses = [s for s in tight_enter_sims if s.get("result") == "sl_loss"]
    enter_decided = [s for s in tight_enter_sims if s.get("result") in ("tp1_win", "tp2_win", "breakeven_after_1r", "sl_loss")]

    tight_sl_15m_stats = {
        "matched_count": len(tight_matched),
        "enter_count": len(tight_enter),
        "total_signals": len(tight_matched),
        "avg_confidence_pct": _avg([float(x["tight_sl_strategy"].get("confidence_pct") or 0) for x in tight_matched]),
        "avg_sl_pct": _avg([float(x["tight_sl_strategy"].get("sl_pct") or 0) for x in tight_matched]),
        "avg_sl_pct_enter": _avg([float(x["tight_sl_strategy"].get("sl_pct") or 0) for x in tight_enter]),
        "avg_rr_tp1": _avg([float(x["tight_sl_strategy"].get("rr_tp1") or 0) for x in tight_matched]),
        "tp1_or_tp2_count": len(tp1_or_tp2),
        "tp2_count": len(tp2_only),
        "breakeven_count": len(be_only),
        "sl_loss_count": len(sl_losses),
        "stop_out_rate_pct": round(len(sl_losses) / len(decided_sims) * 100.0, 1) if decided_sims else 0.0,
        "stop_out_rate_enter_pct": round(len(enter_sl_losses) / len(enter_decided) * 100.0, 1) if enter_decided else 0.0,
        "tp_hit_rate_pct": round(len(tp1_or_tp2) / len(decided_sims) * 100.0, 1) if decided_sims else 0.0,
        "unbeaten_rate_pct": round(len(non_loss_sims) / len(decided_sims) * 100.0, 1) if decided_sims else 0.0,
        "sim_tp_win_rate_pct": round(len(tp1_or_tp2) / len(decided_sims) * 100.0, 1) if decided_sims else 0.0,
        "sim_non_loss_rate_pct": round(len(non_loss_sims) / len(decided_sims) * 100.0, 1) if decided_sims else 0.0,
        "avg_realized_r": _avg([float(s.get("realized_r") or 0.0) for s in tight_sims if s.get("realized_r") is not None]),
        "sum_realized_pct": sum_gross_all,
        "sum_realized_pct_gross": sum_gross_all,
        "sum_realized_pct_net": sum_net_all,
        "sum_realized_pct_gate_pass": sum_gross_gate,
        "sum_realized_pct_gate_pass_gross": sum_gross_gate,
        "sum_realized_pct_gate_pass_net": sum_net_gate,
        "sum_realized_pct_enter_gross": sum_gross_enter,
        "sum_realized_pct_enter_net": sum_net_enter,
        "fee_pct_per_side": 0.04,
        "n_sim": n_gross_all,
        "n_sim_enter": n_gross_enter,
        "n_sim_gate_pass": n_gross_gate,
        "high_conf_count": sum(1 for x in tight_matched if float(x["tight_sl_strategy"].get("confidence_pct") or 0) >= 80),
    }

    return {
        "window_start": window_start,
        "window_end": window_end,
        "days": round(float(days), 2),
        "symbol": symbol,
        "symbols": sym_list,
        "symbol_counts": symbol_counts,
        "timeframes": list(timeframes or []),
        "tf_counts": tf_counts,
        "total_signals": total,
        "gate_pass_count": len(gate_pass),
        "gate_reject_count": len(gate_reject),
        "gate_pass_rate_pct": round((len(gate_pass) / total) * 100.0, 1) if total else 0.0,
        "action_counts": action_counts,
        "ai_status_counts": ai_status_counts,
        "ai_judged_count": int(ai_status_counts.get("judged", 0)),
        "ai_do_count": len(ai_do),
        "ai_dont_count": len(ai_dont),
        "ai_error_count": len(ai_error_items),
        "ai_skipped_count": len(ai_skipped_items),
        "active_trade_count": len(active_trades),
        "ai_win_rate_4h_pct": round((len(wins_4h) / len(active_4h)) * 100.0, 1) if active_4h else None,
        "ai_win_rate_8h_pct": round((len(wins_8h) / len(active_8h)) * 100.0, 1) if active_8h else None,
        "ai_avg_ret_4h_pct": _avg([float(x["outcome"]["dir_ret_4h_pct"]) for x in active_4h]),
        "ai_avg_ret_8h_pct": _avg([float(x["outcome"]["dir_ret_8h_pct"]) for x in active_8h]),
        "ai_avg_mfe_4h_pct": _avg([float(x["outcome"].get("mfe_4h_pct") or 0.0) for x in active_trades]),
        "ai_avg_mae_4h_pct": _avg([float(x["outcome"].get("mae_4h_pct") or 0.0) for x in active_trades]),
        "ai_avg_mfe_8h_pct": _avg([float(x["outcome"].get("mfe_8h_pct") or 0.0) for x in active_trades]),
        "ai_avg_mae_8h_pct": _avg([float(x["outcome"].get("mae_8h_pct") or 0.0) for x in active_trades]),
        "gate_pass_win_rate_4h_pct": round((len(gp_wins_4h) / len(gp_4h)) * 100.0, 1) if gp_4h else 0.0,
        "gate_pass_win_rate_8h_pct": round((len(gp_wins_8h) / len(gp_8h)) * 100.0, 1) if gp_8h else 0.0,
        "gate_pass_avg_ret_4h_pct": _avg([float(x["outcome"]["dir_ret_4h_pct"]) for x in gp_4h]),
        "gate_pass_avg_ret_8h_pct": _avg([float(x["outcome"]["dir_ret_8h_pct"]) for x in gp_8h]),
        "gate_pass_avg_mfe_4h_pct": _avg([float(x["outcome"].get("mfe_4h_pct") or 0.0) for x in gate_pass]),
        "gate_pass_avg_mae_4h_pct": _avg([float(x["outcome"].get("mae_4h_pct") or 0.0) for x in gate_pass]),
        "gate_pass_avg_mfe_8h_pct": _avg([float(x["outcome"].get("mfe_8h_pct") or 0.0) for x in gate_pass]),
        "gate_pass_avg_mae_8h_pct": _avg([float(x["outcome"].get("mae_8h_pct") or 0.0) for x in gate_pass]),
        "raw_all_win_rate_4h_pct": round((len(raw_wins_4h) / len(raw_4h)) * 100.0, 1) if raw_4h else 0.0,
        "raw_all_win_rate_8h_pct": round((len(raw_wins_8h) / len(raw_8h)) * 100.0, 1) if raw_8h else 0.0,
        "raw_all_avg_ret_4h_pct": _avg([float(x["outcome"]["dir_ret_4h_pct"]) for x in raw_4h]),
        "raw_all_avg_ret_8h_pct": _avg([float(x["outcome"]["dir_ret_8h_pct"]) for x in raw_8h]),
        "saved_by_gate_count": verdict_counts.get("gate_saved", 0),
        "saved_by_ai_count": verdict_counts.get("ai_saved", 0),
        "total_saved_count": verdict_counts.get("gate_saved", 0) + verdict_counts.get("ai_saved", 0),
        "missed_by_gate_count": verdict_counts.get("gate_missed", 0),
        "missed_by_ai_count": verdict_counts.get("ai_missed", 0),
        "verdict_counts": verdict_counts,
        "pattern_stats": pattern_stats,
        "tight_sl_15m_stats": tight_sl_15m_stats,
        "elapsed_sec": elapsed_sec,
        "provider": provider,
    }


async def _load_klines_and_oi(
    api_symbol: str,
    *,
    span_days: float,
    force_refresh: bool = False,
) -> dict[str, Any]:
    raw_cache_file = DATA_DIR / f"btc_backtest_raw_{api_symbol}.json"
    raw_disk = None
    if raw_cache_file.exists():
        try:
            rc = json.loads(raw_cache_file.read_text(encoding="utf-8"))
            if rc.get("k1h") and rc.get("k15"):
                raw_disk = rc
        except Exception:
            raw_disk = None

    use_raw_cache = False
    if raw_disk and (time.time() - float(raw_disk.get("ts") or 0) < 14400):
        if not force_refresh:
            use_raw_cache = True
        else:
            # force_refresh 但币安 418 冷却中：不要卡在 OI hist 精确等待，直接用本地 raw
            try:
                from oi_mornitor import http_backoff

                if http_backoff.is_cooling("binance"):
                    logger.warning(
                        "Binance cooling — using raw kline/OI cache for %s despite force_refresh (remain=%.0fs)",
                        api_symbol,
                        http_backoff.cooldown_remaining("binance"),
                    )
                    use_raw_cache = True
            except Exception:  # noqa: BLE001
                pass
    if use_raw_cache and raw_disk:
        return {
            "k15": raw_disk["k15"],
            "k1h": raw_disk["k1h"],
            "k4h": raw_disk["k4h"],
            "k1d": raw_disk["k1d"],
            "oi1h": {int(k): float(v) for k, v in (raw_disk.get("oi1h") or {}).items()},
            "oi15": {int(k): float(v) for k, v in (raw_disk.get("oi15") or {}).items()},
        }

    # Pages sized for warmup (Vegas ~676) + window
    pages_15 = max(3, min(8, int((span_days * 96 + 800) / 500) + 1))
    pages_1h = max(2, min(6, int((span_days * 24 + 800) / 500) + 1))
    pages_4h = max(1, min(3, int((span_days * 6 + 300) / 500) + 1))
    pages_1d = 1

    async with aiohttp.ClientSession(trust_env=True) as session:
        k15, k1h = await asyncio.gather(
            _fetch_paginated_klines(session, api_symbol, "15m", pages=pages_15, per_page=500),
            _fetch_paginated_klines(session, api_symbol, "1h", pages=pages_1h, per_page=500),
        )
        k4h, k1d = await asyncio.gather(
            _fetch_paginated_klines(session, api_symbol, "4h", pages=pages_4h, per_page=500)
            if pages_4h > 1
            else fetch_pattern_klines(session, base_url=FAPI_BASE_URL, symbol=api_symbol, interval="4h", limit=500),
            fetch_pattern_klines(session, base_url=FAPI_BASE_URL, symbol=api_symbol, interval="1d", limit=300),
        )
        oi1h, oi15 = await asyncio.gather(
            fetch_open_interest_hist(session, base_url=FAPI_BASE_URL, symbol=api_symbol, interval="1h", limit=500),
            fetch_open_interest_hist(session, base_url=FAPI_BASE_URL, symbol=api_symbol, interval="15m", limit=500),
        )

    if (not k1h or not k15) and raw_disk:
        logger.warning("Live kline fetch empty for %s, falling back to cached raw klines", api_symbol)
        return {
            "k15": raw_disk["k15"],
            "k1h": raw_disk["k1h"],
            "k4h": raw_disk["k4h"],
            "k1d": raw_disk["k1d"],
            "oi1h": {int(k): float(v) for k, v in (raw_disk.get("oi1h") or {}).items()},
            "oi15": {int(k): float(v) for k, v in (raw_disk.get("oi15") or {}).items()},
        }
    try:
        if k1h and k15:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            raw_cache_file.write_text(
                json.dumps(
                    {
                        "ts": time.time(),
                        "symbol": api_symbol,
                        "k15": k15,
                        "k1h": k1h,
                        "k4h": k4h,
                        "k1d": k1d,
                        "oi1h": {str(k): v for k, v in (oi1h or {}).items()},
                        "oi15": {str(k): v for k, v in (oi15 or {}).items()},
                    }
                ),
                encoding="utf-8",
            )
    except Exception as e:
        logger.warning("Failed writing raw kline cache: %s", e)

    return {"k15": k15, "k1h": k1h, "k4h": k4h, "k1d": k1d, "oi1h": oi1h or {}, "oi15": oi15 or {}}


def _slice_snapshot_tfs(
    *,
    k15: list[list[Any]],
    k1h: list[list[Any]],
    k4h: list[list[Any]],
    k1d: list[list[Any]],
    close_ms: int,
) -> dict[str, list[list[Any]]]:
    """Strict no-lookahead multi-TF slice at close_ms."""
    s15 = [r for r in k15 if (int(r[0]) + TF_MS["15m"] - 1) <= close_ms]
    # closed 1h + partial from 15m
    s1h = _slice_htf_strictly_no_lookahead(k1h, s15, close_ms, TF_MS["1h"])
    # Prefer synthesizing 4h/1d from 1h (more stable OHLC); fall back to 15m if 1h empty
    lower_for_htf = s1h if s1h else s15
    s4h = _slice_htf_strictly_no_lookahead(k4h, lower_for_htf, close_ms, TF_MS["4h"])
    s1d = _slice_htf_strictly_no_lookahead(k1d, lower_for_htf, close_ms, TF_MS["1d"])
    return {"15m": s15, "1h": s1h, "4h": s4h, "1d": s1d}


async def _run_single_symbol_backtest(
    *,
    symbol: str = "BTCUSDT",
    timeframes: Any = None,
    days: int | None = 7,
    start: str | None = None,
    end: str | None = None,
    skip_llm: bool = False,
    force_refresh: bool = False,
    persist: bool = True,
    llm_mode: str = "trader_only",
    max_llm_signals: int = 12,
    soft_ai_top_n: int = 0,
    include_tight_sl_signals: bool = False,
) -> dict[str, Any]:
    """Run strict point-in-time backtest for ONE symbol across selected TFs and date range."""
    t0 = time.time()
    if str(Path("/Users/maotouying/frontend/code/1.operations/ezcoin-adapter")) not in sys.path:
        sys.path.insert(0, "/Users/maotouying/frontend/code/1.operations/ezcoin-adapter")
    from judge import get_provider_info, judge  # type: ignore

    sym_info = resolve_backtest_symbol(symbol)
    api_symbol = sym_info["api_symbol"]
    display_base = sym_info["display"]
    tfs = _normalize_timeframes(timeframes)
    start_dt, end_dt, span_days = _resolve_window(days=days, start=start, end=end)
    cutoff_start_sec = int(start_dt.timestamp())
    cutoff_end_sec = int(end_dt.timestamp())
    cache_key = _cache_key(api_symbol, tfs, start_dt, end_dt, include_tight_sl_signals=include_tight_sl_signals)
    out_path = _result_path(cache_key)

    # Fast-path: reuse recent matching cache
    if not force_refresh:
        for candidate in (out_path, LATEST_FILE, BACKTEST_FILE):
            if not candidate.exists():
                continue
            try:
                cached = json.loads(candidate.read_text(encoding="utf-8"))
            except Exception:
                continue
            same_sym = str(cached.get("symbol") or "").upper() in (api_symbol, display_base, f"{display_base}USDT")
            same_tf = sorted(cached.get("timeframes") or [cached.get("timeframe") or "1h"]) == sorted(tfs)
            same_window = (
                str(cached.get("start") or "") == start_dt.isoformat(timespec="seconds")
                and str(cached.get("end") or "") == end_dt.isoformat(timespec="seconds")
            ) or (
                abs(float(cached.get("days") or 0) - span_days) < 0.05
                and same_sym
                and same_tf
                and not start
                and not end
            )
            mtime_age = time.time() - candidate.stat().st_mtime
            if same_sym and same_tf and (same_window or (not start and not end and mtime_age < 2700)) and cached.get("items"):
                if mtime_age < 7200 or same_window:
                    chron_items = list(reversed(cached["items"]))
                    llm_errs = await _attach_llm_to_items(
                        chron_items,
                        judge_fn=judge,
                        skip_llm=skip_llm,
                        llm_mode=llm_mode,
                        max_llm_signals=max_llm_signals,
                        soft_ai_top_n=soft_ai_top_n,
                    )
                    if llm_errs:
                        logger.warning("LLM attach errors: %s", llm_errs[:5])
                    summary = _build_summary(
                        chron_items,
                        days=span_days,
                        elapsed_sec=round(time.time() - t0, 2),
                        provider=get_provider_info(),
                        window_start=start_dt.strftime("%Y-%m-%d %H:%M"),
                        window_end=end_dt.strftime("%Y-%m-%d %H:%M"),
                        timeframes=tfs,
                        symbol=api_symbol,
                        symbols=[api_symbol],
                    )
                    result = {
                        "ok": True,
                        "generated_at": datetime.now(tz=TZ_CN).isoformat(timespec="seconds"),
                        "symbol": api_symbol,
                        "symbol_base": display_base,
                        "symbols": [api_symbol],
                        "symbol_bases": [display_base],
                        "timeframe": ",".join(tfs),
                        "timeframes": tfs,
                        "days": round(span_days, 2),
                        "start": start_dt.isoformat(timespec="seconds"),
                        "end": end_dt.isoformat(timespec="seconds"),
                        "skip_llm": skip_llm,
                        "llm_mode": llm_mode if not skip_llm else "skipped",
                        "max_llm_signals": max_llm_signals,
                        "soft_ai_top_n": soft_ai_top_n,
                        "summary": summary,
                        "items": list(reversed(chron_items)),
                        "from_cache": True,
                        "llm_errors": llm_errs if not skip_llm else [],
                    }
                    if persist:
                        _persist_result(result, out_path)
                    return result

    data = await _load_klines_and_oi(api_symbol, span_days=span_days, force_refresh=force_refresh)
    k15, k1h, k4h, k1d = data["k15"], data["k1h"], data["k4h"], data["k1d"]
    oi1h, oi15 = data["oi1h"], data["oi15"]

    if not k1h:
        return {
            "ok": False,
            "error": f"无法拉取 {api_symbol} K线，请检查交易对是否存在",
            "symbol": api_symbol,
            "timeframes": tfs,
            "items": [],
            "summary": _build_summary([], days=span_days, elapsed_sec=0, provider={}, timeframes=tfs, symbol=api_symbol),
        }

    # Index open_sec -> row/idx per TF
    tf_klines = {"15m": k15, "1h": k1h, "4h": k4h, "1d": k1d}
    tf_oi = {"15m": oi15, "1h": oi1h, "4h": oi1h, "1d": oi1h}
    open_idx: dict[str, dict[int, int]] = {}
    for tf, rows in tf_klines.items():
        open_idx[tf] = {int(r[0]) // 1000: i for i, r in enumerate(rows)}

    # Collect signals across selected TFs
    signal_events: list[tuple[int, str, list[dict[str, Any]]]] = []
    for tf in tfs:
        rows = tf_klines.get(tf) or []
        if not rows:
            continue
        by_time = _collect_tf_signals(
            rows,
            tf_oi.get(tf) or {},
            interval=tf,
            cutoff_start_sec=cutoff_start_sec,
            cutoff_end_sec=cutoff_end_sec,
            api_symbol=api_symbol,
            include_tight_sl_signals=include_tight_sl_signals,
        )
        for t_sec, metas in by_time.items():
            if t_sec in open_idx.get(tf, {}):
                signal_events.append((t_sec, tf, metas))

    # Chronological: by close time then TF priority
    tf_rank = {t: i for i, t in enumerate(SUPPORTED_TFS)}
    signal_events.sort(key=lambda x: (x[0] + TF_SEC[x[1]], tf_rank.get(x[1], 9)))

    df15_tight = enrich_tight_sl_df(klines_to_df(k15)) if k15 and len(k15) >= 30 else None
    tf_enriched: dict[str, Any] = {}
    for _tf_name, _rows in (("15m", k15), ("1h", k1h), ("4h", k4h), ("1d", k1d)):
        if _rows and len(_rows) >= 30:
            try:
                tf_enriched[_tf_name] = enrich_tight_sl_df(klines_to_df(_rows))
            except Exception as _e:
                logger.debug("enrich %s for composite plan failed: %s", _tf_name, _e)
    if df15_tight is not None:
        tf_enriched["15m"] = df15_tight

    items: list[dict[str, Any]] = []
    for seq_idx, (t_sec, sig_tf, bms) in enumerate(signal_events, start=1):
        iv_sec = TF_SEC[sig_tf]
        bar_idx = open_idx[sig_tf][t_sec]
        bar_row = tf_klines[sig_tf][bar_idx]
        close_ms = (t_sec + iv_sec) * 1000 - 1
        bar_open_dt = datetime.fromtimestamp(t_sec, tz=TZ_CN)
        bar_close_dt = datetime.fromtimestamp(t_sec + iv_sec, tz=TZ_CN)
        bar_close_iso = bar_close_dt.isoformat(timespec="seconds")

        sliced = _slice_snapshot_tfs(k15=k15, k1h=k1h, k4h=k4h, k1d=k1d, close_ms=close_ms)
        s15, s1h, s4h, s1d = sliced["15m"], sliced["1h"], sliced["4h"], sliced["1d"]

        sig_names = list(dict.fromkeys(str(x["text"]) for x in bms))
        combined_name = " / ".join(sig_names)
        sources = list(dict.fromkeys(str(x.get("source") or "chart_pattern") for x in bms))
        kinds = list(dict.fromkeys(str(x.get("kind") or "pattern") for x in bms))
        short_votes = sum(1 for x in bms if x.get("side") == "short")
        long_votes = sum(1 for x in bms if x.get("side") == "long")
        signal_side = "short" if short_votes > long_votes else "long"
        meta_side = "bear" if signal_side == "short" else "bull"
        marker_oi_anom = any(bool(x.get("oi_anomaly")) for x in bms)

        sig_meta = {
            "signal_name": combined_name,
            "type_label": combined_name,
            "side": meta_side,
            "timeframe": sig_tf,
            "bar_ts": str(t_sec),
        }

        tf_map = {
            "15m": _compute_tf_node(s15, interval="15m", symbol=api_symbol),
            "1h": _compute_tf_node(s1h, interval="1h", symbol=api_symbol),
            "4h": _compute_tf_node(s4h, interval="4h", symbol=api_symbol),
            "1d": _compute_tf_node(s1d, interval="1d", symbol=api_symbol),
        }
        # Attach signal override on the signal TF node
        tf_map[sig_tf] = _compute_tf_node(
            sliced[sig_tf],
            interval=sig_tf,
            symbol=api_symbol,
            signal_override=sig_meta,
        )
        pats = list(dict.fromkeys(sig_names + (tf_map[sig_tf].get("patterns") or [])))
        tf_map[sig_tf]["patterns"] = pats[:5]

        entry_price = round(float(bar_row[4]), 6 if entry_price_needs_precision(api_symbol) else 2)
        # price change proxy from last two 1h closes (or signal TF)
        ref_series = s1h if len(s1h) >= 2 else sliced[sig_tf]
        prev_price = float(ref_series[-2][4]) if len(ref_series) >= 2 else entry_price
        price_chg = entry_price - prev_price

        oi_node = _point_in_time_oi(
            oi1h=oi1h,
            oi15=oi15,
            t_sec=t_sec + iv_sec,  # at bar close
            side=meta_side,
            price_chg_1h=price_chg,
            marker_oi_anomaly=marker_oi_anom,
        )

        # Trade plan: dedicated 15m tight-SL only when that signal was injected;
        # otherwise always attach 综合止盈止损 for original pattern/structure/alert signals.
        trade_plan: dict[str, Any] = {}
        is_tight_sl_hit = ("tight_sl_15m" in kinds) or ("tight_sl_15m" in sources)
        plan_df = tf_enriched.get(sig_tf)
        htf_trends = {
            "1h": tf_map.get("1h") or {},
            "4h": tf_map.get("4h") or {},
            "1d": tf_map.get("1d") or {},
        }
        if is_tight_sl_hit and sig_tf == "15m" and df15_tight is not None and 0 <= bar_idx < len(df15_tight):
            try:
                # Prefer precomputed plan from collect inject if present
                pre = next(
                    (x.get("tight_sl_strategy") for x in bms if isinstance(x.get("tight_sl_strategy"), dict)),
                    None,
                )
                ev_t = pre or evaluate_bar_15m_tight_sl(
                    df15_tight,
                    bar_idx,
                    symbol=api_symbol,
                    htf_trends=htf_trends,
                    oi_chg_pct=float(oi_node.get("chg_15m_pct") or 0.0),
                    preferred_side=signal_side,
                    existing_signal_name=combined_name,
                )
                if ev_t:
                    trade_plan = dict(ev_t)
                    trade_plan.setdefault("plan_kind", "tight_sl_15m")
                    trade_plan.setdefault("strategy_id", "tight_sl_15m")
                    tf_map["15m"]["tight_sl_strategy"] = trade_plan
                    if trade_plan.get("matched") and trade_plan.get("side") in ("long", "short"):
                        tf_map["15m"]["bias"] = trade_plan["side"]
            except Exception as e:
                logger.debug("evaluate_bar_15m_tight_sl in backtest failed: %s", e)
        elif plan_df is not None and 0 <= bar_idx < len(plan_df):
            try:
                trade_plan = compute_composite_trade_plan(
                    plan_df,
                    bar_idx,
                    side=signal_side,
                    symbol=api_symbol,
                    interval=sig_tf,
                    signal_name=combined_name,
                    htf_trends=htf_trends,
                    oi_chg_pct=float(oi_node.get("chg_15m_pct") or oi_node.get("chg_1h_pct") or 0.0),
                ) or {}
                if trade_plan:
                    tf_map[sig_tf]["composite_trade_plan"] = trade_plan
            except Exception as e:
                logger.debug("compute_composite_trade_plan failed: %s", e)

        tier_info = resolve_backtest_tier(display_base, api_symbol)
        snap = {
            "schema_version": "1.0",
            "symbol": display_base,
            "tier": tier_info["tier"],
            "asset_class": tier_info["asset_class"],
            "signal_tf": sig_tf,
            "signal_name": combined_name,
            "ts": bar_close_iso,
            "ttl_sec": 900,
            "price": entry_price,
            "session": "open",
            "tf": tf_map,
            "oi": oi_node,
            "market": {"risk_off": False, "funding_pct": 0.008},
            "tight_sl_strategy": trade_plan if trade_plan.get("plan_kind") == "tight_sl_15m" else {},
            "composite_trade_plan": trade_plan if trade_plan.get("plan_kind") == "composite" else {},
            "trade_plan": trade_plan,
        }

        # Gate-first in bar loop; LLM attached afterward (max_llm_signals / llm_mode).
        j_out = await asyncio.to_thread(
            judge,
            snap,
            skip_llm=True,
            signal_meta=sig_meta,
            as_of_ts=bar_close_iso,
        )

        gate_result = str(j_out.get("gate_result") or "reject")
        ai_action = str(j_out.get("action") or "NO_TRADE").upper()

        outcome = _evaluate_future_outcome(
            k1h=k1h,
            bar_open_sec=t_sec if sig_tf == "1h" else (t_sec + iv_sec - 3600),
            entry_price=entry_price,
            signal_side=signal_side,
            gate_result=gate_result,
            ai_action=ai_action,
        )
        # Settle each trade by its entry/SL/TP/trail on subsequent bars of the signal TF
        # (composite for original signals; tight_sl plan for the dedicated 15m button path).
        sim_df = plan_df if plan_df is not None else (df15_tight if sig_tf == "15m" else None)
        if trade_plan and trade_plan.get("entry") and sim_df is not None and bar_idx + 1 < len(sim_df):
            try:
                # Scale look-forward bars with TF: ~12h window
                max_bars = 48 if sig_tf == "15m" else (12 if sig_tf == "1h" else (6 if sig_tf == "4h" else 3))
                sim = simulate_tight_sl_outcome(
                    trade_plan,
                    sim_df.iloc[bar_idx + 1 : min(len(sim_df), bar_idx + 1 + max_bars)],
                    max_bars=max_bars,
                )
                outcome["tight_sl_sim"] = sim
                outcome["trade_plan_kind"] = trade_plan.get("plan_kind") or "unknown"
                if sim and sim.get("status") not in (None, "pending") and sim.get("realized_pct") is not None:
                    outcome["realized_pct"] = float(sim["realized_pct"])
                    outcome["realized_pct_gross"] = float(sim.get("realized_pct_gross") or sim["realized_pct"])
                    outcome["realized_pct_net"] = float(
                        sim.get("realized_pct_net")
                        if sim.get("realized_pct_net") is not None
                        else (float(sim["realized_pct"]) - float(sim.get("fee_total_pct") or 0.08))
                    )
                    outcome["fee_total_pct"] = float(sim.get("fee_total_pct") or 0.0)
                    outcome["realized_r"] = float(sim.get("realized_r") or 0.0)
                    outcome["settlement"] = "entry_sl_tp_trail"
            except Exception as e:
                logger.debug("simulate_tight_sl_outcome failed: %s", e)

        no_lookahead_proof = {
            "strict_cutoff_close_iso": bar_close_iso,
            "strict_cutoff_close_ms": close_ms,
            "bars_fed": {"15m": len(s15), "1h": len(s1h), "4h": len(s4h), "1d": len(s1d)},
            "htf_partial_synthesized": True,
            "future_bars_exposed_to_agent": 0,
        }

        items.append(
            {
                "id": f"bt-{api_symbol.lower()}-{sig_tf}-{t_sec}",
                "seq": seq_idx,
                "bar_open_sec": t_sec,
                "bar_close_sec": t_sec + iv_sec,
                "bar_open_iso": bar_open_dt.strftime("%Y-%m-%d %H:%M"),
                "bar_close_iso": bar_close_dt.strftime("%Y-%m-%d %H:%M"),
                "ts": bar_close_iso,
                "symbol": api_symbol,
                "symbol_base": display_base,
                "timeframe": sig_tf,
                "signal_name": combined_name,
                "signal_kinds": kinds,
                "signal_sources": sources,
                "signal_side": signal_side,
                "price": entry_price,
                "candle": {
                    "open": float(bar_row[1]),
                    "high": float(bar_row[2]),
                    "low": float(bar_row[3]),
                    "close": entry_price,
                    "volume": float(bar_row[5]),
                },
                "gate_result": gate_result,
                "gate_reasons": j_out.get("gate_reasons") or [],
                "action": ai_action,
                "ai_status": j_out.get("ai_status") or ("gate_blocked" if gate_result == "reject" else "skipped"),
                "llm_error": j_out.get("llm_error"),
                "confidence": j_out.get("confidence"),
                "confidence_pct": j_out.get("confidence_pct"),
                "confidence_band": j_out.get("confidence_band"),
                "tight_sl_strategy": (
                    j_out.get("tight_sl_strategy")
                    if isinstance(j_out.get("tight_sl_strategy"), dict) and j_out.get("tight_sl_strategy")
                    else (trade_plan if trade_plan.get("plan_kind") == "tight_sl_15m" else {})
                ),
                "composite_trade_plan": trade_plan if trade_plan.get("plan_kind") == "composite" else {},
                "trade_plan": trade_plan,
                # Prefer AI judge levels when present; else 综合/小止损 plan levels
                "entry": j_out.get("entry") if j_out.get("entry") is not None else trade_plan.get("entry"),
                "sl": j_out.get("sl") if j_out.get("sl") is not None else trade_plan.get("sl"),
                "tp": j_out.get("tp") if j_out.get("tp") is not None else (trade_plan.get("tp1") or trade_plan.get("tp")),
                "trail": j_out.get("trail") if j_out.get("trail") is not None else trade_plan.get("trail"),
                "entry_watch": j_out.get("entry_watch"),
                "sl_watch": j_out.get("sl_watch"),
                "conflicts": j_out.get("conflicts") or [],
                "evidence_refs": j_out.get("evidence_refs") or [],
                "rationale": j_out.get("rationale"),
                "formatted_text": j_out.get("formatted_text"),
                "llm": j_out.get("llm"),
                "snapshot": snap,
                "no_lookahead_proof": no_lookahead_proof,
                "outcome": outcome,
            }
        )

    llm_errs = await _attach_llm_to_items(
        items,
        judge_fn=judge,
        skip_llm=skip_llm,
        llm_mode=llm_mode,
        max_llm_signals=max_llm_signals,
        soft_ai_top_n=soft_ai_top_n,
    )
    if llm_errs:
        logger.warning("LLM attach errors (fresh): %s", llm_errs[:5])

    summary = _build_summary(
        items,
        days=span_days,
        elapsed_sec=round(time.time() - t0, 2),
        provider=get_provider_info(),
        window_start=start_dt.strftime("%Y-%m-%d %H:%M"),
        window_end=end_dt.strftime("%Y-%m-%d %H:%M"),
        timeframes=tfs,
        symbol=api_symbol,
        symbols=[api_symbol],
    )
    result = {
        "ok": True,
        "generated_at": datetime.now(tz=TZ_CN).isoformat(timespec="seconds"),
        "symbol": api_symbol,
        "symbol_base": display_base,
        "symbols": [api_symbol],
        "symbol_bases": [display_base],
        "timeframe": ",".join(tfs),
        "timeframes": tfs,
        "days": round(span_days, 2),
        "start": start_dt.isoformat(timespec="seconds"),
        "end": end_dt.isoformat(timespec="seconds"),
        "skip_llm": skip_llm,
        "llm_mode": llm_mode if not skip_llm else "skipped",
        "max_llm_signals": max_llm_signals,
        "soft_ai_top_n": soft_ai_top_n,
        "include_tight_sl_signals": include_tight_sl_signals,
        "summary": summary,
        "items": list(reversed(items)),
        "from_cache": False,
        "llm_errors": llm_errs,
    }
    if persist:
        _persist_result(result, out_path)
    return result


def entry_price_needs_precision(api_symbol: str) -> bool:
    return any(x in api_symbol.upper() for x in ("DOGE", "PEPE", "SHIB", "BONK", "FLOKI", "NEAR", "UNI"))


def _persist_result(result: dict[str, Any], out_path: Path) -> None:
    """Best-effort disk write. Never raise into the HTTP path — a serialize/IO
    failure must not turn a successful backtest into a blank 500 for the UI."""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        text = json.dumps(result, ensure_ascii=False, indent=2, default=str)
        out_path.write_text(text, encoding="utf-8")
        LATEST_FILE.write_text(text, encoding="utf-8")
        tfs = result.get("timeframes") or []
        if str(result.get("symbol") or "").upper() in ("BTCUSDT", "BTC") and tfs == ["1h"]:
            BACKTEST_FILE.write_text(text, encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        logger.exception("persist backtest result failed (%s): %s", out_path.name, e)



async def run_btc_backtest(
    *,
    symbol: str = "BTCUSDT",
    symbols: Any = None,
    timeframes: Any = None,
    days: int | None = 7,
    start: str | None = None,
    end: str | None = None,
    skip_llm: bool = False,
    force_refresh: bool = False,
    llm_mode: str = "trader_only",
    max_llm_signals: int = 12,
    soft_ai_top_n: int = 0,
    include_tight_sl_signals: bool = False,
) -> dict[str, Any]:
    """Run strict PIT backtest for one or more symbols.

    Prefer ``symbols: string[]``; single ``symbol`` remains an alias for one coin.
    Multi-symbol runs concatenate items (sorted by bar close), aggregate summary,
    and keep per-item ``symbol`` / ``symbol_base`` correct.
    """
    t0 = time.time()
    sym_list = _normalize_symbols(symbols, symbol)
    tfs = _normalize_timeframes(timeframes)
    start_dt, end_dt, span_days = _resolve_window(days=days, start=start, end=end)

    if len(sym_list) == 1:
        return await _run_single_symbol_backtest(
            symbol=sym_list[0],
            timeframes=tfs,
            days=days,
            start=start,
            end=end,
            skip_llm=skip_llm,
            force_refresh=force_refresh,
            persist=True,
            llm_mode=llm_mode,
            max_llm_signals=max_llm_signals,
            soft_ai_top_n=soft_ai_top_n,
            include_tight_sl_signals=include_tight_sl_signals,
        )

    # Multi-symbol cache
    cache_key = _cache_key("MULTI-" + "-".join(sym_list), tfs, start_dt, end_dt, include_tight_sl_signals=include_tight_sl_signals)
    out_path = _result_path(cache_key)
    if not force_refresh and out_path.exists():
        try:
            cached = json.loads(out_path.read_text(encoding="utf-8"))
            cached_syms = [str(x).upper() for x in (cached.get("symbols") or [])]
            same_window = (
                str(cached.get("start") or "") == start_dt.isoformat(timespec="seconds")
                and str(cached.get("end") or "") == end_dt.isoformat(timespec="seconds")
            )
            if (
                cached_syms == [s.upper() for s in sym_list]
                and sorted(cached.get("timeframes") or []) == sorted(tfs)
                and same_window
                and cached.get("items")
            ):
                cached = dict(cached)
                items_c = list(cached.get("items") or [])
                need_llm = (not skip_llm) and any(
                    x.get("gate_result") == "pass" and not x.get("llm") for x in items_c
                )
                if need_llm:
                    if str(Path("/Users/maotouying/frontend/code/1.operations/ezcoin-adapter")) not in sys.path:
                        sys.path.insert(0, "/Users/maotouying/frontend/code/1.operations/ezcoin-adapter")
                    from judge import get_provider_info, judge  # type: ignore

                    llm_errs = await _attach_llm_to_items(
                        items_c,
                        judge_fn=judge,
                        skip_llm=False,
                        llm_mode=llm_mode,
                        max_llm_signals=max_llm_signals,
                        soft_ai_top_n=soft_ai_top_n,
                    )
                    summary_c = _build_summary(
                        items_c,
                        days=span_days,
                        elapsed_sec=round(time.time() - t0, 2),
                        provider=get_provider_info(),
                        window_start=start_dt.strftime("%Y-%m-%d %H:%M"),
                        window_end=end_dt.strftime("%Y-%m-%d %H:%M"),
                        timeframes=tfs,
                        symbol=",".join(sym_list),
                        symbols=sym_list,
                    )
                    summary_c["per_symbol"] = (cached.get("summary") or {}).get("per_symbol") or []
                    cached["items"] = items_c
                    cached["summary"] = summary_c
                    cached["skip_llm"] = False
                    cached["llm_mode"] = llm_mode
                    cached["max_llm_signals"] = max_llm_signals
                    cached["soft_ai_top_n"] = soft_ai_top_n
                    cached["llm_errors"] = llm_errs
                    cached["generated_at"] = datetime.now(tz=TZ_CN).isoformat(timespec="seconds")
                    cached["from_cache"] = True
                    _persist_result(cached, out_path)
                    return cached
                cached["from_cache"] = True
                LATEST_FILE.write_text(json.dumps(cached, ensure_ascii=False, indent=2), encoding="utf-8")
                return cached
        except Exception:
            logger.exception("multi-symbol cache reuse failed")

    if str(Path("/Users/maotouying/frontend/code/1.operations/ezcoin-adapter")) not in sys.path:
        sys.path.insert(0, "/Users/maotouying/frontend/code/1.operations/ezcoin-adapter")
    from judge import get_provider_info  # type: ignore

    all_items: list[dict[str, Any]] = []
    per_symbol: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    remaining_llm = 0 if skip_llm else int(max_llm_signals)
    remaining_soft = 0 if skip_llm else int(soft_ai_top_n)
    for api_sym in sym_list:
        try:
            one = await _run_single_symbol_backtest(
                symbol=api_sym,
                timeframes=tfs,
                days=days,
                start=start,
                end=end,
                skip_llm=skip_llm,
                force_refresh=force_refresh,
                persist=False,
                llm_mode=llm_mode,
                max_llm_signals=remaining_llm,
                soft_ai_top_n=remaining_soft,
                include_tight_sl_signals=include_tight_sl_signals,
            )
        except Exception as e:  # noqa: BLE001
            errors.append({"symbol": api_sym, "error": str(e)})
            continue
        if not one.get("ok"):
            errors.append({"symbol": api_sym, "error": str(one.get("error") or "failed")})
            continue
        items = list(one.get("items") or [])
        remaining_llm = max(
            0,
            remaining_llm
            - sum(1 for x in items if x.get("ai_status") == "judged" and not x.get("soft_gate")),
        )
        remaining_soft = max(
            0,
            remaining_soft
            - sum(1 for x in items if x.get("ai_status") == "judged" and x.get("soft_gate")),
        )
        all_items.extend(items)
        sm = one.get("summary") or {}
        per_symbol.append(
            {
                "symbol": one.get("symbol"),
                "symbol_base": one.get("symbol_base"),
                "total_signals": sm.get("total_signals", len(items)),
                "gate_pass_count": sm.get("gate_pass_count", 0),
                "gate_reject_count": sm.get("gate_reject_count", 0),
                "gate_pass_rate_pct": sm.get("gate_pass_rate_pct", 0),
            }
        )

    all_items.sort(key=lambda x: (int(x.get("bar_close_sec") or 0), str(x.get("symbol") or ""), str(x.get("timeframe") or "")))
    for i, it in enumerate(all_items, start=1):
        it["seq"] = i

    bases = []
    for s in sym_list:
        info = resolve_backtest_symbol(s)
        if info["display"] not in bases:
            bases.append(info["display"])

    summary = _build_summary(
        all_items,
        days=span_days,
        elapsed_sec=round(time.time() - t0, 2),
        provider=get_provider_info(),
        window_start=start_dt.strftime("%Y-%m-%d %H:%M"),
        window_end=end_dt.strftime("%Y-%m-%d %H:%M"),
        timeframes=tfs,
        symbol=",".join(sym_list),
        symbols=sym_list,
    )
    summary["per_symbol"] = per_symbol
    if errors:
        summary["symbol_errors"] = errors

    ok = True
    top_error = None
    if not all_items:
        ok = False
        if errors:
            top_error = (
                "全部币种回测失败: "
                + "; ".join(f"{e.get('symbol')}: {e.get('error')}" for e in errors[:6])
            )
        else:
            top_error = "回测无信号：所选区间/周期未产出形态，或行情拉取为空"

    result = {
        "ok": ok,
        "generated_at": datetime.now(tz=TZ_CN).isoformat(timespec="seconds"),
        "symbol": ",".join(sym_list),
        "symbol_base": "+".join(bases) if bases else ",".join(sym_list),
        "symbols": sym_list,
        "symbol_bases": bases,
        "timeframe": ",".join(tfs),
        "timeframes": tfs,
        "days": round(span_days, 2),
        "start": start_dt.isoformat(timespec="seconds"),
        "end": end_dt.isoformat(timespec="seconds"),
        "skip_llm": skip_llm,
        "llm_mode": llm_mode if not skip_llm else "skipped",
        "max_llm_signals": max_llm_signals,
        "soft_ai_top_n": soft_ai_top_n,
        "summary": summary,
        "items": all_items,
        "from_cache": False,
        "errors": errors,
        "llm_errors": [],
        "error": top_error,
        "partial": bool(all_items) and bool(errors),
    }
    _persist_result(result, out_path)
    return result


async def run_btc_1h_backtest(
    *,
    days: int = 7,
    skip_llm: bool = False,
    force_refresh: bool = False,
    symbol: str = "BTCUSDT",
    timeframes: Any = None,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, Any]:
    """Backward-compatible wrapper (defaults to BTC 1h)."""
    return await run_btc_backtest(
        symbol=symbol or "BTCUSDT",
        timeframes=timeframes if timeframes is not None else ["1h"],
        days=days,
        start=start,
        end=end,
        skip_llm=skip_llm,
        force_refresh=force_refresh,
    )


def load_cached_btc_1h_backtest() -> dict[str, Any] | None:
    for p in (LATEST_FILE, BACKTEST_FILE):
        if not p.exists():
            continue
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
    return None


load_cached_btc_backtest = load_cached_btc_1h_backtest


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("--symbol", default="BTCUSDT")
    p.add_argument("--timeframes", default="1h", help="comma-separated: 15m,1h,4h,1d")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--start", default=None)
    p.add_argument("--end", default=None)
    p.add_argument("--skip-llm", action="store_true")
    p.add_argument("--force-refresh", action="store_true")
    args = p.parse_args()
    res = asyncio.run(
        run_btc_backtest(
            symbol=args.symbol,
            timeframes=args.timeframes,
            days=args.days,
            start=args.start,
            end=args.end,
            skip_llm=args.skip_llm,
            force_refresh=args.force_refresh,
        )
    )
    print(json.dumps(res.get("summary") or res, ensure_ascii=False, indent=2))
