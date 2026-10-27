#!/usr/bin/env python3
"""一次性合并形态胜率库中的双 key（message 型 vs kind:side canonical）。

用法（在 discord-collector 目录或设置 PYTHONPATH）:
  python -m oi_mornitor.scripts.merge_pattern_alert_stats_keys [--dry-run]

默认读写 config 中 PATTERN_STATE_DB 旁的 pattern_alert_stats.json。
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from typing import Any

from oi_mornitor.config import PATTERN_STATE_DB
from oi_mornitor.pattern_alert_stats import _STATS_FILE, _normalize  # noqa: PLC2701
from oi_mornitor.pattern_stats_admission import (
    canonical_stats_key_from_record,
    is_canonical_stats_key,
)

logger = logging.getLogger(__name__)


def _prefer_record(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    rank = {"pending": 0, "error": 1, "flat": 2, "stop_loss": 3, "take_profit": 4}
    oa = rank.get(str(a.get("outcome") or "pending"), 0)
    ob = rank.get(str(b.get("outcome") or "pending"), 0)
    primary, secondary = (a, b) if ob <= oa else (b, a)
    merged = {**secondary, **primary}
    for k in ("typeLabel", "interval", "tradeSymbol", "confluence", "invalid_level"):
        if not merged.get(k) and secondary.get(k):
            merged[k] = secondary[k]
    if is_canonical_stats_key(canonical_stats_key_from_record(merged)):
        merged["key"] = canonical_stats_key_from_record(merged)
    return merged


def merge_items(items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for rec in items:
        if not isinstance(rec, dict):
            continue
        canon = canonical_stats_key_from_record(rec)
        groups.setdefault(canon, []).append(rec)
    out: list[dict[str, Any]] = []
    merged_n = 0
    for canon, group in groups.items():
        if len(group) == 1:
            rec = dict(group[0])
            if rec.get("key") != canon:
                rec["key"] = canon
                merged_n += 1
            out.append(rec)
            continue
        merged = group[0]
        for other in group[1:]:
            merged = _prefer_record(merged, other)
            merged_n += 1
        merged["key"] = canon
        out.append(merged)
    return out, merged_n


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description="合并形态胜率库双 key 记录")
    parser.add_argument("--dry-run", action="store_true", help="只打印统计，不写盘")
    parser.add_argument(
        "--file",
        type=Path,
        default=_STATS_FILE,
        help=f"stats JSON（默认 {_STATS_FILE})",
    )
    args = parser.parse_args()
    path = args.file.resolve()
    if not path.is_file():
        logger.error("文件不存在: %s（state db: %s）", path, PATTERN_STATE_DB)
        return 1
    raw = json.loads(path.read_text(encoding="utf-8"))
    items = raw.get("items") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        logger.error("无效 JSON 结构")
        return 1
    before = len(items)
    merged, touches = merge_items(items)
    after = len(merged)
    logger.info("合并前 %d 条 → 合并后 %d 条（处理 %d 条重复/改 key）", before, after, touches)
    if args.dry_run:
        return 0
    cleaned = _normalize(merged)
    path.write_text(
        json.dumps({"items": cleaned}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    logger.info("已写入 %s", path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
