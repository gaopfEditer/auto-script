"""币股形态扫描：1h/4h · 无 OI 组合 · 美股时段门控。"""
from __future__ import annotations

import logging
import time
from typing import Any

import aiohttp

from oi_mornitor.config import (
    OI_EQUITY_ENABLED,
    OI_EQUITY_KLINE_INTERVALS,
    OI_EQUITY_SIGNAL_SESSION_ONLY,
)
from oi_mornitor.equity_pool import EquityItem, is_us_equity_session_now
from oi_mornitor.pattern_monitor import fetch_pattern_klines_batch
from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.strategy.candle_signals import find_last_closed_candle_card_hits
from oi_mornitor.strategy.indicators import enrich_strategy_indicators
from oi_mornitor.strategy.structure_signals import find_last_closed_structure_hits

logger = logging.getLogger("OI_Radar")

# 允许入库/推送的 typeLabel（与胜率正贡献对齐）
EQUITY_ALLOWED_TYPE_LABELS = frozenset(
    {
        "底部二次探底确认",
        "量价确认-多",
        "量价推进-多",
        "倒锤子",
        "射击之星",
        "连续走平射击之星",
        "Vegas回踩",
    }
)

EQUITY_BLOCKED_SUBSTR = ("(oi异动)", "V+", "V-", "连续上插针", "连续下插针", "破底翻")


def _blocked_label(label: str) -> bool:
    s = str(label or "")
    if any(x in s for x in EQUITY_BLOCKED_SUBSTR):
        return True
    if "oi异动" in s.lower():
        return True
    return False


def _alert_from_hit(
    *,
    item: EquityItem,
    interval: str,
    hit: dict[str, Any],
    scan_ts: float,
    record_signal: bool,
) -> dict[str, Any] | None:
    label = str(hit.get("type_label") or hit.get("label") or "").strip()
    if not label or _blocked_label(label):
        return None
    if label not in EQUITY_ALLOWED_TYPE_LABELS and not label.startswith("Vegas"):
        return None
    side = str(hit.get("side") or hit.get("side_hint") or "").lower()
    if side not in ("long", "short", "bull", "bear"):
        if "空" in label or "射击" in label:
            side = "short"
        else:
            side = "long"
    close_px = hit.get("close")
    try:
        entry = float(close_px) if close_px is not None else float(item.last_price or 0)
    except (TypeError, ValueError):
        entry = float(item.last_price or 0)
    return {
        "type": "equity_pattern",
        "symbol": item.symbol,
        "base": item.base,
        "interval": interval,
        "side": side,
        "type_label": label,
        "message": hit.get("message") or label,
        "close": entry if entry > 0 else None,
        "price": entry if entry > 0 else None,
        "last_price": item.last_price,
        "kline_close_time": int(hit.get("time") or scan_ts),
        "scan_ts": scan_ts,
        "asset_class": "equity",
        "tier": "equity",
        "ui_tag": item.ui_tag,
        "oi_available": item.oi_available,
        "session_ok": item.session_ok,
        "record_signal": record_signal,
        "source": "equity_pattern",
    }


async def scan_equity_patterns(
    session: aiohttp.ClientSession,
    *,
    base_url: str,
    equity_pool: list[EquityItem],
    scan_ts: float | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """返回 (alerts, states)。非美股时段仍更新 states，但不 record_signal。"""
    if not OI_EQUITY_ENABLED or not equity_pool:
        return [], []

    ts = scan_ts or time.time()
    session_ok = is_us_equity_session_now(ts=ts)
    record_signal = session_ok or not OI_EQUITY_SIGNAL_SESSION_ONLY
    intervals = [iv for iv in OI_EQUITY_KLINE_INTERVALS if iv in ("1h", "4h")]
    if not intervals:
        intervals = ["1h", "4h"]

    symbols = [x.symbol for x in equity_pool if x.symbol]
    klines_by_sym_iv: dict[tuple[str, str], list] = {}
    for iv in intervals:
        km = await fetch_pattern_klines_batch(
            session,
            base_url=base_url,
            symbols=symbols,
            interval=iv,
            limit=200,
        )
        for sym, rows in km.items():
            klines_by_sym_iv[(sym, iv)] = rows or []

    alerts: list[dict[str, Any]] = []
    states: list[dict[str, Any]] = []
    now_ms = int(ts * 1000)

    for item in equity_pool:
        sym = item.symbol
        sym_states: list[str] = []
        for iv in intervals:
            kl = klines_by_sym_iv.get((sym, iv)) or []
            if len(kl) < 30:
                continue
            try:
                df = enrich_strategy_indicators(klines_to_df(kl))
            except Exception as exc:  # noqa: BLE001
                logger.debug("币股指标失败 %s %s: %s", sym, iv, exc)
                continue

            for hit in find_last_closed_candle_card_hits(
                df,
                now_ms=now_ms,
                allow_inverted_hammer=True,
                allow_shooting_star=True,
            ):
                alert = _alert_from_hit(
                    item=item,
                    interval=iv,
                    hit=hit,
                    scan_ts=ts,
                    record_signal=record_signal,
                )
                if alert:
                    alerts.append(alert)

            for hit in find_last_closed_structure_hits(df, now_ms=now_ms):
                label = str(hit.get("type_label") or hit.get("label") or "")
                if label == "破底翻确认" or _blocked_label(label):
                    continue
                alert = _alert_from_hit(
                    item=item,
                    interval=iv,
                    hit=hit,
                    scan_ts=ts,
                    record_signal=record_signal,
                )
                if alert:
                    alerts.append(alert)

            sym_states.append(iv)

        states.append(
            {
                "symbol": sym,
                "base": item.base,
                "asset_class": "equity",
                "tier": "equity",
                "intervals": sym_states,
                "session_ok": session_ok,
                "ui_tag": item.ui_tag,
                "last_price": item.last_price,
                "oi_available": item.oi_available,
                "oi_usd": item.oi_usd,
            }
        )

    if alerts:
        logger.info(
            "币股形态 %d 条 · session_ok=%s record=%s",
            len(alerts),
            session_ok,
            record_signal,
        )
    return alerts, states
