"""Bridge between ezcoin (oi_mornitor) and ezcoin-adapter (127.0.0.1:5179).

Responsibilities:
1. Build structured multi-timeframe (15m, 1h, 4h, 1d) snapshot JSON from oi_mornitor's
   existing indicator/kline/OI/funding pipeline without duplicating indicator math in the LLM.
2. Call ezcoin-adapter HTTP service (`127.0.0.1:5179/judge` & `/signal-btc`).
3. Automatically run judgment and push formatted conclusion when a dedicated BTC
   15m / 1h / 4h / 1d signal fires (with per-(symbol, timeframe, kind, bar_ts) deduplication).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import aiohttp
import pandas as pd

from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.config import (
    AI_JUDGE_TELEGRAM_ACTIONS,
    AI_JUDGE_TELEGRAM_CHAT_ID,
    AI_JUDGE_TELEGRAM_PUSH,
    AI_JUDGE_TG_COOLDOWN_SEC,
    CANDLE_CARD_TELEGRAM_CHAT_ID,
    FAPI_BASE_URL,
    MAIN_CARD_TELEGRAM_CHAT_ID,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    TELEGRAM_PUSH_CHAT_ID,
    TELEGRAM_SEND_URL,
)
from oi_mornitor.derivatives_metrics import (
    classify_oi_price_regime,
    fetch_premium_index,
)
from oi_mornitor.main_card_policy import main_card_equity_symbols
from oi_mornitor.notify_telegram import send_telegram_text
from oi_mornitor.pattern_detector import enrich_indicators
from oi_mornitor.strategy.candle_signals import find_last_closed_candle_card_hits
from oi_mornitor.strategy.structure_signals import find_last_closed_structure_hits
from oi_mornitor.strategy.tight_sl_15m import (
    enrich_tight_sl_df,
    evaluate_bar_15m_tight_sl,
)

logger = logging.getLogger("OI_Radar.ai_judge")

ADAPTER_BASE_URL = os.environ.get("EZCOIN_ADAPTER_URL", "http://127.0.0.1:5179").rstrip("/")
DATA_DIR = Path(__file__).resolve().parent / "data"
BTC_SIGNALS_PATH = DATA_DIR / "ai_judge_btc_signals.json"
BTC_ALLOWED_TFS = ("15m", "1h", "4h", "1d")

_BTC_SIGNAL_FEED: list[dict[str, Any]] = []
_BTC_SEEN_KEYS: set[str] = set()
_LATEST_BY_SYMBOL: dict[str, dict[str, Any]] = {}
_BTC_PUSH_COOLDOWN: dict[str, float] = {}  # cooldown_key -> last_push_epoch
_LLM_FAIL_WARNED_AT: float = 0.0  # rate-limit local LLM-fail warning
_INIT_LOADED = False


def _ensure_loaded() -> None:
    global _INIT_LOADED
    if _INIT_LOADED:
        return
    _INIT_LOADED = True
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if BTC_SIGNALS_PATH.exists():
        try:
            items = json.loads(BTC_SIGNALS_PATH.read_text(encoding="utf-8"))
            if isinstance(items, list):
                for it in items[:100]:
                    if isinstance(it, dict):
                        _BTC_SIGNAL_FEED.append(it)
                        dk = str(it.get("dedupe_key") or "")
                        if dk:
                            _BTC_SEEN_KEYS.add(dk)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Load ai_judge_btc_signals failed: %s", exc)


def _save_btc_signals() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        BTC_SIGNALS_PATH.write_text(
            json.dumps(_BTC_SIGNAL_FEED[:100], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("Save ai_judge_btc_signals failed: %s", exc)


def normalize_pair_and_short(symbol: str) -> tuple[str, str]:
    """Return (api_symbol, short_symbol), e.g. ('BTCUSDT', 'BTC') or ('QQQUSDT', 'QQQ')."""
    s = str(symbol or "BTCUSDT").strip().upper()
    if s.endswith("USDT") and len(s) > 4:
        return s, s[:-4]
    if s in ("BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "SUI", "PEPE"):
        return f"{s}USDT", s
    eqs = {x.upper() for x in main_card_equity_symbols()}
    if f"{s}USDT" in eqs:
        return f"{s}USDT", s
    if not s.endswith("USDT"):
        return f"{s}USDT", s
    return s, s


def classify_tier_and_asset(api_sym: str, short_sym: str) -> tuple[str, str]:
    eqs = {x.upper() for x in main_card_equity_symbols()}
    if api_sym in eqs or short_sym in ("QQQ", "SPY", "NVDA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA"):
        return "T1_EQ", "us_equity"
    if short_sym in ("BTC", "ETH"):
        return "T1", "crypto_perp"
    return "ALT", "crypto_perp"


def _compute_tf_node(
    klines: list[list],
    *,
    interval: str,
    symbol: str,
    signal_override: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not klines or len(klines) < 25:
        return {}
    df = klines_to_df(klines)
    if df.empty:
        return {}
    df = enrich_indicators(df)
    closes = df["close"]
    ema13 = float(closes.ewm(span=13, adjust=False).mean().iloc[-1])
    ema33 = float(closes.ewm(span=33, adjust=False).mean().iloc[-1])
    ema99 = float(closes.ewm(span=99, adjust=False).mean().iloc[-1])
    ema144 = float(closes.ewm(span=144, adjust=False).mean().iloc[-1])

    last = df.iloc[-1]
    prev = df.iloc[-2] if len(df) >= 2 else last
    close_v = float(last["close"])
    prev_close = float(prev["close"]) if float(prev["close"]) > 0 else close_v
    chg_pct = round((close_v - prev_close) / prev_close * 100.0, 3) if prev_close > 0 else 0.0

    v12 = float(last.get("vegas_filter") or ema13)
    v144 = float(last.get("vegas_e1") or ema144)
    v169 = float(last.get("vegas_e2") or ema144)
    v576 = float(last.get("vegas_e3") or v169)
    v676 = float(last.get("vegas_e4") or v576)

    tun_hi = max(v144, v169)
    tun_lo = min(v144, v169)
    if close_v >= v12 and close_v >= tun_hi:
        pos_vs_vegas = "above_tunnel"
    elif close_v >= v12 and close_v < tun_lo:
        pos_vs_vegas = "above_fast_below_tunnel"
    elif close_v < v12 and close_v >= tun_hi:
        pos_vs_vegas = "below_fast_above_tunnel"
    elif close_v < tun_lo:
        pos_vs_vegas = "below_tunnel"
    else:
        pos_vs_vegas = "in_tunnel"

    # Volume spike: check both current and last closed bar vs SMA20
    vol_sma = float(last.get("vol_sma20") or 0.0)
    vol_cur = float(last.get("volume") or 0.0)
    vol_prev = float(prev.get("volume") or 0.0)
    prev_sma = float(prev.get("vol_sma20") or vol_sma or 1.0)
    spike_cur = (vol_cur / vol_sma) if vol_sma > 0 else 1.0
    spike_prev = (vol_prev / prev_sma) if prev_sma > 0 else 1.0
    vol_spike_x = round(max(spike_cur, spike_prev, 0.1), 2)

    # Detect patterns on last closed bar
    tail_klines = klines[-120:] if len(klines) > 120 else klines
    now_ms = int(tail_klines[-1][0]) + 86400_000
    patterns: list[str] = []
    try:
        c_hits = find_last_closed_candle_card_hits(tail_klines, now_ms=now_ms, interval=interval, symbol=symbol)
        for h in c_hits:
            lbl = str(h.get("type_label") or h.get("kind") or "").strip()
            if lbl and lbl not in patterns:
                patterns.append(lbl)
    except Exception:
        pass
    try:
        s_hits = find_last_closed_structure_hits(tail_klines, now_ms=now_ms, interval=interval)
        for h in s_hits:
            lbl = str(h.get("type_label") or h.get("kind") or "").strip()
            if lbl and lbl not in patterns:
                patterns.append(lbl)
    except Exception:
        pass

    if signal_override:
        sig_lbl = str(signal_override.get("signal_name") or signal_override.get("type_label") or "").strip()
        if sig_lbl and sig_lbl not in patterns:
            patterns.insert(0, sig_lbl)
        if signal_override.get("vol_ratio"):
            try:
                vol_spike_x = max(vol_spike_x, round(float(signal_override["vol_ratio"]), 2))
            except (TypeError, ValueError):
                pass

    # Trend & color_band & bias
    fast_mid = (v144 + v169) / 2.0
    slow_mid = (v576 + v676) / 2.0
    if close_v >= tun_hi and ema13 >= ema33:
        trend = "up"
        color_band = "green_bull"
        bias = "long"
    elif close_v >= tun_lo and fast_mid >= slow_mid:
        trend = "up"
        color_band = "green_range"
        bias = "long"
    elif close_v < tun_lo and ema13 < ema33 and fast_mid < slow_mid:
        trend = "down"
        color_band = "red"
        bias = "short"
    elif close_v < tun_lo:
        trend = "down"
        color_band = "red_range"
        bias = "short"
    else:
        trend = "range"
        color_band = "gray_range"
        bias = "long" if ema13 >= ema33 else "short"

    if signal_override and signal_override.get("side") in ("bull", "long", "bear", "short"):
        s_side = str(signal_override.get("side")).lower()
        bias = "long" if s_side in ("bull", "long") else "short"

    return {
        "patterns": patterns,
        "ema": {
            "13": round(ema13, 6),
            "33": round(ema33, 6),
            "99": round(ema99, 6),
            "144": round(ema144, 6),
        },
        "vegas": {
            "12": round(v12, 6),
            "144": round(v144, 6),
            "169": round(v169, 6),
            "576": round(v576, 6),
            "676": round(v676, 6),
        },
        "pos_vs_vegas": pos_vs_vegas,
        "color_band": color_band,
        "trend": trend,
        "volume_spike_x": vol_spike_x,
        "chg_pct": chg_pct,
        "bias": bias,
    }


async def build_ezcoin_snapshot(
    svc: Any,
    symbol: str,
    *,
    signal_tf: str = "15m",
    signal_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble full multi-timeframe (15m, 1h, 4h, 1d) snapshot JSON from oi_mornitor."""
    api_sym, short_sym = normalize_pair_and_short(symbol)
    tier, asset_class = classify_tier_and_asset(api_sym, short_sym)
    sig_tf = str(signal_tf or (signal_meta or {}).get("timeframe") or "15m").strip().lower()
    if sig_tf not in ("15m", "1h", "4h", "1d"):
        sig_tf = "15m"

    from oi_mornitor.pattern_monitor import fetch_open_interest_hist, fetch_pattern_klines

    base_url = getattr(getattr(svc, "radar", None), "base_url", None) or FAPI_BASE_URL

    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
        async def _get_k(iv: str, lim: int = 180) -> list[list]:
            return await fetch_pattern_klines(session, base_url=base_url, symbol=api_sym, interval=iv, limit=lim)

        async def _get_oi() -> dict[int, float]:
            if asset_class != "us_equity":
                return await fetch_open_interest_hist(session, base_url=base_url, symbol=api_sym, interval="15m", limit=16)
            return {}

        async def _get_prem() -> dict[str, Any]:
            if asset_class != "us_equity":
                return await fetch_premium_index(session, base_url=base_url, symbol=api_sym)
            return {}

        k15, k1h, k4h, k1d, oi_by_time, prem = await asyncio.gather(
            _get_k("15m", 180),
            _get_k("1h", 180),
            _get_k("4h", 180),
            _get_k("1d", 120),
            _get_oi(),
            _get_prem(),
        )
        if not k15 or not k1h:
            try:
                raw_fallback = Path(__file__).resolve().parent / "data" / f"btc_backtest_raw_{api_sym}.json"
                if raw_fallback.exists():
                    rc = json.loads(raw_fallback.read_text(encoding="utf-8"))
                    k15 = k15 or (rc.get("k15") or [])[-180:]
                    k1h = k1h or (rc.get("k1h") or [])[-180:]
                    k4h = k4h or (rc.get("k4h") or [])[-180:]
                    k1d = k1d or (rc.get("k1d") or [])[-120:]
            except Exception:
                pass

    tf_map: dict[str, Any] = {}
    for iv, kl in (("15m", k15), ("1h", k1h), ("4h", k4h), ("1d", k1d)):
        override = signal_meta if (signal_meta and iv == sig_tf) else None
        node = _compute_tf_node(kl, interval=iv, symbol=api_sym, signal_override=override)
        if node:
            tf_map[iv] = node

    # Price fallback from klines or radar rows
    price = 0.0
    for kl in (k15, k1h, k4h, k1d):
        if kl:
            try:
                price = float(kl[-1][4])
                break
            except (IndexError, TypeError, ValueError):
                pass

    all_rows = list(getattr(getattr(svc, "radar", None), "last_all_rows", None) or [])
    row_match: dict[str, Any] | None = None
    for r in all_rows:
        if str(r.get("symbol") or "").upper() == api_sym:
            row_match = r
            break
    if price <= 0 and row_match:
        price = float(row_match.get("last_price") or 0.0)

    # Calculate global intensity rank & OI metrics
    rank_intensity = 15
    chg_15m_pct = 0.0
    chg_15m_abs = 0.0
    if all_rows:
        # Sort by composite activity: |oi_change_pct_15m| + quote_volume weight
        scored: list[tuple[float, str]] = []
        for r in all_rows:
            s_name = str(r.get("symbol") or "").upper()
            oi_c15 = abs(float(r.get("oi_change_pct_15m") or 0.0))
            oi_c1h = abs(float(r.get("oi_change_pct_1h") or 0.0))
            qv = float(r.get("quote_volume") or 0.0)
            score = oi_c15 * 10.0 + oi_c1h * 3.0 + (qv / 1e8)
            scored.append((score, s_name))
        scored.sort(reverse=True)
        for idx, (_, s_name) in enumerate(scored, start=1):
            if s_name == api_sym:
                rank_intensity = idx
                break

    if row_match:
        chg_15m_pct = round(float(row_match.get("oi_change_pct_15m") or 0.0), 3)
        cur_oi_usd = float(row_match.get("current_oi_usd") or 0.0)
        chg_15m_abs = round(cur_oi_usd * (chg_15m_pct / 100.0), 2)

    oi_regime = classify_oi_price_regime(k15, oi_by_time) if k15 and oi_by_time else {}
    if chg_15m_pct == 0.0 and oi_regime.get("oi_chg_pct"):
        chg_15m_pct = float(oi_regime.get("oi_chg_pct") or 0.0)

    regime_name = str(oi_regime.get("regime") or "neutral")
    if regime_name == "breakout":
        side_bias = "long_building"
        synergy = True
    elif regime_name == "dump_oi_up":
        side_bias = "short_building"
        synergy = True
    elif regime_name == "squeeze":
        side_bias = "short_covering"
        synergy = False
    else:
        p_chg = float((tf_map.get("15m") or {}).get("chg_pct") or 0.0)
        if p_chg > 0 and chg_15m_pct > 0:
            side_bias = "long_building"
            synergy = True
        elif p_chg < 0 and chg_15m_pct > 0:
            side_bias = "short_building"
            synergy = True
        else:
            side_bias = "mixed"
            synergy = abs(chg_15m_pct) >= 0.5

    # Market risk_off & long/short ratio
    btc_row = next((r for r in all_rows if str(r.get("symbol") or "").upper() == "BTCUSDT"), None)
    btc_24h = float((btc_row or {}).get("price_change_pct_24h") or 0.0)
    risk_off = bool(btc_24h <= -6.0)
    up_cnt = sum(1 for r in all_rows[:50] if float(r.get("price_change_pct_24h") or 0.0) > 0)
    dn_cnt = max(1, min(50, len(all_rows)) - up_cnt)

    oi_block: dict[str, Any] = {}
    if asset_class != "us_equity":
        oi_block = {
            "chg_15m_abs": chg_15m_abs,
            "chg_15m_pct": chg_15m_pct,
            "rank_intensity_global": rank_intensity,
            "side_bias": side_bias,
            "price_oi_synergy": synergy,
        }
    else:
        oi_block = {
            "rank_intensity_global": min(rank_intensity, 10),
        }

    # Evaluate 15m tight stop-loss strategy for BTC / ETH (or any symbol on 15m)
    tight_sl_info: dict[str, Any] | None = None
    if isinstance((signal_meta or {}).get("tight_sl_strategy"), dict):
        tight_sl_info = dict(signal_meta["tight_sl_strategy"])
    elif k15 and len(k15) >= 30:
        try:
            df15 = enrich_tight_sl_df(klines_to_df(k15))
            pref_side = (signal_meta or {}).get("side") or (tf_map.get("15m") or {}).get("bias")
            existing_sig = (
                (signal_meta or {}).get("signal_name")
                or (signal_meta or {}).get("type_label")
                or ("/".join((tf_map.get("15m") or {}).get("patterns") or []) or None)
            )
            htf_trends = {
                "1h": tf_map.get("1h") or {},
                "4h": tf_map.get("4h") or {},
                "1d": tf_map.get("1d") or {},
            }
            # Check last closed bar (-2) and latest bar (-1), pick matched or higher confidence
            cand_indices = [len(df15) - 1]
            if len(df15) >= 32:
                cand_indices.insert(0, len(df15) - 2)
            best_eval: dict[str, Any] | None = None
            for c_idx in cand_indices:
                ev = evaluate_bar_15m_tight_sl(
                    df15,
                    c_idx,
                    symbol=api_sym,
                    htf_trends=htf_trends,
                    oi_chg_pct=chg_15m_pct,
                    preferred_side=pref_side,
                    existing_signal_name=existing_sig,
                )
                if not ev:
                    continue
                if best_eval is None:
                    best_eval = ev
                elif bool(ev.get("matched")) and not bool(best_eval.get("matched")):
                    best_eval = ev
                elif bool(ev.get("matched")) == bool(best_eval.get("matched")) and int(ev.get("confidence_pct") or 0) >= int(best_eval.get("confidence_pct") or 0):
                    best_eval = ev
            tight_sl_info = best_eval
        except Exception as exc:  # noqa: BLE001
            logger.debug("evaluate_bar_15m_tight_sl in build_ezcoin_snapshot failed: %s", exc)

    if tight_sl_info and "15m" in tf_map:
        tf_map["15m"]["tight_sl_strategy"] = tight_sl_info
        if tight_sl_info.get("matched") and sig_tf == "15m":
            res_summary = str(tight_sl_info.get("resonance_summary") or "").strip()
            p_list = list(tf_map["15m"].get("patterns") or [])
            if res_summary and res_summary not in p_list:
                p_list.insert(0, f"15m小止损:{res_summary}")
                tf_map["15m"]["patterns"] = p_list
            if tight_sl_info.get("side") in ("long", "short"):
                tf_map["15m"]["bias"] = tight_sl_info["side"]

    sig_name = (
        (signal_meta or {}).get("signal_name")
        or (signal_meta or {}).get("type_label")
        or (
            f"15m小止损（{tight_sl_info.get('resonance_summary')}）"
            if (sig_tf == "15m" and tight_sl_info and tight_sl_info.get("matched"))
            else None
        )
        or ("/".join((tf_map.get(sig_tf) or {}).get("patterns") or []) or "盘面快照")
    )

    snap: dict[str, Any] = {
        "schema_version": "1.0",
        "symbol": short_sym,
        "raw_symbol": api_sym,
        "tier": tier,
        "asset_class": asset_class,
        "signal_tf": sig_tf,
        "signal_name": sig_name,
        "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
        "ttl_sec": 900 if tier in ("T1", "T1_EQ") else 600,
        "price": price,
        "session": "open",
        "tf": tf_map,
        "oi": oi_block,
        "market": {
            "risk_off": risk_off,
            "funding_pct": float(prem.get("funding_rate_pct") or 0.0),
            "long_short_ratio": {"long": up_cnt, "short": dn_cnt},
        },
        "tight_sl_strategy": tight_sl_info or {},
        "extras": {
            "signal_meta": signal_meta or {},
        },
    }
    return snap


async def call_adapter_judge(
    snap: dict[str, Any],
    *,
    skip_llm: bool = False,
    signal_meta: dict[str, Any] | None = None,
    auto_btc_signal: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    """POST to ezcoin-adapter (127.0.0.1:5179/judge or /signal-btc)."""
    _ensure_loaded()
    endpoint = "/signal-btc" if auto_btc_signal else "/judge"
    url = f"{ADAPTER_BASE_URL}{endpoint}"
    payload = {
        "snapshot": snap,
        "skip_llm": skip_llm,
        "signal_meta": signal_meta or {},
        "auto_btc_signal": auto_btc_signal,
        "force": force,
        "from_oi_backend": True,
    }
    timeout = aiohttp.ClientTimeout(total=90)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=payload) as resp:
                data = await resp.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Call ezcoin-adapter %s failed: %s", url, exc)
        # Fallback to direct local import if server port is unreachable
        try:
            import sys
            adapter_dir = "/Users/maotouying/frontend/code/1.operations/ezcoin-adapter"
            if adapter_dir not in sys.path:
                sys.path.insert(0, adapter_dir)
            from judge import judge as direct_judge, save_judgment_log  # type: ignore
            out = await asyncio.to_thread(direct_judge, snap, skip_llm=skip_llm, signal_meta=signal_meta)
            log_path = await asyncio.to_thread(save_judgment_log, snap, out)
            data = {"ok": True, **out, "log": str(log_path)}
        except Exception as inner_exc:  # noqa: BLE001
            return {"ok": False, "error": f"Adapter error: {exc} / {inner_exc}"}

    sym = str(snap.get("symbol") or "BTC").upper()
    raw_sym = str(snap.get("raw_symbol") or f"{sym}USDT").upper()
    record = {
        "symbol": sym,
        "raw_symbol": raw_sym,
        "snapshot": snap,
        "judgment": data,
        "updated_at": data.get("checked_at") or datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    _LATEST_BY_SYMBOL[sym] = record
    _LATEST_BY_SYMBOL[raw_sym] = record
    return data


async def fetch_adapter_latest(symbol: str) -> dict[str, Any] | None:
    _ensure_loaded()
    api_sym, short_sym = normalize_pair_and_short(symbol)
    if short_sym in _LATEST_BY_SYMBOL:
        return _LATEST_BY_SYMBOL[short_sym]
    url = f"{ADAPTER_BASE_URL}/latest?symbol={short_sym}"
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as session:
            async with session.get(url) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    rec = {
                        "symbol": short_sym,
                        "raw_symbol": api_sym,
                        "snapshot": data.get("input") or {},
                        "judgment": data.get("output") or data,
                        "updated_at": (data.get("output") or data).get("checked_at"),
                    }
                    _LATEST_BY_SYMBOL[short_sym] = rec
                    _LATEST_BY_SYMBOL[api_sym] = rec
                    return rec
    except Exception:
        pass
    return None


def get_btc_signals_feed(limit: int = 30, timeframe: str = "", symbol: str = "") -> list[dict[str, Any]]:
    _ensure_loaded()
    items = list(_BTC_SIGNAL_FEED)
    if timeframe:
        tf = timeframe.strip().lower()
        items = [x for x in items if str(x.get("timeframe") or "").lower() == tf]
    if symbol:
        _, s_short = normalize_pair_and_short(symbol)
        items = [x for x in items if str(x.get("symbol") or "BTC").upper() == s_short]
    return items[:limit]


def _ai_judge_telegram_chats() -> list[str]:
    """Prefer AI_JUDGE_TELEGRAM_CHAT_ID, then MAIN/CANDLE/TELEGRAM_* groups (deduped)."""
    chats: list[str] = []
    for c in (
        AI_JUDGE_TELEGRAM_CHAT_ID,
        MAIN_CARD_TELEGRAM_CHAT_ID,
        CANDLE_CARD_TELEGRAM_CHAT_ID,
        TELEGRAM_PUSH_CHAT_ID,
        TELEGRAM_CHAT_ID,
    ):
        cs = str(c or "").strip()
        if cs and cs not in chats:
            chats.append(cs)
    return chats


def push_judgment_to_telegram(
    formatted_text: str,
    *,
    action: str | None = None,
    conflicts: list | None = None,
    ai_status: str | None = None,
    cooldown_key: str | None = None,
) -> bool:
    """Push program-formatted realtime signal to Telegram group(s).

    Default whitelist: LONG/SHORT only (see AI_JUDGE_TELEGRAM_ACTIONS).
    Never push LLM failure / NO_TRADE / WATCH spam. Cooldown blocks same setup re-fire.
    Missing bot token / chat id → clear warning log, no crash.
    """
    global _LLM_FAIL_WARNED_AT
    if not formatted_text or not formatted_text.strip():
        return False
    if not AI_JUDGE_TELEGRAM_PUSH:
        logger.info("AI 实时信号 Telegram 推送已关闭 (AI_JUDGE_TELEGRAM_PUSH=0)")
        return False

    confs = {str(c).strip().lower() for c in (conflicts or []) if c is not None}
    st = str(ai_status or "").strip().lower()
    # LLM 失败：静默跳过 TG，最多每 30 分钟打一条本地警告（不把 401 全文推到群）
    if "llm_call_failed" in confs or st == "error" or "模型调用失败" in formatted_text or "Authentication Fails" in formatted_text:
        now = time.time()
        if now - _LLM_FAIL_WARNED_AT >= 1800:
            _LLM_FAIL_WARNED_AT = now
            logger.warning("AI 实时信号跳过 TG：LLM 调用失败（本地仅记一次/30min，不推送失败文案）")
        else:
            logger.info("AI 实时信号跳过 TG：LLM 调用失败（冷却中）")
        return False

    act = str(action or "").strip().upper()
    allowed = set(AI_JUDGE_TELEGRAM_ACTIONS) or {"LONG", "SHORT"}
    if "*" not in allowed and "ALL" not in allowed and act and act not in allowed:
        logger.info("AI 信号 action=%s 不在推送白名单 %s，跳过 TG", act, sorted(allowed))
        return False
    # 双保险：默认路径绝不推观望/不做
    if act in ("WATCH", "NO_TRADE", "HOLD", "") and "*" not in allowed and "ALL" not in allowed:
        logger.info("AI 信号 action=%s 为观望/不做，跳过 TG", act or "(empty)")
        return False

    cd_key = str(cooldown_key or "").strip()
    if cd_key:
        last = float(_BTC_PUSH_COOLDOWN.get(cd_key) or 0.0)
        gap = time.time() - last
        if last > 0 and gap < float(AI_JUDGE_TG_COOLDOWN_SEC):
            logger.info(
                "AI 信号冷却中 key=%s remain=%.0fs，跳过 TG",
                cd_key,
                float(AI_JUDGE_TG_COOLDOWN_SEC) - gap,
            )
            return False

    chats = _ai_judge_telegram_chats()
    has_cred = bool(TELEGRAM_BOT_TOKEN or TELEGRAM_SEND_URL)
    if not chats or not has_cred:
        logger.warning(
            "AI 实时信号 Telegram 未配置完整凭据，跳过推送 "
            "(bot_token=%s send_url=%s chats=%s)。"
            "请设置 TELEGRAM_BOT_TOKEN 或 TELEGRAM_SEND_URL，以及 "
            "AI_JUDGE_TELEGRAM_CHAT_ID（或 MAIN_CARD / CANDLE / TELEGRAM_CHAT_ID）",
            bool(TELEGRAM_BOT_TOKEN),
            bool(TELEGRAM_SEND_URL),
            chats or "(empty)",
        )
        return False

    ok_any = False
    for chat in chats:
        try:
            if send_telegram_text(formatted_text, chat_id=chat):
                ok_any = True
                logger.info("AI 实时信号已推送 Telegram chat_id=%s action=%s", chat, act or "-")
            else:
                logger.warning("AI 实时信号推送失败 chat_id=%s action=%s", chat, act or "-")
        except Exception as exc:  # noqa: BLE001
            logger.warning("AI 实时信号推送异常 chat_id=%s: %s", chat, exc)
    if ok_any and cd_key:
        _BTC_PUSH_COOLDOWN[cd_key] = time.time()
        # prune old cooldown keys
        if len(_BTC_PUSH_COOLDOWN) > 500:
            cutoff = time.time() - max(float(AI_JUDGE_TG_COOLDOWN_SEC) * 4, 3600)
            for k in list(_BTC_PUSH_COOLDOWN):
                if _BTC_PUSH_COOLDOWN[k] < cutoff:
                    _BTC_PUSH_COOLDOWN.pop(k, None)
    return ok_any


def sync_btc_signal_from_adapter(item: dict[str, Any], *, push_telegram: bool = False) -> dict[str, Any]:
    """Record a BTC signal judgment item pushed from ezcoin-adapter (:5179) into oi_mornitor feed."""
    _ensure_loaded()
    dk = str(item.get("dedupe_key") or "")
    if dk and dk not in _BTC_SEEN_KEYS:
        _BTC_SEEN_KEYS.add(dk)
        _BTC_SIGNAL_FEED.insert(0, item)
        del _BTC_SIGNAL_FEED[100:]
        _save_btc_signals()
    sym = str(item.get("symbol") or "BTC").upper()
    if item.get("output") and item.get("snapshot"):
        _LATEST_BY_SYMBOL[sym] = {
            "symbol": sym,
            "raw_symbol": f"{sym}USDT",
            "snapshot": item["snapshot"],
            "judgment": item["output"],
            "updated_at": item.get("checked_at"),
        }
        _LATEST_BY_SYMBOL[f"{sym}USDT"] = _LATEST_BY_SYMBOL[sym]
    pushed = False
    if push_telegram and item.get("formatted_text"):
        pushed = push_judgment_to_telegram(
            str(item["formatted_text"]),
            action=str(item.get("action") or ""),
            conflicts=list(item.get("conflicts") or []),
            ai_status=str(item.get("ai_status") or item.get("judgment", {}).get("ai_status") or ""),
            cooldown_key=str(item.get("dedupe_key") or ""),
        )
        item["pushed_telegram"] = pushed
    return item


async def trigger_btc_signal_auto_judge(
    svc: Any,
    alert: dict[str, Any],
    *,
    skip_llm: bool = False,
    push_telegram: bool = False,
    force: bool = False,
) -> dict[str, Any] | None:
    """Automatically run ezcoin-adapter judgment when a BTC or ETH 15m/1h/4h/1d signal fires."""
    _ensure_loaded()
    raw_sym = str(alert.get("symbol") or "BTCUSDT").strip().upper()
    api_sym, short_sym = normalize_pair_and_short(raw_sym)
    if short_sym not in ("BTC", "ETH"):
        return None

    iv = str(alert.get("interval") or alert.get("timeframe") or "15m").strip().lower()
    if iv not in BTC_ALLOWED_TFS:
        return None

    raw_bar = (
        alert.get("kline_open_time")
        or alert.get("bar_open_sec")
        or alert.get("kline_close_time")
        or alert.get("bar_ts")
        or alert.get("time")
        or int(time.time())
    )
    # Normalize to seconds; for 15m tight-SL floor to bar open so mid-bar rescans don't rekey
    try:
        bar_num = int(float(raw_bar))
        if bar_num > 10_000_000_000:  # ms → sec
            bar_num //= 1000
        if iv == "15m":
            bar_num = (bar_num // 900) * 900
        elif iv == "1h":
            bar_num = (bar_num // 3600) * 3600
        elif iv == "4h":
            bar_num = (bar_num // 14400) * 14400
        bar_ts = str(bar_num)
    except (TypeError, ValueError):
        bar_ts = str(raw_bar).strip() or str(int(time.time()))

    sig_kind = str(
        alert.get("kind")
        or alert.get("vp_type")
        or alert.get("type")
        or alert.get("signal_kind")
        or "signal"
    ).strip()
    sig_name = str(
        alert.get("type_label")
        or alert.get("signal_name")
        or alert.get("signal_text")
        or sig_kind
    ).strip()

    side_hint = str(
        alert.get("side")
        or (alert.get("tight_sl_strategy") or {}).get("side")
        or ""
    ).strip().lower()
    if side_hint in ("bull", "long", "buy"):
        side_key = "long"
    elif side_hint in ("bear", "short", "sell"):
        side_key = "short"
    else:
        side_key = side_hint or "na"

    is_tight = (
        "tight_sl" in sig_kind.lower()
        or isinstance(alert.get("tight_sl_strategy"), dict)
        and bool((alert.get("tight_sl_strategy") or {}).get("matched"))
    )
    # 15m 小止损：按 币种+周期+方向+信号棒 去重（忽略共振文案变化）
    if is_tight and iv == "15m":
        dedupe_key = f"{short_sym}:{iv}:tight_sl_15m:{bar_ts}:{side_key}"
    else:
        # 同棒同币种同周期合并，避免形态 kind 变体每 3~4 分钟各推一次
        dedupe_key = f"{short_sym}:{iv}:{bar_ts}:{side_key}"

    if not force and dedupe_key in _BTC_SEEN_KEYS:
        existing = next((x for x in _BTC_SIGNAL_FEED if x.get("dedupe_key") == dedupe_key), None)
        if existing:
            alert["ai_judgment"] = existing
            return {**existing, "deduped": True}
        return {"ok": True, "deduped": True, "dedupe_key": dedupe_key}

    signal_meta: dict[str, Any] = {
        "symbol": short_sym,
        "timeframe": iv,
        "interval": iv,
        "signal_kind": sig_kind,
        "signal_name": sig_name,
        "type_label": sig_name,
        "side": alert.get("side"),
        "bar_ts": bar_ts,
        "vol_ratio": alert.get("vol_ratio"),
        "price": alert.get("price") or alert.get("close"),
    }
    if isinstance(alert.get("tight_sl_strategy"), dict):
        signal_meta["tight_sl_strategy"] = alert["tight_sl_strategy"]

    snap = await build_ezcoin_snapshot(
        svc,
        api_sym,
        signal_tf=iv,
        signal_meta=signal_meta,
    )
    res = await call_adapter_judge(
        snap,
        skip_llm=skip_llm,
        signal_meta=signal_meta,
        auto_btc_signal=True,
        force=force,
    )
    if not res.get("ok"):
        logger.warning("%s auto judge failed for %s: %s", short_sym, dedupe_key, res.get("error"))
        return res

    formatted_text = str(res.get("formatted_text") or "")
    pushed_tg = False
    # 默认仅 LONG/SHORT；LLM 失败 / 观望 / 不做 不推；cooldown 挡同 setup 刷屏
    act_out = str(res.get("action") or "").strip().upper()
    if side_key in ("long", "short"):
        cd_side = side_key
    elif act_out == "LONG":
        cd_side = "long"
    elif act_out == "SHORT":
        cd_side = "short"
    else:
        cd_side = "na"
    cooldown_key = f"{short_sym}:{iv}:{cd_side}:{bar_ts}"
    if push_telegram and formatted_text and not res.get("deduped"):
        pushed_tg = await asyncio.to_thread(
            push_judgment_to_telegram,
            formatted_text,
            action=act_out,
            conflicts=list(res.get("conflicts") or []),
            ai_status=str(res.get("ai_status") or ""),
            cooldown_key=cooldown_key,
        )

    feed_item = {
        "id": f"{short_sym.lower()}-{iv}-{int(time.time() * 1000)}",
        "dedupe_key": dedupe_key,
        "symbol": short_sym,
        "raw_symbol": api_sym,
        "timeframe": iv,
        "signal_kind": sig_kind,
        "signal_name": res.get("signal_name") or sig_name,
        "bar_ts": bar_ts,
        "price": snap.get("price"),
        "gate_result": res.get("gate_result"),
        "gate_reasons": res.get("gate_reasons") or [],
        "action": res.get("action"),
        "confidence": res.get("confidence"),
        "confidence_pct": res.get("confidence_pct"),
        "confidence_band": res.get("confidence_band"),
        "tight_sl_strategy": res.get("tight_sl_strategy") or snap.get("tight_sl_strategy"),
        "entry": res.get("entry"),
        "sl": res.get("sl"),
        "tp": res.get("tp"),
        "trail": res.get("trail"),
        "entry_watch": res.get("entry_watch"),
        "sl_watch": res.get("sl_watch"),
        "tp_watch": res.get("tp_watch"),
        "conflicts": res.get("conflicts") or [],
        "rationale": res.get("rationale"),
        "formatted_text": formatted_text,
        "pushed_telegram": pushed_tg,
        "checked_at": res.get("checked_at") or datetime.now().astimezone().isoformat(timespec="seconds"),
        "log": res.get("log"),
        "snapshot": snap,
        "judgment": res,
        "deduped": False,
    }

    _BTC_SEEN_KEYS.add(dedupe_key)
    _BTC_SIGNAL_FEED.insert(0, feed_item)
    del _BTC_SIGNAL_FEED[100:]
    _save_btc_signals()

    alert["ai_judgment"] = {
        "gate_result": feed_item["gate_result"],
        "action": feed_item["action"],
        "confidence": feed_item["confidence"],
        "confidence_pct": feed_item.get("confidence_pct"),
        "confidence_band": feed_item.get("confidence_band"),
        "tight_sl_strategy": feed_item.get("tight_sl_strategy"),
        "entry": feed_item.get("entry"),
        "sl": feed_item.get("sl"),
        "tp": feed_item.get("tp"),
        "trail": feed_item.get("trail"),
        "entry_watch": feed_item["entry_watch"],
        "sl_watch": feed_item["sl_watch"],
        "tp_watch": feed_item.get("tp_watch"),
        "conflicts": feed_item["conflicts"],
        "rationale": feed_item["rationale"],
        "formatted_text": formatted_text,
        "checked_at": feed_item["checked_at"],
    }
    logger.info(
        "%s %s 信号自动 AI 研判完成: %s -> gate=%s action=%s conf=%s%% tg=%s",
        short_sym,
        iv,
        sig_name,
        feed_item["gate_result"],
        feed_item["action"],
        feed_item.get("confidence_pct"),
        pushed_tg,
    )
    return feed_item
