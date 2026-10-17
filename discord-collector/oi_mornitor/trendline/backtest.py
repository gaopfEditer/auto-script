"""趋势线信号简易回测（R 倍数 · 胜率 · 最大连亏）。"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any

import aiohttp
import pandas as pd

from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.trendline.btc_data import fetch_btc_perp_klines
from oi_mornitor.trendline.signals import evaluate_bar_signal
from oi_mornitor.trendline.yahoo_data import fetch_yahoo_klines
from oi_mornitor.exchange_sources import fetch_binance_klines_range, fetch_bybit_klines_range
from oi_mornitor.trendline_config import TRENDLINE_FAPI_BASE_URL, TRENDLINE_BTC_SYMBOL


@dataclass
class TradeResult:
    win: bool
    r_mult: float


def _simulate_trade(
    df: pd.DataFrame,
    entry_idx: int,
    *,
    side: str,
    entry: float,
    sl: float,
    tp1: float,
    max_bars: int = 48,
) -> TradeResult:
    risk = abs(entry - sl)
    if risk <= 0:
        return TradeResult(win=False, r_mult=0.0)
    for j in range(entry_idx + 1, min(len(df), entry_idx + 1 + max_bars)):
        row = df.iloc[j]
        h, l = float(row["high"]), float(row["low"])
        if side == "long":
            if l <= sl:
                return TradeResult(win=False, r_mult=-1.0)
            if h >= tp1:
                return TradeResult(win=True, r_mult=1.0)
        else:
            if h >= sl:
                return TradeResult(win=False, r_mult=-1.0)
            if l <= tp1:
                return TradeResult(win=True, r_mult=1.0)
    last = float(df.iloc[min(len(df) - 1, entry_idx + max_bars)]["close"])
    if side == "long":
        r = (last - entry) / risk
    else:
        r = (entry - last) / risk
    return TradeResult(win=r > 0, r_mult=r)


def _max_consecutive_losses(results: list[TradeResult]) -> int:
    streak = 0
    best = 0
    for t in results:
        if not t.win:
            streak += 1
            best = max(best, streak)
        else:
            streak = 0
    return best


def summarize(results: list[TradeResult]) -> dict[str, Any]:
    if not results:
        return {"count": 0, "win_rate": 0.0, "expectancy_r": 0.0, "max_consec_losses": 0}
    wins = sum(1 for t in results if t.win)
    exp = sum(t.r_mult for t in results) / len(results)
    return {
        "count": len(results),
        "win_rate": wins / len(results),
        "expectancy_r": exp,
        "max_consec_losses": _max_consecutive_losses(results),
    }


async def _fetch_btc_history(
    session: aiohttp.ClientSession,
    interval: str,
    months: int,
) -> pd.DataFrame:
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - months * 30 * 86400 * 1000
    rows = await fetch_binance_klines_range(
        session,
        base_url=TRENDLINE_FAPI_BASE_URL,
        symbol=TRENDLINE_BTC_SYMBOL,
        interval=interval,
        start_ms=start_ms,
        end_ms=end_ms,
    )
    if not rows:
        rows = await fetch_bybit_klines_range(
            session, symbol=TRENDLINE_BTC_SYMBOL, interval=interval, start_ms=start_ms, end_ms=end_ms
        )
    return klines_to_df(rows)


async def backtest_btc(interval: str, months: int) -> dict[str, Any]:
    async with aiohttp.ClientSession() as session:
        df = await _fetch_btc_history(session, interval, months)
    return _walk(df, asset="BTC", interval=interval, label_prefix=f"趋势线·BTC {interval}")


async def backtest_qqq(interval: str, years: int) -> dict[str, Any]:
    async with aiohttp.ClientSession() as session:
        iv = "1wk" if interval in ("1w", "1wk") else interval
        rows, _ = await fetch_yahoo_klines(session, "QQQ", iv)
    df = klines_to_df(rows)
    if years and len(df) > years * 52:
        df = df.iloc[-years * 52 :]
    return _walk(
        df,
        asset="QQQ",
        interval=iv,
        label_prefix=f"趋势线+EMA144·QQQ {iv}",
        require_ema=True,
    )


def _walk(
    df: pd.DataFrame,
    *,
    asset: str,
    interval: str,
    label_prefix: str,
    require_ema: bool = False,
) -> dict[str, Any]:
    results: list[TradeResult] = []
    warmup = 80
    for idx in range(warmup, len(df) - 2):
        hit = evaluate_bar_signal(
            df,
            end_idx=idx,
            asset=asset,
            interval=interval,
            type_label_prefix=label_prefix,
            require_ema_confluence=require_ema,
        )
        if not hit:
            continue
        side = "long" if hit.get("side") == "bull" else "short"
        tr = _simulate_trade(
            df,
            idx,
            side=side,
            entry=float(hit["entry"]),
            sl=float(hit["sl"]),
            tp1=float(hit["tp1"]),
        )
        results.append(tr)
    return summarize(results)


async def run_all() -> dict[str, Any]:
    out: dict[str, Any] = {}
    out["btc_15m_6m"] = await backtest_btc("15m", 6)
    out["btc_1h_6m"] = await backtest_btc("1h", 6)
    out["qqq_4h_2y"] = await backtest_qqq("4h", 2)
    out["qqq_1d_2y"] = await backtest_qqq("1d", 2)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="趋势线信号回测摘要")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = asyncio.run(run_all())
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for k, v in report.items():
            print(k, v)


if __name__ == "__main__":
    main()
