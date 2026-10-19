"""维加斯顺势回测：有量 / 无量子集对比。"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from typing import Any

import aiohttp
import pandas as pd

from oi_mornitor.backtest_metrics import summarize_backtest_extended
from oi_mornitor.backtest_trade_config import (
    OI_BT_BREAKEVEN_AFTER_TP1,
    OI_BT_FEE_PCT,
    OI_BT_SETTLE_FINE_BARS,
    OI_BT_SLIPPAGE_PCT,
)
from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.mcap_tier import resolve_mcap_tier
from oi_mornitor.pattern_entry import resolve_backtest_entry_price
from oi_mornitor.pattern_settle import klines_rows_to_bars, settle_signal_by_5m_bars
from oi_mornitor.range_reversal.data import fetch_perp_klines_range
from oi_mornitor.trendline.signals import enrich_trendline_indicators
from oi_mornitor.trendline.yahoo_data import fetch_yahoo_klines
from oi_mornitor.trendline_config import interval_bar_ms
from oi_mornitor.vegas_trend.detect import evaluate_vegas_trend_at_bar
from oi_mornitor.vegas_trend.settle import build_vegas_trend_plan
from oi_mornitor.vegas_trend.symbols import backtest_symbol_list_crypto
from oi_mornitor.vegas_trend_config import (
    VEGAS_TREND_BT_MONTHS,
    VEGAS_TREND_INTERVALS,
    VEGAS_TREND_QQQ_INTERVALS,
)

_QQQ = "QQQUSDT"
_QQQ_TICKER = "QQQ"


def _truncate_months(df: pd.DataFrame, months: int) -> pd.DataFrame:
    if df.empty:
        return df
    end_ms = int(df.iloc[-1]["open_time"])
    start_ms = end_ms - months * 30 * 86400 * 1000
    return df[df["open_time"].astype(int) >= start_ms].reset_index(drop=True)


def _bar_close_ms(row: pd.Series, interval: str) -> int:
    ct = row.get("close_time")
    if ct is not None and int(ct) > 0:
        return int(ct)
    return int(row["open_time"]) + interval_bar_ms(interval) - 1


def _index_after_ts(df: pd.DataFrame, ts_ms: int, interval: str) -> int:
    for i in range(len(df)):
        if _bar_close_ms(df.iloc[i], interval) >= ts_ms:
            return i
    return len(df) - 1


def _walk(df: pd.DataFrame, *, symbol: str, interval: str, asset_class: str) -> list[dict[str, Any]]:
    work = enrich_trendline_indicators(df)
    out: list[dict[str, Any]] = []
    warmup = 120
    next_free = warmup
    tier = resolve_mcap_tier(symbol)

    for idx in range(warmup, len(work) - 2):
        if idx < next_free:
            continue
        hit = evaluate_vegas_trend_at_bar(work, idx, symbol=symbol, interval=interval)
        if not hit:
            continue
        side = str(hit.get("trade_side") or "long")
        row = df.iloc[idx]
        next_open = float(df.iloc[idx + 1]["open"]) if idx + 1 < len(df) else None
        entry = resolve_backtest_entry_price(
            side=side,
            signal_bar_close=float(hit["entry"]),
            next_bar_open=next_open,
        )
        close_ms = _bar_close_ms(row, interval)
        plan = build_vegas_trend_plan({**hit, "entry": entry, "symbol": symbol})
        settle_end = close_ms + plan.verify_delay_ms
        entry_idx = idx + 1 if next_open is not None else idx
        settle_rows = []
        for j in range(entry_idx, len(df)):
            r = df.iloc[j]
            if _bar_close_ms(r, interval) > settle_end + interval_bar_ms(interval):
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
        settled = settle_signal_by_5m_bars(
            side=side,
            entry=entry,
            symbol=symbol,
            signal_at_ms=close_ms,
            bars_5m=klines_rows_to_bars(settle_rows),
            now_ms=settle_end,
            plan=plan,
            fine_bars=OI_BT_SETTLE_FINE_BARS,
            breakeven_after_tp1=OI_BT_BREAKEVEN_AFTER_TP1,
            fee_pct_per_side=OI_BT_FEE_PCT,
            slippage_pct_per_side=OI_BT_SLIPPAGE_PCT,
        )
        if str(settled.get("outcome") or "") in ("pending", "error"):
            continue
        hit_at = settled.get("hitAt")
        if hit_at is not None:
            next_free = max(next_free, _index_after_ts(df, int(hit_at), interval) + 1)
        else:
            next_free = idx + max(4, int(plan.verify_delay_ms / interval_bar_ms(interval)) + 1)

        vol_bucket = "with_volume" if hit.get("vol_ok") else "no_volume"
        out.append(
            {
                "symbol": symbol,
                "mcapTier": tier,
                "interval": interval,
                "side": side,
                "vol_bucket": vol_bucket,
                "assetClass": asset_class,
                "typeLabel": f"{hit.get('pattern')}:{side}:{vol_bucket}",
                "signalAt": close_ms,
                "entry": entry,
                "outcome": settled.get("outcome"),
                "movePct": settled.get("movePct"),
                "pnlPct": settled.get("pnlPct"),
                "netMovePct": settled.get("netMovePct"),
                "movePct": settled.get("movePct"),
                "slPrice": plan.sl_price,
                "sl_pct": hit.get("sl_pct"),
                "rr_planned": hit.get("rr_planned"),
            }
        )
    return out


def _summarize_groups(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    for it in items:
        key = (
            str(it.get("mcapTier") or "t3"),
            str(it.get("symbol") or ""),
            str(it.get("interval") or ""),
            str(it.get("side") or ""),
            str(it.get("vol_bucket") or ""),
        )
        groups.setdefault(key, []).append(it)
    rows: list[dict[str, Any]] = []
    for key, bucket in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        s = summarize_backtest_extended(bucket)
        sls = [float(x["sl_pct"]) for x in bucket if x.get("sl_pct") is not None]
        rrs = [float(x["rr_planned"]) for x in bucket if x.get("rr_planned") is not None]
        rows.append(
            {
                "mcapTier": key[0],
                "symbol": key[1],
                "interval": key[2],
                "side": key[3],
                "vol_bucket": key[4],
                "count": len(bucket),
                "winRate": s.get("winRate"),
                "expectancyR": s.get("expectancyR"),
                "maxConsecutiveLosses": s.get("maxConsecutiveLosses"),
                "maxDrawdownPct": s.get("maxDrawdownPct"),
                "avgSlPct": round(sum(sls) / len(sls), 4) if sls else None,
                "avgRrPlanned": round(sum(rrs) / len(rrs), 3) if rrs else None,
            }
        )
    return rows


async def run_backtest(
    months: int | None = None,
    *,
    symbols: list[str] | None = None,
    intervals: tuple[str, ...] | None = None,
    include_qqq: bool = True,
) -> dict[str, Any]:
    months = months or VEGAS_TREND_BT_MONTHS
    ivs = intervals or VEGAS_TREND_INTERVALS
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - months * 30 * 86400 * 1000
    all_items: list[dict[str, Any]] = []
    errors: list[str] = []

    async with aiohttp.ClientSession() as session:
        for sym in symbols or backtest_symbol_list_crypto():
            for iv in ivs:
                try:
                    rows, meta = await fetch_perp_klines_range(
                        session, sym, iv, start_ms=start_ms, end_ms=end_ms
                    )
                    if not rows:
                        errors.append(f"{sym} {iv}: {meta}")
                        continue
                    df = _truncate_months(klines_to_df(rows), months)
                    all_items.extend(_walk(df, symbol=sym, interval=iv, asset_class="crypto"))
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{sym} {iv}: {exc}")

        if include_qqq:
            for iv in VEGAS_TREND_QQQ_INTERVALS:
                try:
                    yiv = "1wk" if iv in ("1w", "1wk") else iv
                    rows, _ = await fetch_yahoo_klines(session, _QQQ_TICKER, yiv, raise_on_empty=True)
                    df = _truncate_months(klines_to_df(rows), months)
                    all_items.extend(
                        _walk(df, symbol=_QQQ, interval=yiv, asset_class="equity")
                    )
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"QQQ {iv}: {exc}")

    with_vol = [x for x in all_items if x.get("vol_bucket") == "with_volume"]
    no_vol = [x for x in all_items if x.get("vol_bucket") == "no_volume"]
    return {
        "summary_all": summarize_backtest_extended(all_items),
        "summary_with_volume": summarize_backtest_extended(with_vol),
        "summary_no_volume": summarize_backtest_extended(no_vol),
        "by_tier_interval_side_vol": _summarize_groups(all_items),
        "trade_count": len(all_items),
        "errors": errors,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="维加斯顺势回测")
    parser.add_argument("--months", type=int, default=VEGAS_TREND_BT_MONTHS)
    parser.add_argument("--symbol", default="")
    parser.add_argument("--interval", default="")
    parser.add_argument("--no-qqq", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    syms = [x.strip() for x in args.symbol.split(",") if x.strip()] or None
    ivs = tuple(x.strip() for x in args.interval.split(",") if x.strip()) or None
    report = asyncio.run(
        run_backtest(
            months=args.months,
            symbols=syms,
            intervals=ivs,
            include_qqq=not args.no_qqq,
        )
    )
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        for r in report.get("by_tier_interval_side_vol") or []:
            print(r)


if __name__ == "__main__":
    main()
