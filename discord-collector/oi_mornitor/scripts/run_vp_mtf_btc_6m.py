#!/usr/bin/env python3
"""BTC 半年回测：1h跌15m入（级联）+ 15m放量插针×1h射击之星/倒锤子（MTF）。

结算：形态 V1 固定 %（TP 分批 + SL 5%，15m 步进，3h 核实窗）— 与 pattern_settle 一致。
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from oi_mornitor.backtest.sequoia_pipeline import resolve_klines_root
from oi_mornitor.backtest_kline_store import BacktestKlineStore
from oi_mornitor.backtest_common import kline_window_ms
from oi_mornitor.backtest_trade_config import OI_BT_FEE_PCT, OI_BT_SLIPPAGE_PCT
from oi_mornitor.pattern_settle import settle_signal_batch
from oi_mornitor.volume_price.vp_mtf_signals import VpMtfSignal, scan_all_vp_mtf

TZ = ZoneInfo("Asia/Shanghai")
START = datetime(2026, 5, 13, 0, 0, tzinfo=TZ)
END = datetime(2026, 11, 13, 0, 0, tzinfo=TZ)
START_MS = int(START.timestamp() * 1000)
END_MS = int(END.timestamp() * 1000)
SYMBOL = "BTCUSDT"
OUT = ROOT / "oi_mornitor" / "data" / "vp_mtf_btc_6m"


def _rows_to_df(rows: list[list]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(columns=["open_time", "open", "high", "low", "close", "volume"])
    return pd.DataFrame(
        [
            {
                "open_time": int(r[0]),
                "open": float(r[1]),
                "high": float(r[2]),
                "low": float(r[3]),
                "close": float(r[4]),
                "volume": float(r[5]),
            }
            for r in rows
        ]
    )


def _bars_for_settle(df: pd.DataFrame) -> list[dict[str, float]]:
    return [
        {"ts": int(r["open_time"]), "high": float(r["high"]), "low": float(r["low"]), "close": float(r["close"])}
        for _, r in df.iterrows()
    ]


def _filter_kind(signals: list[VpMtfSignal], kinds: set[str]) -> list[VpMtfSignal]:
    return [s for s in signals if s.kind in kinds]


def _dedupe_by_bar(signals: list[VpMtfSignal]) -> list[VpMtfSignal]:
    by: dict[int, VpMtfSignal] = {}
    rank = {"mtf_vol_pin_short": 3, "mtf_vol_pin_long": 3, "vp_cascade_long": 2, "vp_cascade_short": 2}
    for s in signals:
        prev = by.get(s.bar_index_15m)
        if prev is None or rank.get(s.kind, 0) > rank.get(prev.kind, 0):
            by[s.bar_index_15m] = s
    return sorted(by.values(), key=lambda x: x.bar_index_15m)


def _settle_one(sig: VpMtfSignal, df_15: pd.DataFrame) -> dict[str, Any] | None:
    i = sig.bar_index_15m
    if i + 1 >= len(df_15):
        return None
    entry_row = df_15.iloc[i + 1]
    entry = float(entry_row["open"])
    entry_ms = int(entry_row["open_time"])
    side = "short" if sig.side == "short" else "long"
    bars = _bars_for_settle(df_15)
    rec = settle_signal_batch(
        side=side,
        entry=entry,
        symbol=SYMBOL,
        signal_at_ms=entry_ms,
        bars=bars,
        plan=None,
        fee_pct_per_side=OI_BT_FEE_PCT,
        slippage_pct_per_side=OI_BT_SLIPPAGE_PCT,
    )
    return {
        "kind": sig.kind,
        "label": sig.label,
        "side": sig.side,
        "signal_ts_ms": sig.signal_ts_ms,
        "entry_ts_ms": entry_ms,
        "entry_price": entry,
        **{k: rec.get(k) for k in ("outcome", "movePct", "pnlPct", "exitPrice", "stepPct")},
    }


def _bucket_stats(trades: list[dict[str, Any]]) -> dict[str, Any]:
    if not trades:
        return {"count": 0, "win_rate": None, "total_pnl_pct": None, "avg_move_pct": None}
    wins = [t for t in trades if (t.get("pnlPct") or 0) > 0]
    pnls = [float(t.get("pnlPct") or 0) for t in trades]
    return {
        "count": len(trades),
        "win_rate": round(len(wins) / len(trades), 4),
        "total_pnl_pct": round(sum(pnls), 2),
        "avg_move_pct": round(sum(float(t.get("movePct") or 0) for t in trades) / len(trades), 4),
    }


def main() -> int:
    store = BacktestKlineStore(root=resolve_klines_root())
    lo_15, hi_15 = kline_window_ms("15m", START_MS, END_MS)
    lo_1h, hi_1h = kline_window_ms("1h", START_MS, END_MS)
    rows_15 = store.load_rows(SYMBOL, "15m", lo_15, hi_15)
    rows_1h = store.load_rows(SYMBOL, "1h", lo_1h, hi_1h)
    if len(rows_15) < 500 or len(rows_1h) < 200:
        print(
            f"本地 K 线不足: 15m={len(rows_15)} 1h={len(rows_1h)}，请先跑 backtest_prefetch / run_structure_mtf 补齐",
            file=sys.stderr,
        )
        return 2

    df_15 = _rows_to_df(rows_15)
    df_1h = _rows_to_df(rows_1h)
    all_signals = scan_all_vp_mtf(df_15, df_1h)
    in_window = [s for s in all_signals if START_MS <= s.signal_ts_ms <= END_MS]

    bundles = {
        "cascade_long_1h跌15m入": _filter_kind(in_window, {"vp_cascade_long"}),
        "mtf_vol_pin_short": _filter_kind(in_window, {"mtf_vol_pin_short"}),
        "mtf_vol_pin_long": _filter_kind(in_window, {"mtf_vol_pin_long"}),
        "cascade_short_1h涨15m入": _filter_kind(in_window, {"vp_cascade_short"}),
    }

    OUT.mkdir(parents=True, exist_ok=True)
    summary: dict[str, Any] = {
        "symbol": SYMBOL,
        "window": {"start": START.isoformat(), "end": END.isoformat()},
        "settle": "V1 fixed % (pattern_settle, plan=None)",
        "fee_pct_per_side": OI_BT_FEE_PCT,
        "slippage_pct_per_side": OI_BT_SLIPPAGE_PCT,
        "bundles": {},
        "all_signals_in_window": len(in_window),
    }
    all_trades: list[dict[str, Any]] = []

    for name, sigs in bundles.items():
        trades = [t for s in sigs if (t := _settle_one(s, df_15)) is not None]
        summary["bundles"][name] = {**_bucket_stats(trades), "signals": len(sigs)}
        for t in trades:
            t["bundle"] = name
        all_trades.extend(trades)
        (OUT / f"trades_{name}.json").write_text(
            json.dumps(trades, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    summary["combined"] = _bucket_stats(all_trades)
    summary["by_kind"] = {
        k: _bucket_stats([t for t in all_trades if t["kind"] == k])
        for k in sorted({t["kind"] for t in all_trades})
    }
    (OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())