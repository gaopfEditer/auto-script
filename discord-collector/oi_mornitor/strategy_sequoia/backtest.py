"""Sequoia 历史回测：扫信号 + 可选写入胜率库形状 + 简易胜率。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from oi_mornitor.backtest.strategies import CostDefenseTrailingManager, RiskConfig
from oi_mornitor.strategy_sequoia.bridge import hit_to_alert
from oi_mornitor.strategy_sequoia.registry import resolve_strategy_ids
from oi_mornitor.strategy_sequoia.strategies import detect_all


@dataclass
class SequoiaBacktestResult:
    symbol: str
    interval: str
    bars: int
    signals: int
    by_strategy: dict[str, int] = field(default_factory=dict)
    trades: list[dict[str, Any]] = field(default_factory=list)
    win_rate: float = 0.0
    avg_pnl_pct: float = 0.0
    total_pnl_pct: float = 0.0
    max_drawdown_pct: float = 0.0
    alerts: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "interval": self.interval,
            "bars": self.bars,
            "signals": self.signals,
            "by_strategy": self.by_strategy,
            "trade_count": len(self.trades),
            "win_rate": round(self.win_rate, 2),
            "avg_pnl_pct": round(self.avg_pnl_pct, 3),
            "total_pnl_pct": round(self.total_pnl_pct, 3),
            "max_drawdown_pct": round(self.max_drawdown_pct, 3),
            "trades": self.trades,
            "alert_count": len(self.alerts),
        }


def run_sequoia_backtest(
    df: pd.DataFrame,
    *,
    symbol: str = "SYMBOL",
    interval: str = "1h",
    strategy_ids: tuple[str, ...] | list[str] | None = None,
    risk: RiskConfig | None = None,
    warmup: int = 60,
    collect_alerts: bool = True,
    filter_profile: Any = None,
    htf_df: pd.DataFrame | None = None,
) -> SequoiaBacktestResult:
    """
    全历史 detect_all → 下一根开盘入场 → 成本防守止损。
    同一根 K 多策略命中时取第一条（按 registry 顺序）。
    filter_profile：可选 filtered/leaders_htf 档案（HTF/冷却/缩量）。
    """
    if df is None or df.empty:
        return SequoiaBacktestResult(symbol=symbol, interval=interval, bars=0, signals=0)
    work = df.reset_index(drop=True)
    n = len(work)
    ids = resolve_strategy_ids(strategy_ids)
    hits = detect_all(work, strategy_ids=ids)
    if filter_profile is not None and getattr(filter_profile, "name", "baseline") != "baseline":
        from oi_mornitor.strategy_sequoia.filters import apply_signal_filters, build_htf_trend_ok

        htf_trend = None
        if getattr(filter_profile, "htf_confirm", False) and htf_df is not None and not htf_df.empty:
            htf_trend = build_htf_trend_ok(htf_df, ma=int(getattr(filter_profile, "htf_ma", 20)))
        hits = apply_signal_filters(
            hits, work, profile=filter_profile, htf_trend=htf_trend, symbol=symbol
        )
    by_bar: dict[int, list[dict[str, Any]]] = {}
    by_strategy: dict[str, int] = {sid: 0 for sid in ids}
    for h in hits:
        bi = int(h.get("bar_index") or -1)
        if bi < warmup or bi >= n - 1:
            continue
        sid = str(h.get("strategy_id") or "")
        by_strategy[sid] = by_strategy.get(sid, 0) + 1
        by_bar.setdefault(bi, []).append(h)

    # 重放：信号日收盘后挂单，次日开盘入场
    mgr = CostDefenseTrailingManager(risk)
    pending = None
    signals = 0
    alerts: list[dict[str, Any]] = []
    for i in range(warmup, n):
        row = work.iloc[i]
        high = float(row["high"])
        low = float(row["low"])
        close = float(row["close"])
        open_px = float(row["open"])

        if mgr.in_position:
            mgr.update_bar(high=high, low=low, close=close, bar_index=i)

        if pending and not mgr.in_position:
            side, sig_type = pending
            mgr.open(side, open_px, i, signal_type=sig_type)
            pending = None

        if i in by_bar and not mgr.in_position and pending is None:
            hit = by_bar[i][0]
            side = "long" if str(hit.get("side")) in ("long", "bull") else "short"
            pending = (side, str(hit.get("strategy_id") or hit.get("kind") or ""))
            signals += 1
            if collect_alerts:
                alerts.append(
                    hit_to_alert(
                        hit,
                        symbol=symbol,
                        interval=interval,
                        source="sequoia_backtest",
                    )
                )

    trades = [
        {
            "side": t.side,
            "entry_bar": t.entry_bar,
            "exit_bar": t.exit_bar,
            "entry_price": round(t.entry_price, 6),
            "exit_price": round(t.exit_price, 6),
            "pnl_pct": round(t.pnl_pct, 3),
            "reason": t.reason,
            "signal_type": t.signal_type,
        }
        for t in mgr.trades
    ]
    wins = sum(1 for t in mgr.trades if t.pnl_pct > 0)
    win_rate = wins / len(mgr.trades) * 100.0 if mgr.trades else 0.0
    avg_pnl = sum(t.pnl_pct for t in mgr.trades) / len(mgr.trades) if mgr.trades else 0.0
    total_pnl = sum(t.pnl_pct for t in mgr.trades)
    equity = 100.0
    peak = equity
    max_dd = 0.0
    for t in mgr.trades:
        equity *= 1.0 + t.pnl_pct / 100.0
        peak = max(peak, equity)
        dd = (peak - equity) / peak * 100.0 if peak > 0 else 0.0
        max_dd = max(max_dd, dd)
    return SequoiaBacktestResult(
        symbol=symbol,
        interval=interval,
        bars=n,
        signals=signals,
        by_strategy={k: v for k, v in by_strategy.items() if v},
        trades=trades,
        win_rate=win_rate,
        avg_pnl_pct=avg_pnl,
        total_pnl_pct=total_pnl,
        max_drawdown_pct=max_dd,
        alerts=alerts,
    )


def summarize_alerts_for_stats(alerts: list[dict[str, Any]]) -> dict[str, Any]:
    """按 typeLabel 汇总（未结算）；真正胜率仍走 pattern_settle / 列表核实。"""
    by_label: dict[str, int] = {}
    for a in alerts:
        lab = str(a.get("type_label") or a.get("sequoia_id") or "?")
        by_label[lab] = by_label.get(lab, 0) + 1
    return {"count": len(alerts), "by_type_label": by_label}
