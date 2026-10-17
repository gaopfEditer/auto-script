"""趋势线信号回测：滚动 500 窗口 · PR#9 结算口径 · 分组统计。"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from typing import Any

import aiohttp
import pandas as pd

from oi_mornitor.backtest_metrics import summarize_backtest_extended, summarize_by_dimensions
from oi_mornitor.backtest_trade_config import (
    OI_BT_BREAKEVEN_AFTER_TP1,
    OI_BT_FEE_PCT,
    OI_BT_SETTLE_FINE_BARS,
    OI_BT_SLIPPAGE_PCT,
)
from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.pattern_entry import resolve_backtest_entry_price
from oi_mornitor.pattern_settle import klines_rows_to_bars, settle_signal_by_5m_bars
from oi_mornitor.pattern_settle_profile import build_settle_plan, resolve_verify_delay_ms
from oi_mornitor.trendline.btc_data import fetch_btc_perp_klines_range
from oi_mornitor.trendline.signals import enrich_trendline_indicators, evaluate_bar_signal
from oi_mornitor.trendline.yahoo_data import fetch_yahoo_klines
from oi_mornitor.trendline_config import (
    TRENDLINE_BTC_SYMBOL,
    TRENDLINE_QQQ_TICKER,
    interval_bar_ms,
)


def _interval_ms(iv: str) -> int:
    return interval_bar_ms(iv)


def _truncate_df_by_months(df: pd.DataFrame, interval: str, months: int) -> pd.DataFrame:
    if df.empty or months <= 0:
        return df
    end_ms = int(df.iloc[-1]["open_time"])
    start_ms = end_ms - int(months * 30 * 86400 * 1000)
    return df[df["open_time"].astype(int) >= start_ms].reset_index(drop=True)


def _truncate_df_by_years(df: pd.DataFrame, years: int) -> pd.DataFrame:
    if df.empty or years <= 0:
        return df
    end_ms = int(df.iloc[-1]["open_time"])
    start_ms = end_ms - int(years * 365 * 86400 * 1000)
    return df[df["open_time"].astype(int) >= start_ms].reset_index(drop=True)


def _bar_close_ms(row: pd.Series, interval: str) -> int:
    ct = row.get("close_time")
    if ct is not None and int(ct) > 0:
        return int(ct)
    return int(row["open_time"]) + _interval_ms(interval) - 1


def _index_after_ts(df: pd.DataFrame, ts_ms: int, interval: str) -> int:
    for i in range(len(df)):
        if _bar_close_ms(df.iloc[i], interval) >= ts_ms:
            return i
    return len(df) - 1


def _walk(
    df: pd.DataFrame,
    *,
    asset: str,
    symbol: str,
    interval: str,
    label_prefix: str,
    require_ema: bool = False,
    asset_class: str = "crypto",
) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    warmup = 80
    next_free_idx = warmup
    indicators = enrich_trendline_indicators(df)

    for idx in range(warmup, len(df) - 2):
        if idx < next_free_idx:
            continue
        hit = evaluate_bar_signal(
            df,
            end_idx=idx,
            asset=asset,
            interval=interval,
            type_label_prefix=label_prefix,
            require_ema_confluence=require_ema,
            indicators_df=indicators,
        )
        if not hit:
            continue

        side = "long" if hit.get("side") == "bull" else "short"
        row = df.iloc[idx]
        next_open: float | None = None
        if idx + 1 < len(df):
            try:
                next_open = float(df.iloc[idx + 1]["open"])
            except (TypeError, ValueError, KeyError):
                next_open = None
        entry = resolve_backtest_entry_price(
            side=side,
            signal_bar_close=float(hit["entry"]),
            next_bar_open=next_open,
        )
        close_ms = _bar_close_ms(row, interval)
        signal_at_ms = close_ms

        settle_stub: dict[str, Any] = {
            "symbol": symbol,
            "tradeSymbol": symbol,
            "interval": interval,
            "side": side,
            "entry": entry,
            "invalid_level": hit.get("invalid_level"),
            "typeLabel": hit.get("type_label"),
            "type_label": hit.get("type_label"),
            "pattern": hit.get("pattern"),
            "assetClass": asset_class,
            "signalAt": signal_at_ms,
        }
        try:
            plan = build_settle_plan(settle_stub)
        except ValueError:
            continue

        verify_ms = resolve_verify_delay_ms(settle_stub)
        settle_end = signal_at_ms + verify_ms
        entry_idx = idx + 1 if next_open is not None else idx
        settle_rows: list[list[Any]] = []
        for j in range(entry_idx, len(df)):
            r = df.iloc[j]
            if _bar_close_ms(r, interval) > settle_end + _interval_ms(interval):
                break
            settle_rows.append(
                [
                    int(r["open_time"]),
                    float(r["open"]),
                    float(r["high"]),
                    float(r["low"]),
                    float(r["close"]),
                    float(r.get("volume") or 0),
                ]
            )
        bars = klines_rows_to_bars(settle_rows)
        settled = settle_signal_by_5m_bars(
            side=side,
            entry=entry,
            symbol=symbol,
            signal_at_ms=signal_at_ms,
            bars_5m=bars,
            now_ms=settle_end,
            alert_rec=settle_stub,
            fine_bars=OI_BT_SETTLE_FINE_BARS,
            breakeven_after_tp1=OI_BT_BREAKEVEN_AFTER_TP1,
            fee_pct_per_side=OI_BT_FEE_PCT,
            slippage_pct_per_side=OI_BT_SLIPPAGE_PCT,
        )
        if str(settled.get("outcome") or "") in ("pending", "error"):
            continue

        hit_at = settled.get("hitAt")
        if hit_at is not None:
            next_free_idx = max(next_free_idx, _index_after_ts(df, int(hit_at), interval) + 1)
        else:
            hold_bars = max(4, int(verify_ms / _interval_ms(interval)) + 1)
            next_free_idx = idx + hold_bars

        hits.append(
            {
                "symbol": asset,
                "tradeSymbol": symbol,
                "interval": interval,
                "side": side,
                "pattern": hit.get("pattern"),
                "typeLabel": f"{hit.get('pattern')}:{side}",
                "signalAt": signal_at_ms,
                "entry": entry,
                "outcome": settled.get("outcome"),
                "movePct": settled.get("movePct"),
                "netMovePct": settled.get("netMovePct"),
                "pnlPct": settled.get("pnlPct"),
                "slPrice": settled.get("slPrice") or plan.sl_price,
            }
        )
    return hits


async def _fetch_btc_df(interval: str, months: int) -> pd.DataFrame:
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - months * 30 * 86400 * 1000
    async with aiohttp.ClientSession() as session:
        rows, meta = await fetch_btc_perp_klines_range(
            session, interval, start_ms=start_ms, end_ms=end_ms
        )
    if not rows:
        raise RuntimeError(f"BTC K线拉取失败 interval={interval} meta={meta}")
    df = klines_to_df(rows)
    return _truncate_df_by_months(df, interval, months)


async def _fetch_qqq_df(interval: str, years: int) -> pd.DataFrame:
    iv = "1wk" if interval in ("1w", "1wk") else interval
    async with aiohttp.ClientSession() as session:
        rows, meta = await fetch_yahoo_klines(session, TRENDLINE_QQQ_TICKER, iv, raise_on_empty=True)
    df = klines_to_df(rows)
    return _truncate_df_by_years(df, years)


async def run_backtest(
    *,
    symbols: list[str],
    intervals: list[str],
    months: int,
    qqq_years: int = 2,
) -> dict[str, Any]:
    all_items: list[dict[str, Any]] = []
    errors: list[str] = []

    for sym in symbols:
        s = sym.strip().upper()
        if s in ("BTC", "BTCUSDT"):
            for iv in intervals:
                if iv not in ("15m", "1h", "4h"):
                    continue
                try:
                    df = await _fetch_btc_df(iv, months)
                    label = f"趋势线·BTC {iv}"
                    all_items.extend(
                        _walk(
                            df,
                            asset="BTC",
                            symbol=TRENDLINE_BTC_SYMBOL,
                            interval=iv,
                            label_prefix=label,
                            require_ema=False,
                        )
                    )
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"BTC {iv}: {exc}")
        elif s in ("QQQ", "QQQUSDT"):
            qqq_ivs = intervals or ["4h", "1d", "1w"]
            for iv in qqq_ivs:
                try:
                    df = await _fetch_qqq_df(iv, qqq_years)
                    norm_iv = "1wk" if iv in ("1w", "1wk") else iv
                    label = f"趋势线+EMA144·QQQ {norm_iv}"
                    all_items.extend(
                        _walk(
                            df,
                            asset="QQQ",
                            symbol="QQQUSDT",
                            interval=norm_iv,
                            label_prefix=label,
                            require_ema=norm_iv in ("4h", "1d", "1wk"),
                            asset_class="equity",
                        )
                    )
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"QQQ {iv}: {exc}")

    grouped = summarize_by_dimensions(
        all_items,
        key_fields=("symbol", "interval", "typeLabel"),
    )
    return {
        "summary": summarize_backtest_extended(all_items),
        "by_symbol_interval_pattern": grouped,
        "trade_count": len(all_items),
        "errors": errors,
    }


def _print_table(report: dict[str, Any]) -> None:
    rows = report.get("by_symbol_interval_pattern") or []
    print("symbol | interval | pattern×side | n | win_rate | expectancy_R | max_consec_loss | max_dd%")
    for r in rows:
        wr = r.get("winRate")
        exp = r.get("expectancyR")
        print(
            f"{r.get('symbol')} | {r.get('interval')} | {r.get('typeLabel')} | {r.get('count')} | "
            f"{wr if wr is not None else '—'} | {exp if exp is not None else '—'} | "
            f"{r.get('maxConsecutiveLosses', '—')} | {r.get('maxDrawdownPct', '—')}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="趋势线信号回测")
    parser.add_argument("--symbol", default="BTC,QQQ", help="逗号分隔：BTC,QQQ")
    parser.add_argument("--interval", default="15m,1h,4h,1d,1w", help="周期列表")
    parser.add_argument("--months", type=int, default=6, help="BTC 回看月数")
    parser.add_argument("--qqq-years", type=int, default=2, help="QQQ 回看年数")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    symbols = [x.strip() for x in args.symbol.split(",") if x.strip()]
    intervals = [x.strip() for x in args.interval.split(",") if x.strip()]
    report = asyncio.run(
        run_backtest(symbols=symbols, intervals=intervals, months=args.months, qqq_years=args.qqq_years)
    )
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        _print_table(report)
        if report.get("errors"):
            print("errors:", report["errors"])


if __name__ == "__main__":
    main()
