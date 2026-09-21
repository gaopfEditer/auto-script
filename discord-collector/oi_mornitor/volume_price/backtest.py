"""量价信号简易回测：下一根开盘成交，止损=invalid_level。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from oi_mornitor.volume_price.signals import VolumePriceSignal


@dataclass
class TradeRecord:
    symbol: str
    tf: str
    side: str
    kind: str
    bar_class: str
    entry_ts: int
    exit_ts: int
    entry_price: float
    exit_price: float
    invalid_level: float
    pnl_pct: float
    win: bool
    reason: str
    score: float


@dataclass
class BacktestReport:
    trades: list[TradeRecord] = field(default_factory=list)
    win_rate: float | None = None
    profit_factor: float | None = None
    max_drawdown_pct: float | None = None
    by_kind: dict[str, dict[str, Any]] = field(default_factory=dict)
    by_bar_class: dict[str, dict[str, Any]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "trade_count": len(self.trades),
            "win_rate": self.win_rate,
            "profit_factor": self.profit_factor,
            "max_drawdown_pct": self.max_drawdown_pct,
            "by_kind": self.by_kind,
            "by_bar_class": self.by_bar_class,
        }


def _simulate_trade(
    bars: pd.DataFrame,
    signal: VolumePriceSignal,
) -> TradeRecord | None:
    """信号在 bar i 收盘产生 → bar i+1 开盘入场；禁止同根 K 既算特征又开仓。"""
    idx = int(signal.signal_bar_index)
    if idx + 1 >= len(bars):
        return None

    entry_row = bars.iloc[idx + 1]
    entry_price = float(entry_row["open"])
    entry_ts = int(entry_row["ts"])
    side = signal.side
    invalid = float(signal.invalid_level)

    exit_price = entry_price
    exit_ts = entry_ts
    stopped = False

    for j in range(idx + 1, len(bars)):
        row = bars.iloc[j]
        hi = float(row["high"])
        lo = float(row["low"])
        exit_ts = int(row["ts"])

        if side == "long":
            if lo <= invalid:
                exit_price = invalid
                stopped = True
                break
        else:
            if hi >= invalid:
                exit_price = invalid
                stopped = True
                break
        exit_price = float(row["close"])

    if side == "long":
        pnl_pct = (exit_price - entry_price) / entry_price * 100
    else:
        pnl_pct = (entry_price - exit_price) / entry_price * 100

    return TradeRecord(
        symbol=signal.symbol,
        tf=signal.tf,
        side=side,
        kind=signal.kind,
        bar_class=signal.bar_class,
        entry_ts=entry_ts,
        exit_ts=exit_ts,
        entry_price=entry_price,
        exit_price=exit_price,
        invalid_level=invalid,
        pnl_pct=pnl_pct,
        win=pnl_pct > 0,
        reason=signal.reason,
        score=signal.score,
    )


def _summarize_bucket(trades: list[TradeRecord]) -> dict[str, Any]:
    if not trades:
        return {"count": 0, "win_rate": None, "avg_pnl_pct": None, "profit_factor": None}
    wins = [t for t in trades if t.win]
    losses = [t for t in trades if not t.win]
    gross_win = sum(t.pnl_pct for t in wins)
    gross_loss = abs(sum(t.pnl_pct for t in losses))
    pf = (gross_win / gross_loss) if gross_loss > 0 else None
    return {
        "count": len(trades),
        "win_rate": len(wins) / len(trades),
        "avg_pnl_pct": float(np.mean([t.pnl_pct for t in trades])),
        "profit_factor": pf,
    }


def _max_drawdown(equity: list[float]) -> float:
    if not equity:
        return 0.0
    peak = equity[0]
    max_dd = 0.0
    for x in equity:
        peak = max(peak, x)
        dd = (peak - x) / peak if peak > 0 else 0.0
        max_dd = max(max_dd, dd)
    return max_dd * 100


def run_volume_price_backtest(
    enriched_df: pd.DataFrame,
    signals: list[VolumePriceSignal],
    *,
    include_observation: bool = False,
) -> BacktestReport:
    """回测量价信号列表。"""
    tradable = [
        s for s in signals if include_observation or not s.observation_only
    ]
    records: list[TradeRecord] = []

    grouped: dict[tuple[str, str], pd.DataFrame] = {}
    for (sym, tf), chunk in enriched_df.groupby(["symbol", "tf"], sort=False):
        grouped[(str(sym), str(tf))] = chunk.reset_index(drop=True)

    for sig in tradable:
        key = (sig.symbol, sig.tf)
        bars = grouped.get(key)
        if bars is None or bars.empty:
            continue
        rec = _simulate_trade(bars, sig)
        if rec is not None:
            records.append(rec)

    report = BacktestReport(trades=records)
    if not records:
        return report

    wins = [t for t in records if t.win]
    losses = [t for t in records if not t.win]
    report.win_rate = len(wins) / len(records)
    gross_win = sum(t.pnl_pct for t in wins)
    gross_loss = abs(sum(t.pnl_pct for t in losses))
    report.profit_factor = (gross_win / gross_loss) if gross_loss > 0 else None

    equity = [100.0]
    for t in sorted(records, key=lambda x: x.entry_ts):
        equity.append(equity[-1] * (1 + t.pnl_pct / 100))
    report.max_drawdown_pct = _max_drawdown(equity)

    by_kind: dict[str, list[TradeRecord]] = {}
    by_class: dict[str, list[TradeRecord]] = {}
    for t in records:
        by_kind.setdefault(t.kind, []).append(t)
        by_class.setdefault(t.bar_class, []).append(t)
    report.by_kind = {k: _summarize_bucket(v) for k, v in by_kind.items()}
    report.by_bar_class = {k: _summarize_bucket(v) for k, v in by_class.items()}
    return report
