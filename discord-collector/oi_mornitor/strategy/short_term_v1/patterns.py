"""实验 A 底层：现有形态 + 均线 + Vegas。默认暂停的二次探底仍排除；射击之星默认纳入。"""
from __future__ import annotations

from typing import Any, Iterable

import pandas as pd

from oi_mornitor.pattern_pause import is_paused_kind, is_paused_label
from oi_mornitor.structure_backtest import DEFAULT_KINDS, KIND_OPTIONS


def default_pattern_kinds(*, include_paused: bool = False) -> list[str]:
    """默认交易集合：跟随 pattern_pause（二次探底默认排除，射击之星默认包含）。"""
    if include_paused:
        return [k["id"] for k in KIND_OPTIONS]
    return list(DEFAULT_KINDS)


def honor_pause(kind: str | None, label: str | None = None) -> bool:
    """True = 该形态当前被暂停，不得进入默认回测交易。"""
    if kind and is_paused_kind(str(kind)):
        return True
    if label and is_paused_label(str(label)):
        return True
    return False


def filter_paused_candidates(
    rows: Iterable[dict[str, Any]],
    *,
    exclude_paused: bool = True,
) -> list[dict[str, Any]]:
    if not exclude_paused:
        return list(rows)
    out: list[dict[str, Any]] = []
    for r in rows:
        kind = str(r.get("kind") or r.get("setup") or "")
        label = str(r.get("typeLabel") or r.get("type_label") or r.get("label") or "")
        if honor_pause(kind, label):
            continue
        out.append(r)
    return out


def try_collect_existing_patterns(
    df: pd.DataFrame,
    *,
    symbol: str,
    interval: str = "15m",
    kinds: list[str] | None = None,
    exclude_paused: bool = True,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """尽力调用现有结构/蜡烛检测。数据或依赖不足时返回空列表并记录原因，不抛给调用方。"""
    note: dict[str, Any] = {"source": "existing_patterns", "ok": False}
    want = set(kinds or default_pattern_kinds(include_paused=not exclude_paused))
    if exclude_paused:
        want = {k for k in want if not is_paused_kind(k)}
    if df is None or len(df) < 80:
        note["reason"] = "insufficient_bars"
        return [], note
    hits: list[dict[str, Any]] = []
    try:
        from oi_mornitor.pattern_detector import enrich_indicators
        from oi_mornitor.strategy.structure_signals import detect_structure_events

        work = enrich_indicators(df.copy())
        for ev in detect_structure_events(work) or []:
            kind = str(ev.get("kind") or "")
            if kind not in want:
                continue
            if exclude_paused and honor_pause(kind, ev.get("typeLabel") or ev.get("type_label")):
                continue
            ev = dict(ev)
            ev.setdefault("symbol", symbol)
            ev.setdefault("interval", interval)
            ev.setdefault("source", "structure")
            ev.setdefault("setup", kind)
            hits.append(ev)
        note["structure"] = len(hits)
    except Exception as exc:  # noqa: BLE001
        note["structure_error"] = str(exc)

    try:
        from oi_mornitor.pattern_detector import enrich_indicators
        from oi_mornitor.strategy.candle_signals import collect_candle_signal_markers

        work = df if "ema20" in df.columns or "ma20" in getattr(df, "columns", []) else enrich_indicators(df.copy())
        markers = collect_candle_signal_markers(work) or []
        candle_n = 0
        for m in markers:
            kind = str(m.get("kind") or m.get("card_kind") or m.get("id") or "")
            label = str(m.get("label") or m.get("typeLabel") or "")
            if kind and kind not in want:
                # 有的标记用中文标签
                if kind not in ("shooting_star", "consecutive_flat_shooting_star") and "射击" not in label:
                    continue
            if exclude_paused and honor_pause(kind, label):
                continue
            if kind and kind not in want and "射击" not in label:
                continue
            row = dict(m)
            row.setdefault("symbol", symbol)
            row.setdefault("interval", interval)
            row.setdefault("kind", kind)
            row.setdefault("setup", kind or "vegas_candle")
            row.setdefault("source", "candle_vegas")
            hits.append(row)
            candle_n += 1
        note["candle"] = candle_n
    except Exception as exc:  # noqa: BLE001
        note["candle_error"] = str(exc)

    note["ok"] = True
    note["n"] = len(hits)
    return hits, note
