"""AI BTC 1h 信号 + 15m 柱结算对照（composite vs protect）。"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from oi_mornitor.config import BTC_AI_BACKTEST_FIXTURE
from oi_mornitor.strategy.tight_sl_15m import (
    OhlcBar,
    SETTLEMENT_LABELS,
    SettlementMode,
    compute_composite_trade_plan,
    evaluate_future_outcome,
    simulate_tight_sl_outcome,
    summarize_sim_results,
)

logger = logging.getLogger(__name__)

SETTLEMENT_MODES: tuple[SettlementMode, ...] = (
    "entry_sl_tp_trail",
    "entry_sl_tp_protect",
)


def _bars_from_raw(raw: list[dict[str, Any]]) -> list[OhlcBar]:
    out: list[OhlcBar] = []
    for b in raw:
        if not isinstance(b, dict):
            continue
        try:
            out.append(
                OhlcBar(
                    ts=int(b.get("ts") or b.get("open_time") or 0),
                    open=float(b["open"]),
                    high=float(b["high"]),
                    low=float(b["low"]),
                    close=float(b["close"]),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return out


def run_settlement_compare_on_trades(
    trades: list[dict[str, Any]],
    *,
    modes: tuple[SettlementMode, ...] = SETTLEMENT_MODES,
) -> dict[str, Any]:
    """每笔需含 side, entry, sl, bars_15m（入场后 15m 序列）。"""
    by_mode: dict[str, list] = {m: [] for m in modes}
    horizon_rows: list[dict[str, Any]] = []

    for tr in trades:
        if not isinstance(tr, dict):
            continue
        side = str(tr.get("side") or "long")
        entry = float(tr.get("entry") or 0)
        sl = float(tr.get("sl") or 0)
        if entry <= 0:
            continue
        bars = _bars_from_raw(tr.get("bars_15m") or [])
        if len(bars) < 4:
            continue
        plan = compute_composite_trade_plan(side=side, entry=entry, sl=sl)
        h1 = evaluate_future_outcome(plan, bars, horizon_bars=4)
        h4 = evaluate_future_outcome(plan, bars, horizon_bars=16)
        h8 = evaluate_future_outcome(plan, bars, horizon_bars=32)
        horizon_rows.append(
            {
                "id": tr.get("id"),
                "h1_win": h1,
                "h4_win": h4,
                "h8_win": h8,
            }
        )
        for mode in modes:
            sim = simulate_tight_sl_outcome(plan, bars, settlement=mode)
            by_mode[mode].append(sim)

    summaries = {}
    for m in modes:
        s = summarize_sim_results(by_mode[m])
        s["label"] = SETTLEMENT_LABELS.get(m, m)
        s["mode"] = m
        summaries[m] = s
    h_n = len(horizon_rows)
    horizon_summary = {
        "count": h_n,
        "h1_win_rate": round(sum(1 for r in horizon_rows if r["h1_win"]) / h_n, 4) if h_n else None,
        "h4_win_rate": round(sum(1 for r in horizon_rows if r["h4_win"]) / h_n, 4) if h_n else None,
        "h8_win_rate": round(sum(1 for r in horizon_rows if r["h8_win"]) / h_n, 4) if h_n else None,
        "note": "horizon 按收盘价方向，不经 TP/SL",
    }
    return {
        "trade_count": len(horizon_rows),
        "settlements": summaries,
        "horizon": horizon_summary,
        "modes": list(modes),
    }


def load_fixture_trades(path: str | Path | None = None) -> list[dict[str, Any]]:
    p = Path(path or BTC_AI_BACKTEST_FIXTURE)
    if not p.is_file():
        logger.warning("BTC 回测 fixture 不存在: %s", p)
        return []
    raw = json.loads(p.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        return list(raw.get("trades") or [])
    if isinstance(raw, list):
        return raw
    return []


def run_from_fixture(path: str | Path | None = None) -> dict[str, Any]:
    trades = load_fixture_trades(path)
    payload = run_settlement_compare_on_trades(trades)
    payload["fixture"] = str(path or BTC_AI_BACKTEST_FIXTURE)
    payload["source"] = "fixture"
    return payload


def run_from_request_body(body: dict[str, Any]) -> dict[str, Any]:
    trades = body.get("trades")
    if not isinstance(trades, list):
        trades = load_fixture_trades(body.get("fixture_path"))
    payload = run_settlement_compare_on_trades(trades)
    payload["source"] = "request" if body.get("trades") else "fixture"
    return payload
