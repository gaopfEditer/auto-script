#!/usr/bin/env python3
"""对比结构回测 job 与 pattern_alert_stats.json 重叠窗口的一致率。"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from oi_mornitor.pattern_alert_stats import alert_stats_key


def _load_stats(path: Path) -> list[dict[str, Any]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict) and "items" in raw:
        return list(raw["items"] or [])
    if isinstance(raw, list):
        return raw
    return []


def _load_job_items(job_dir: Path, job_id: str) -> list[dict[str, Any]]:
    p = job_dir / f"{job_id}.json"
    if not p.is_file():
        raise FileNotFoundError(p)
    data = json.loads(p.read_text(encoding="utf-8"))
    return list(data.get("items") or [])


def _item_key_from_backtest(it: dict[str, Any]) -> str:
    side = str(it.get("side") or "")
    if side == "bull":
        side = "long"
    elif side == "bear":
        side = "short"
    emit = str(it.get("emit") or "candle")
    typ = "candle_pattern_card" if emit == "candle" else "structure_pattern_card"
    kind = str(it.get("kind") or "")
    close_t = int(it.get("signalAt") or 0)
    return f"{typ}:{it.get('symbol')}:{close_t}:{kind}:{side}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stats", type=Path, required=True, help="pattern_alert_stats.json 路径")
    ap.add_argument("--job-id", required=True, help="structure_backtest job id")
    ap.add_argument("--job-dir", type=Path, default=None, help="默认 data/backtest_klines/structure_jobs")
    ap.add_argument("--start-ms", type=int, default=0)
    ap.add_argument("--end-ms", type=int, default=0)
    args = ap.parse_args()

    if not args.stats.is_file():
        print(f"stats 文件不存在: {args.stats}", file=sys.stderr)
        return 2

    from oi_mornitor.config import BACKTEST_KLINES_DIR

    job_dir = args.job_dir or (Path(BACKTEST_KLINES_DIR) / "structure_jobs")
    stats = _load_stats(args.stats)
    bt_items = _load_job_items(job_dir, args.job_id)

    def in_window(sa: int) -> bool:
        if args.start_ms and sa < args.start_ms:
            return False
        if args.end_ms and sa > args.end_ms:
            return False
        return True

    live = {
        str(r.get("key") or ""): r
        for r in stats
        if in_window(int(r.get("signalAt") or 0))
    }
    bt = {
        _item_key_from_backtest(it): it
        for it in bt_items
        if in_window(int(it.get("signalAt") or 0))
    }
    live_keys = set(live.keys())
    bt_keys = set(bt.keys())
    matched = live_keys & bt_keys
    signal_match = len(matched) / max(len(live_keys | bt_keys), 1)

    agree = 0
    for k in matched:
        lo = str(live[k].get("outcome") or "")
        bo = str(bt[k].get("outcome") or "")
        if lo == bo:
            agree += 1
    outcome_agree = agree / max(len(matched), 1)

    print(json.dumps(
        {
            "liveCount": len(live_keys),
            "backtestCount": len(bt_keys),
            "matchedKeys": len(matched),
            "signalMatchRate": round(signal_match, 4),
            "outcomeAgreement": round(outcome_agree, 4),
            "onlyLive": len(live_keys - bt_keys),
            "onlyBacktest": len(bt_keys - live_keys),
        },
        ensure_ascii=False,
        indent=2,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
