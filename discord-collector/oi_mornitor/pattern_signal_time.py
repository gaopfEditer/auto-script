"""形态信号时间轴：K 线收盘 → 核实网格 signalAt（与 structure_backtest 一致）。"""
from __future__ import annotations

_5M_MS = 300_000


def align_signal_at_ms(close_time_ms: int) -> int:
    """收盘后对齐到下一根 5m open，与 live scan_ts + 5m 核实网格一致。"""
    if close_time_ms <= 0:
        return close_time_ms
    return ((close_time_ms // _5M_MS) + 1) * _5M_MS


def resolve_signal_at_from_alert(alert: dict) -> int:
    """优先 kline_close_time，对齐 5m；scan_ts 仅作元数据。"""
    raw = (
        alert.get("kline_close_time")
        or alert.get("time")
        or alert.get("kline_open_time")
    )
    if raw is None:
        return 0
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return 0
    if n <= 0:
        return 0
    if n < 1e12:
        n *= 1000
    return align_signal_at_ms(int(n))
