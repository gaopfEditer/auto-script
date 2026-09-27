"""量价信号 → 形态 ticker alert（仅 ticker，不进 TG / 胜率库）。"""
from __future__ import annotations

import time
from typing import Any

import pandas as pd

from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.pattern_detector import enrich_indicators
from oi_mornitor.signal_policy import is_blocked_ticker_alert
from oi_mornitor.strategy.candle_signals import closed_bar_index
from oi_mornitor.volume_price.signals import VolumePriceSignal, generate_signals

MIN_SCORE = 0.75
SIGNAL_TF = "15m"

_VP_TYPE_LABELS: dict[tuple[str, str, str], tuple[str, str]] = {
    ("continuation", "thrust", "long"): ("vp_cont_thrust", "量价推进·多"),
    ("continuation", "thrust", "short"): ("vp_cont_thrust", "量价推进·空"),
    ("continuation", "confirm", "long"): ("vp_cont_confirm", "量价确认·多"),
    ("continuation", "confirm", "short"): ("vp_cont_confirm", "量价确认·空"),
    ("reversal", "climax", "long"): ("vp_rev_climax", "高潮反转·多"),
    ("reversal", "climax", "short"): ("vp_rev_climax", "高潮反转·空"),
    ("reversal", "effort_no_result", "long"): ("vp_rev_effort", "努力无果反转·多"),
    ("reversal", "effort_no_result", "short"): ("vp_rev_effort", "努力无果反转·空"),
}


def _klines_to_rows(
    klines_map: dict[str, list[list[Any]]],
    *,
    tf: str,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for sym, klines in (klines_map or {}).items():
        symbol = str(sym or "").strip().upper()
        if not symbol:
            continue
        for k in klines or []:
            if not isinstance(k, (list, tuple)) or len(k) < 7:
                continue
            try:
                rows.append(
                    {
                        "ts": int(k[0]),
                        "close_time": int(k[6]),
                        "symbol": symbol,
                        "tf": tf,
                        "open": float(k[1]),
                        "high": float(k[2]),
                        "low": float(k[3]),
                        "close": float(k[4]),
                        "volume": float(k[5]),
                    }
                )
            except (TypeError, ValueError):
                continue
    return rows


def klines_map_to_vp_df(
    klines_map_15m: dict[str, list[list[Any]]] | None = None,
    *,
    klines_map_1h: dict[str, list[list[Any]]] | None = None,
    klines_map_4h: dict[str, list[list[Any]]] | None = None,
) -> pd.DataFrame:
    """Binance K 线 batch → 量价模块 DataFrame（多周期信号 + HTF 过滤）。"""
    rows: list[dict[str, Any]] = []
    if klines_map_15m:
        rows.extend(_klines_to_rows(klines_map_15m, tf="15m"))
    if klines_map_1h:
        rows.extend(_klines_to_rows(klines_map_1h, tf="1h"))
    if klines_map_4h:
        rows.extend(_klines_to_rows(klines_map_4h, tf="4h"))
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    return df.sort_values(["symbol", "tf", "ts"]).reset_index(drop=True)


def _resolve_vp_type(sig: VolumePriceSignal) -> tuple[str, str] | None:
    side = str(sig.side or "").lower()
    if sig.kind == "continuation":
        key = (sig.kind, str(sig.bar_class or ""), side)
    elif sig.kind == "reversal":
        reason = str(sig.reason or "")
        setup = None
        if "climax" in reason:
            setup = "climax"
        elif "effort_no_result" in reason:
            setup = "effort_no_result"
        if not setup:
            return None
        key = (sig.kind, setup, side)
    else:
        return None
    return _VP_TYPE_LABELS.get(key)


def volume_price_signal_to_alert(
    sig: VolumePriceSignal,
    *,
    kline_close_time: int,
    scan_ts: float,
) -> dict[str, Any] | None:
    resolved = _resolve_vp_type(sig)
    if not resolved:
        return None
    typ, type_label = resolved
    if sig.observation_only:
        type_label = f"{type_label}（观察）"
    side = "long" if str(sig.side).lower() == "long" else "short"
    return {
        "symbol": sig.symbol,
        "type": typ,
        "type_label": type_label,
        "side": side,
        "interval": sig.tf,
        "kind": sig.bar_class,
        "score": float(sig.score),
        "observation_only": bool(sig.observation_only),
        "entry_hint": float(sig.entry_hint),
        "invalid_level": float(sig.invalid_level),
        "price": float(sig.entry_hint),
        "close": float(sig.entry_hint),
        "message": sig.reason,
        "status_label": type_label,
        "kline_close_time": int(kline_close_time),
        "kline_open_time": int(sig.ts),
        "scan_ts": scan_ts,
    }


def _vegas_down_on_1h(klines_1h: list[list[Any]] | None) -> bool:
    """EMA144/169 中轨 < EMA576/676 中轨（Vegas DOWN）。"""
    if not klines_1h or len(klines_1h) < 680:
        return False
    try:
        df = enrich_indicators(klines_to_df(klines_1h))
        if df.empty:
            return False
        row = df.iloc[-2] if len(df) >= 2 else df.iloc[-1]
        e1 = float(row.get("vegas_e1") or 0)
        e2 = float(row.get("vegas_e2") or 0)
        e3 = float(row.get("vegas_e3") or 0)
        e4 = float(row.get("vegas_e4") or 0)
        if not all(x > 0 for x in (e1, e2, e3, e4)):
            return False
        fast_mid = (e1 + e2) / 2.0
        slow_mid = (e3 + e4) / 2.0
        return fast_mid < slow_mid
    except Exception:  # noqa: BLE001
        return False


def scan_volume_price_ticker_alerts(
    klines_map_15m: dict[str, list[list[Any]]] | None = None,
    *,
    klines_map_1h: dict[str, list[list[Any]]] | None = None,
    klines_map_4h: dict[str, list[list[Any]]] | None = None,
    signal_tfs: tuple[str, ...] | None = None,
    scan_ts: float | None = None,
    now_ms: int | None = None,
) -> list[dict[str, Any]]:
    """watchlist 多周期 K 线扫描量价信号，仅最后一根已收盘柱、score≥0.75。"""
    tfs = signal_tfs or (SIGNAL_TF,)
    if not klines_map_15m and not klines_map_1h and not klines_map_4h:
        return []

    df = klines_map_to_vp_df(
        klines_map_15m,
        klines_map_1h=klines_map_1h,
        klines_map_4h=klines_map_4h,
    )
    if df.empty:
        return []

    signals, _enriched = generate_signals(df, signal_tfs=tfs)
    if not signals:
        return []

    now = int(now_ms if now_ms is not None else time.time() * 1000)
    ts_val = scan_ts if scan_ts is not None else time.time()

    close_time_by_index: dict[tuple[str, str, int], int] = {}
    closed_index_by_sym_tf: dict[tuple[str, str], int] = {}
    for (sym, tf), chunk in df.groupby(["symbol", "tf"], sort=False):
        if str(tf) not in tfs:
            continue
        chunk = chunk.reset_index(drop=True)
        tf_s = str(tf)
        sym_s = str(sym)
        closed_idx = closed_bar_index(chunk, now_ms=now)
        closed_index_by_sym_tf[(sym_s, tf_s)] = closed_idx
        for i, row in chunk.iterrows():
            close_time_by_index[(sym_s, tf_s, int(i))] = int(
                row.get("close_time") or row["ts"]
            )

    picked: dict[tuple[str, str], VolumePriceSignal] = {}
    for sig in signals:
        if sig.tf not in tfs or float(sig.score) < MIN_SCORE:
            continue
        sym = str(sig.symbol)
        tf_s = str(sig.tf)
        closed_idx = closed_index_by_sym_tf.get((sym, tf_s), -1)
        if closed_idx < 0 or int(sig.signal_bar_index) != closed_idx:
            continue
        key = (sym, tf_s)
        prev = picked.get(key)
        if prev is None or float(sig.score) > float(prev.score):
            picked[key] = sig

    alerts: list[dict[str, Any]] = []
    for (sym, tf_s), sig in picked.items():
        closed_idx = closed_index_by_sym_tf.get((sym, tf_s), -1)
        kline_close_time = close_time_by_index.get((sym, tf_s, closed_idx), int(sig.ts))
        alert = volume_price_signal_to_alert(
            sig,
            kline_close_time=kline_close_time,
            scan_ts=ts_val,
        )
        if not alert or is_blocked_ticker_alert(alert):
            continue
        lab = str(alert.get("type_label") or "")
        if "量价确认" in lab and "空" in lab:
            sym_1h = (klines_map_1h or {}).get(sym)
            if not _vegas_down_on_1h(sym_1h):
                continue
        alerts.append(alert)
    return alerts
