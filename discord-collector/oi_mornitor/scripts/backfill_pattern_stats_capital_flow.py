#!/usr/bin/env python3
"""为胜率库历史信号补算 capitalFlow，便于「上下文」筛选（OI异动 / 清算触发）。

默认只处理尚无 capitalFlow 的记录；写回 pattern_alert_stats.json。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path

import aiohttp

_OI_ROOT = Path(__file__).resolve().parents[1]
_COLLECTOR = _OI_ROOT.parent
if str(_COLLECTOR) not in sys.path:
    sys.path.insert(0, str(_COLLECTOR))

from oi_mornitor.capital_flow_backtest import attach_capital_flow_to_backtest_items
from oi_mornitor.pattern_alert_stats import _load, _save
from oi_mornitor.pattern_context_filters import (
    is_oi_anomaly_context,
    is_post_liquidation_context,
)
from oi_mornitor.radar import get_service

logger = logging.getLogger(__name__)


def _filter_rows(
    rows: list[dict],
    *,
    time_ms: int | None,
    interval: str | None,
    only_missing: bool,
) -> list[dict]:
    now = int(time.time() * 1000)
    out: list[dict] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        sat = int(r.get("signalAt") or 0)
        if time_ms and sat < now - time_ms:
            continue
        if interval and str(r.get("interval") or "") != interval:
            continue
        if only_missing and isinstance(r.get("capitalFlow"), dict):
            continue
        sym = str(r.get("symbol") or r.get("tradeSymbol") or "").strip()
        if not sym or sat <= 0:
            continue
        out.append(r)
    return out


async def _run(args: argparse.Namespace) -> int:
    rows = _load()
    time_ms = None
    if args.months > 0:
        time_ms = args.months * 30 * 24 * 3600 * 1000
    targets = _filter_rows(
        rows,
        time_ms=time_ms,
        interval=args.interval,
        only_missing=not args.force,
    )
    before_oi = sum(1 for r in rows if is_oi_anomaly_context(r))
    before_liq = sum(1 for r in rows if is_post_liquidation_context(r))
    print(
        f"全库 {len(rows)} 条 · 待补算 {len(targets)} 条"
        f"（months={args.months} interval={args.interval or 'all'}）"
    )
    print(f"补算前上下文命中：OI异动 {before_oi} · 清算触发 {before_liq}")
    if args.dry_run:
        return 0
    if not targets:
        print("无需补算")
        return 0

    svc = get_service()
    session = await svc._ensure_session()
    base = svc.radar.base_url
    chunk = max(1, args.chunk)
    done = 0
    for i in range(0, len(targets), chunk):
        batch = targets[i : i + chunk]
        await attach_capital_flow_to_backtest_items(
            batch,
            session=session,
            base_url=base,
            concurrency=args.concurrency,
        )
        done += len(batch)
        print(f"已拉取 capitalFlow {done}/{len(targets)}", flush=True)

    key_to_cf = {r.get("key"): r.get("capitalFlow") for r in targets if r.get("key")}
    merged = []
    touched = 0
    for r in rows:
        if not isinstance(r, dict):
            continue
        k = r.get("key")
        if k in key_to_cf and key_to_cf[k]:
            nr = dict(r)
            nr["capitalFlow"] = key_to_cf[k]
            merged.append(nr)
            touched += 1
        else:
            merged.append(r)
    _save(merged)
    after_oi = sum(1 for r in merged if is_oi_anomaly_context(r))
    after_liq = sum(1 for r in merged if is_post_liquidation_context(r))
    print(f"写回 {touched} 条 capitalFlow")
    print(f"补算后上下文命中：OI异动 {after_oi} · 清算触发 {after_liq}")
    return 0


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser(description="Backfill capitalFlow on pattern_alert_stats")
    ap.add_argument("--months", type=int, default=6, help="仅近 N 个月信号")
    ap.add_argument("--interval", type=str, default="15m", help="周期；空串表示全部")
    ap.add_argument("--chunk", type=int, default=40)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="覆盖已有 capitalFlow")
    args = ap.parse_args()
    if args.interval == "":
        args.interval = None
    raise SystemExit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()