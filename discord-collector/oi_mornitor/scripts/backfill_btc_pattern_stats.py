#!/usr/bin/env python3
"""近 6 个月 BTC 形态回灌：K 线 prefetch + 结构历史重放 → 胜率库（source=backfill_replay）。"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

_REPO = Path(__file__).resolve().parents[2]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

API_BASE_DEFAULT = "http://127.0.0.1:8765"
DAYS = 180
INTERVALS = ["15m", "1h", "5m"]


def _http_json(method: str, url: str, body: dict | None = None, timeout: float = 120.0) -> dict:
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def btc_stats_probe(api_base: str) -> dict[str, Any]:
    raw = _http_json(
        "GET",
        f"{api_base}/api/pattern-alert-stats?symbol=BTCUSDT&time=6m&pageSize=5000",
        timeout=60.0,
    )
    items = raw.get("items") or []
    sats = [int(x.get("signalAt") or 0) for x in items if x.get("signalAt")]
    tz = timezone(timedelta(hours=8))
    return {
        "total": int(raw.get("total") or len(items)),
        "min_signalAt": min(sats) if sats else None,
        "max_signalAt": max(sats) if sats else None,
        "min_cn": (
            datetime.fromtimestamp(min(sats) / 1000, tz).isoformat() if sats else None
        ),
        "max_cn": (
            datetime.fromtimestamp(max(sats) / 1000, tz).isoformat() if sats else None
        ),
    }


async def _run_prefetch(start_ms: int, end_ms: int, *, skip: bool) -> dict[str, Any]:
    if skip:
        return {"skipped": True}
    from oi_mornitor.backtest_prefetch import get_prefetch_job, start_kline_prefetch

    job = await start_kline_prefetch(
        {
            "startMs": start_ms,
            "endMs": end_ms,
            "chunkDays": 30,
            "symbolScope": "majors",
            "maxSymbols": 1,
            "intervals": INTERVALS,
        },
        get_pool_rows=lambda: [],
    )
    while job.status in ("pending", "running"):
        await asyncio.sleep(3)
        job = get_prefetch_job(job.id) or job
    return {"job_id": job.id, "status": job.status, "error": job.error, "progress": job.progress}


async def _run_structure_replay(start_ms: int, end_ms: int, *, api_base: str) -> dict[str, Any]:
    from oi_mornitor.pattern_alert_stats import alert_stats_key
    from oi_mornitor.pattern_emit_gate import passes_pattern_card_emit_gate
    from oi_mornitor.pattern_signal_time import resolve_signal_at_from_alert
    from oi_mornitor.pattern_alert_stats import record_alert_from_push
    from oi_mornitor.signal_confluence import attach_confluence_to_backtest_items
    from oi_mornitor.structure_backtest import (
        _backtest_item_to_alert,
        _filter_items_chronological_emit_gate,
        get_backtest_job,
        start_structure_backtest,
    )

    job = await start_structure_backtest(
        {
            "startMs": start_ms,
            "endMs": end_ms,
            "intervals": ["15m", "1h"],
            "symbolScope": "majors",
            "maxSymbols": 1,
            "skipFetch": True,
            "liveFunnel": True,
            "confluenceMinTier": "all",
        },
        get_pool_rows=lambda: [],
    )
    while True:
        j = get_backtest_job(job.id) or job
        if j.status in ("done", "failed"):
            job = j
            break
        await asyncio.sleep(5)
    if job.status != "done":
        return {"ok": False, "error": job.error or job.status, "job_id": job.id}

    items = _filter_items_chronological_emit_gate(list(job.items or []))
    attach_confluence_to_backtest_items(items)
    btc_items = [
        it
        for it in items
        if str(it.get("symbol") or "").upper().startswith("BTC")
    ]
    inserted = 0
    skipped = 0
    batch: list[dict[str, Any]] = []
    def _flush_batch() -> None:
        nonlocal batch
        if not batch:
            return
        _http_json(
            "POST",
            f"{api_base}/api/pattern-alert-stats",
            body={"updates": batch},
            timeout=120.0,
        )
        batch = []

    for it in sorted(btc_items, key=lambda x: int(x.get("signalAt") or 0)):
        alert = _backtest_item_to_alert(it)
        alert["scan_ts"] = float(int(it.get("signalAt") or 0)) / 1000.0
        if not passes_pattern_card_emit_gate(alert):
            skipped += 1
            continue
        if isinstance(it.get("confluence"), dict):
            alert["confluence"] = it["confluence"]
        rec = record_alert_from_push(alert)
        if rec is None:
            skipped += 1
            continue
        side = "long" if str(it.get("side") or "") in ("bull", "long") else "short"
        key = rec.get("key") or alert_stats_key(alert)
        row = {
            **rec,
            "key": key,
            "source": "backfill_replay",
            "outcome": it.get("outcome") or rec.get("outcome"),
            "movePct": it.get("movePct"),
            "pnlPct": it.get("pnlPct"),
            "exitPrice": it.get("exitPrice"),
            "slPrice": it.get("slPrice"),
            "tp1Price": it.get("tp1Price"),
            "side": rec.get("side") or side,
            "signalAt": int(rec.get("signalAt") or it.get("signalAt") or 0),
            "entry": rec.get("entry") or it.get("entry"),
        }
        if isinstance(it.get("confluence"), dict):
            row["confluence"] = it["confluence"]
        batch.append(row)
        inserted += 1
        if len(batch) >= 40:
            _flush_batch()
    _flush_batch()

    return {
        "ok": True,
        "job_id": job.id,
        "btc_hits": len(btc_items),
        "inserted_or_updated": inserted,
        "skipped_gate": skipped,
        "summary": job.summary,
    }


async def _async_main(args: argparse.Namespace) -> int:
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - int(args.days * 86400 * 1000)
    before = btc_stats_probe(args.api_base)
    print(json.dumps({"phase": "before", **before}, ensure_ascii=False), flush=True)

    pf = await _run_prefetch(start_ms, end_ms, skip=args.skip_prefetch)
    print(json.dumps({"phase": "prefetch", **pf}, ensure_ascii=False), flush=True)

    replay = await _run_structure_replay(start_ms, end_ms, api_base=args.api_base)
    print(json.dumps({"phase": "replay", **replay}, ensure_ascii=False), flush=True)

    if not args.skip_recalc:
        try:
            recalc = _http_json(
                "POST",
                f"{args.api_base}/api/pattern-alert-stats/recalculate-v2",
                body={},
                timeout=600.0,
            )
        except urllib.error.HTTPError as exc:
            recalc = {"ok": False, "error": str(exc)}
        print(json.dumps({"phase": "recalculate-v2", **recalc}, ensure_ascii=False), flush=True)

    after = btc_stats_probe(args.api_base)
    out = {"phase": "after", **after, "delta_total": after["total"] - before["total"]}
    print(json.dumps(out, ensure_ascii=False), flush=True)

    report_path = Path(args.report)
    if report_path:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(
                {
                    "before": before,
                    "after": after,
                    "prefetch": pf,
                    "replay": replay,
                    "window_days": args.days,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    return 0 if replay.get("ok") else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="BTC 6m pattern stats backfill")
    ap.add_argument("--api-base", default=API_BASE_DEFAULT)
    ap.add_argument("--days", type=int, default=DAYS)
    ap.add_argument("--skip-prefetch", action="store_true")
    ap.add_argument("--skip-recalc", action="store_true")
    ap.add_argument("--report", default="")
    args = ap.parse_args()
    return asyncio.run(_async_main(args))


if __name__ == "__main__":
    raise SystemExit(main())
