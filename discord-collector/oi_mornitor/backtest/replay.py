"""逐根回放：与实盘共用 collect_all_events。"""
from __future__ import annotations

import random
from typing import Any

import pandas as pd

from oi_mornitor.backtest.exits import ExitConfig, exit_config, simulate_trade
from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.strategy.features import add_core_features
from oi_mornitor.strategy.resonance import resonate
from oi_mornitor.strategy.scan_all import collect_all_events
from oi_mornitor.strategy.scoring import score_side

WARMUP = {"15m": 200, "1h": 180, "4h": 160, "1d": 80}


def _group_tag(ev: dict[str, Any]) -> str:
    tags = ev.get("tags") or {}
    if tags.get("near_vegas") or tags.get("oi_anomaly"):
        return "v_oi"
    return "plain"


def replay_symbol_tf(
    klines: list[list[Any]],
    *,
    symbol: str,
    tf: str,
    exchange: str = "binance_um",
    board: str = "none",
    seed: int = 7,
) -> dict[str, Any]:
    df = add_core_features(klines_to_df(klines))
    if df.empty or len(df) < WARMUP.get(tf, 80) + 20:
        return {"symbol": symbol, "tf": tf, "trades": [], "random_trades": [], "bar_scores": []}
    events = collect_all_events(df)
    bars = df.to_dict("records")
    cfg = exit_config(tf)
    trades: list[dict[str, Any]] = []
    by_bar: dict[int, list[dict[str, Any]]] = {}
    for ev in events:
        by_bar.setdefault(int(ev.get("bar_index") or -1), []).append(ev)

    warmup = WARMUP.get(tf, 80)
    bar_scores: list[dict[str, Any]] = []
    used_entry: set[tuple[str, int]] = set()
    for i in range(warmup, len(df) - 1):
        row = df.iloc[i]
        evs = [e for e in events if 0 <= i - int(e.get("bar_index") or -1) <= 4]
        long_s = score_side(evs, side="long", tf=tf, row=row, board=board, asof_idx=i)
        short_s = score_side(evs, side="short", tf=tf, row=row, board=board, asof_idx=i)
        bar_scores.append(
            {
                "bar_index": i,
                "long": long_s["score"],
                "short": short_s["score"],
                "open_time": int(row.get("open_time") or 0),
            }
        )
        for ev in by_bar.get(i, []):
            side = ev.get("side")
            if side not in ("long", "short"):
                continue
            key = (str(ev.get("kind")), i)
            if key in used_entry:
                continue
            used_entry.add(key)
            atr = float(row["atr14"]) if pd.notna(row.get("atr14")) else 0.0
            sim = simulate_trade(bars, side=side, entry_idx=i, atr=atr, symbol=symbol, tf=tf, cfg=cfg)
            trades.append(
                {
                    **sim,
                    "symbol": symbol,
                    "tf": tf,
                    "exchange": exchange,
                    "kind": ev.get("kind"),
                    "family": ev.get("family"),
                    "side": side,
                    "group_tag": _group_tag(ev),
                    "bar_index": i,
                    "bar_close_ts": ev.get("bar_close_ts"),
                    "score_tf": long_s["score"] if side == "long" else short_s["score"],
                }
            )

    n_rand = len(trades)
    rng = random.Random(seed)
    candidates = list(range(warmup, len(df) - 1))
    random_trades: list[dict[str, Any]] = []
    if candidates and n_rand:
        picks = [rng.choice(candidates) for _ in range(n_rand)]
        for i, tr in zip(picks, trades, strict=False):
            row = df.iloc[i]
            atr = float(row["atr14"]) if pd.notna(row.get("atr14")) else 0.0
            sim = simulate_trade(
                bars, side=tr["side"], entry_idx=i, atr=atr, symbol=symbol, tf=tf, cfg=cfg
            )
            random_trades.append(
                {
                    **sim,
                    "symbol": symbol,
                    "tf": tf,
                    "kind": "random",
                    "family": "random",
                    "side": tr["side"],
                    "group_tag": "random",
                    "bar_index": i,
                }
            )
    return {
        "symbol": symbol,
        "tf": tf,
        "exchange": exchange,
        "trades": trades,
        "random_trades": random_trades,
        "bar_scores": bar_scores,
        "event_count": len(events),
    }


def resonate_from_scores(
    by_tf: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """按 15m 时间轴对齐各周期最近已收盘分数。"""
    s15 = by_tf.get("15m") or []
    if not s15:
        return []
    others = {tf: list(rows) for tf, rows in by_tf.items() if tf != "15m"}
    out: list[dict[str, Any]] = []
    cursors = {tf: 0 for tf in others}
    for row in s15:
        ts = int(row.get("open_time") or 0)
        snap: dict[str, dict[str, float]] = {
            "15m": {"long": float(row["long"]), "short": float(row["short"])},
        }
        for tf, rows in others.items():
            idx = cursors[tf]
            while idx + 1 < len(rows) and int(rows[idx + 1].get("open_time") or 0) <= ts:
                idx += 1
            cursors[tf] = idx
            if rows and int(rows[idx].get("open_time") or 0) <= ts:
                snap[tf] = {"long": float(rows[idx]["long"]), "short": float(rows[idx]["short"])}
        for side in ("long", "short"):
            out.append({"ts": ts, **resonate(snap, side=side)})
    return out
