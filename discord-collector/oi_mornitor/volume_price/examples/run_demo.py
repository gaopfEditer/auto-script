#!/usr/bin/env python3
"""命令行最小演示：量价信号 + 回测。"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from oi_mornitor.volume_price import generate_signals, load_klines, run_volume_price_backtest


def _synthetic_h1(raw: pd.DataFrame) -> pd.DataFrame:
    h1 = (
        raw.assign(bucket=raw["ts"] // 3_600_000)
        .groupby("bucket", as_index=False)
        .agg(
            ts=("bucket", "first"),
            symbol=("symbol", "first"),
            open=("open", "first"),
            high=("high", "max"),
            low=("low", "min"),
            close=("close", "last"),
            volume=("volume", "sum"),
        )
    )
    h1["tf"] = "1h"
    h1["ts"] = h1["bucket"] * 3_600_000
    return h1.drop(columns=["bucket"])


def main() -> None:
    csv_path = Path(__file__).with_name("sample_klines.csv")
    raw = load_klines(csv_path)
    full = pd.concat([raw, _synthetic_h1(raw)], ignore_index=True)
    signals, enriched = generate_signals(full, signal_tfs=("15m",))
    report = run_volume_price_backtest(enriched, signals)
    print(f"bars={len(enriched)} signals={len(signals)} trades={len(report.trades)}")
    print(report.to_dict())


if __name__ == "__main__":
    main()
