"""从 pattern_alert_stats 拟合共振分权重并写入 data/confluence_weights.json。"""
from __future__ import annotations

import argparse
import json
import logging
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from oi_mornitor.confluence_features import extract_confluence_features
from oi_mornitor.env_parse import env_int, env_str
from oi_mornitor.mcap_tier import attach_mcap_tier
from oi_mornitor.pattern_alert_stats import _STATS_FILE, _load
from oi_mornitor.pattern_mtf_resonance import attach_mtf_resonance
from oi_mornitor.signal_confluence import (
    DEFAULT_FEATURE_WEIGHTS,
    build_weights_payload,
    compute_quintile_table,
    compute_raw_score,
    default_weights_path,
    score_records,
)

logger = logging.getLogger(__name__)
_TZ_CN = timezone(timedelta(hours=8))


def _parse_split_ms(raw: str) -> int:
    s = str(raw or "").strip()
    if not s:
        return 0
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            dt = datetime.strptime(s, fmt).replace(tzinfo=_TZ_CN)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    try:
        return int(float(s))
    except ValueError:
        return 0


def compute_r_multiple(rec: dict[str, Any]) -> float | None:
    """R = movePct / SL距离%，裁剪到 [-3, 5]。"""
    oc = str(rec.get("outcome") or "pending")
    if oc in ("pending", "error", "flat"):
        return None
    if rec.get("observation_only") or "观察" in str(rec.get("typeLabel") or ""):
        return None
    sl = rec.get("slPrice")
    entry = rec.get("entry")
    move = rec.get("movePct")
    try:
        sl_f = float(sl)
        entry_f = float(entry)
        move_f = float(move)
    except (TypeError, ValueError):
        return None
    if entry_f <= 0 or sl_f <= 0:
        return None
    side = str(rec.get("side") or "").lower()
    is_short = side in ("short", "bear")
    sl_dist_pct = abs(entry_f - sl_f) / entry_f * 100.0
    if sl_dist_pct < 1e-6:
        return None
    r = move_f / sl_dist_pct
    if not math.isfinite(r):
        return None
    return max(-3.0, min(5.0, r))


def _eligible_records(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    attach_mtf_resonance(rows)
    attach_mcap_tier(rows)
    out: list[dict[str, Any]] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        if compute_r_multiple(r) is None:
            continue
        out.append(r)
    return out


def fit_shrunk_weights(
    train: list[dict[str, Any]],
    r_values: list[float],
    *,
    shrink_k: int,
    min_n: int,
) -> tuple[dict[str, float], dict[str, int]]:
    if not train:
        return dict(DEFAULT_FEATURE_WEIGHTS), {}
    base = sum(r_values) / len(r_values)
    feat_sums: dict[str, float] = {}
    feat_counts: dict[str, int] = {}
    for rec, rv in zip(train, r_values):
        for f in extract_confluence_features(rec):
            feat_sums[f] = feat_sums.get(f, 0.0) + rv
            feat_counts[f] = feat_counts.get(f, 0) + 1
    weights: dict[str, float] = {}
    kept_n: dict[str, int] = {}
    for f, n in feat_counts.items():
        if n < min_n:
            continue
        mean_f = feat_sums[f] / n
        delta = mean_f - base
        shrunk = delta * (n / (n + shrink_k))
        weights[f] = round(shrunk, 5)
        kept_n[f] = n
    if not weights:
        return dict(DEFAULT_FEATURE_WEIGHTS), {}
    return weights, kept_n


def _promote_guard(test_quintiles: list[dict[str, Any]]) -> bool:
    if len(test_quintiles) < 2:
        return False
    q1 = test_quintiles[0].get("expR")
    q5 = test_quintiles[-1].get("expR")
    try:
        return float(q5) > float(q1)
    except (TypeError, ValueError):
        return False


def run_calibration(
    *,
    stats_path: Path | None = None,
    out_path: Path | None = None,
    split_ms: int | None = None,
    shrink_k: int | None = None,
    min_n: int | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    stats_path = stats_path or _STATS_FILE
    out_path = out_path or default_weights_path()
    shrink_k = shrink_k if shrink_k is not None else env_int("OI_CONFLUENCE_SHRINK_K", 50, min_val=1)
    min_n = min_n if min_n is not None else env_int("OI_CONFLUENCE_MIN_N", 30, min_val=1)
    split_raw = env_str("OI_CONFLUENCE_SPLIT_AT", "2026-10-14 20:44")
    split_ms = split_ms if split_ms is not None else _parse_split_ms(split_raw)

    rows = json.loads(stats_path.read_text(encoding="utf-8")) if stats_path.is_file() else _load()
    if not isinstance(rows, list):
        rows = _load()
    eligible = _eligible_records(list(rows))
    train: list[dict[str, Any]] = []
    test: list[dict[str, Any]] = []
    train_r: list[float] = []
    test_r: list[float] = []
    for rec in eligible:
        rv = compute_r_multiple(rec)
        if rv is None:
            continue
        sat = int(rec.get("signalAt") or 0)
        if split_ms > 0 and sat >= split_ms:
            test.append(rec)
            test_r.append(rv)
        else:
            train.append(rec)
            train_r.append(rv)

    weights, feat_n = fit_shrunk_weights(train, train_r, shrink_k=shrink_k, min_n=min_n)
    train_scored = score_records(train, weights=weights)
    test_scored = score_records(test, weights=weights, percentile_from=train_scored)

    train_quintiles = compute_quintile_table(train_scored, train_r)
    test_quintiles = compute_quintile_table(test_scored, test_r)

    raw_train = [compute_raw_score(extract_confluence_features(r), weights) for r in train]
    payload = build_weights_payload(
        weights=weights,
        feature_n=feat_n,
        train_raw_scores=raw_train,
        train_quintiles=train_quintiles,
        test_quintiles=test_quintiles,
        split_ms=split_ms,
        shrink_k=shrink_k,
        min_n=min_n,
        train_count=len(train),
        test_count=len(test),
    )

    promote = _promote_guard(test_quintiles)
    payload["promoted"] = promote
    if promote and not dry_run:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        logger.info("已写入权重 %s（test Q5 expR > Q1）", out_path)
    elif not promote:
        logger.warning(
            "未晋升：test 顶分位 expR %.4f <= 底分位 %.4f，保留原文件",
            test_quintiles[-1].get("expR") if test_quintiles else float("nan"),
            test_quintiles[0].get("expR") if test_quintiles else float("nan"),
        )
    return payload


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
    p = argparse.ArgumentParser(description="拟合形态共振分权重（pattern_alert_stats → confluence_weights.json）")
    p.add_argument("--stats", type=Path, default=None, help="pattern_alert_stats.json 路径")
    p.add_argument("--out", type=Path, default=None, help="输出 confluence_weights.json")
    p.add_argument("--split-ms", type=int, default=None, help="训练/测试切分 signalAt(ms)")
    p.add_argument("--shrink-k", type=int, default=None)
    p.add_argument("--min-n", type=int, default=None)
    p.add_argument("--dry-run", action="store_true", help="不写文件")
    args = p.parse_args(argv)
    run_calibration(
        stats_path=args.stats,
        out_path=args.out,
        split_ms=args.split_ms,
        shrink_k=args.shrink_k,
        min_n=args.min_n,
        dry_run=args.dry_run,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
