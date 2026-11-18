#!/usr/bin/env python3
"""ST 5m POP 实时监测：拉交易所 K 线、写 JSONL，默认观察窗 7 天。

数据目录：oi_mornitor/data/st_5m_pop_live/<campaign_id>/
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import aiohttp

_REPO = Path(__file__).resolve().parents[2]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from oi_mornitor.config import FAPI_BASE_URL
from oi_mornitor.pattern_monitor import fetch_pattern_klines_with_source
from oi_mornitor.strategy.st_5m_pop.signals import evaluate_last_closed_bar, klines_to_df
from oi_mornitor.strategy.st_5m_pop.storage import append_event, campaign_dir, load_state, save_state

logger = logging.getLogger("st_5m_pop_live")
TZ = ZoneInfo("Asia/Shanghai")
DEFAULT_SYMBOLS = ("BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT")
INTERVAL_MS_5M = 5 * 60 * 1000


def _parse_ts(s: str) -> int:
    return int(datetime.fromisoformat(s).timestamp() * 1000)


def _last_closed_open_time(now_ms: int) -> int:
    """当前周期内上一根已收盘 5m 的 open_time（ms）。"""
    return (now_ms // INTERVAL_MS_5M) * INTERVAL_MS_5M - INTERVAL_MS_5M


async def _fetch_df(
    session: aiohttp.ClientSession,
    symbol: str,
    interval: str,
    limit: int,
) -> tuple:
    rows, src = await fetch_pattern_klines_with_source(
        session,
        base_url=FAPI_BASE_URL,
        symbol=symbol,
        interval=interval,
        limit=limit,
    )
    df = klines_to_df(rows)
    if len(df) > 1:
        # 去掉未收盘（最后一根）
        now_ms = int(time.time() * 1000)
        last_open = int(df.iloc[-1]["open_time"])
        if last_open + INTERVAL_MS_5M > now_ms and interval == "5m":
            df = df.iloc[:-1].reset_index(drop=True)
        elif interval == "15m" and last_open + 15 * 60 * 1000 > now_ms:
            df = df.iloc[:-1].reset_index(drop=True)
        elif interval == "1h" and last_open + 3600 * 1000 > now_ms:
            df = df.iloc[:-1].reset_index(drop=True)
    return df, src


async def _poll_once(
    session: aiohttp.ClientSession,
    *,
    symbols: list[str],
    campaign_id: str,
    state: dict,
) -> None:
    for sym in symbols:
        try:
            df5, src5 = await _fetch_df(session, sym, "5m", 240)
            df15, src15 = await _fetch_df(session, sym, "15m", 120)
            df1h, src1h = await _fetch_df(session, sym, "1h", 100)
        except Exception as exc:
            logger.warning("%s fetch failed: %s", sym, exc)
            append_event(
                campaign_id,
                {"symbol": sym, "error": str(exc)},
                kind="fetch_error",
            )
            continue
        if len(df5) < 10:
            continue
        bar_ts = int(df5.iloc[-1]["open_time"])
        key = f"{sym}:{bar_ts}"
        prev = state.get("lastBar", {}).get(sym)
        if prev == bar_ts:
            continue
        ev = evaluate_last_closed_bar(df5, df15, df1h, symbol=sym)
        if ev is None:
            continue
        ev["klineSource"] = {"5m": src5, "15m": src15, "1h": src1h}
        ev["observedAt"] = datetime.now(TZ).isoformat(timespec="seconds")
        append_event(campaign_id, ev, kind="bar_eval")
        state.setdefault("lastBar", {})[sym] = bar_ts
        if ev.get("triggered"):
            append_event(campaign_id, ev, kind="signal")
            logger.info("SIGNAL %s score=%s session=%s", sym, ev["score"], ev["session"])
    save_state(campaign_id, state)


async def _run_loop(args: argparse.Namespace) -> None:
    end_ms = _parse_ts(args.end) if args.end else int((datetime.now(TZ) + timedelta(days=7)).timestamp() * 1000)
    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    meta = {
        "campaignId": args.campaign,
        "startedAt": datetime.now(TZ).isoformat(timespec="seconds"),
        "endAtMs": end_ms,
        "symbols": symbols,
        "strategy": "st_5m_pop_short_v0",
        "sessionAmpScope": "exit_only",
        "pollSec": args.interval,
    }
    d = campaign_dir(args.campaign)
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    state = load_state(args.campaign)
    logger.info("监测开始 %s → %s", meta["startedAt"], datetime.fromtimestamp(end_ms / 1000, TZ).isoformat())
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        while int(time.time() * 1000) < end_ms:
            await _poll_once(session, symbols=symbols, campaign_id=args.campaign, state=state)
            await asyncio.sleep(args.interval)
    append_event(args.campaign, {"endedAt": datetime.now(TZ).isoformat(timespec="seconds")}, kind="campaign_end")
    logger.info("监测结束（到达 end 时间）")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
    p = argparse.ArgumentParser(description="ST 5m POP 一周观察")
    p.add_argument("--campaign", default=os.environ.get("ST_POP_CAMPAIGN", "week_20261118"))
    p.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    p.add_argument("--interval", type=int, default=45, help="轮询秒数")
    p.add_argument(
        "--end",
        default="",
        help="ISO 结束时间（上海口径带 offset），默认 now+7d",
    )
    p.add_argument(
        "--end-ms",
        type=int,
        default=0,
        help="结束毫秒时间戳（优先于 --end）",
    )
    args = p.parse_args()
    if args.end_ms:
        args.end = datetime.fromtimestamp(args.end_ms / 1000, TZ).isoformat()
    asyncio.run(_run_loop(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())