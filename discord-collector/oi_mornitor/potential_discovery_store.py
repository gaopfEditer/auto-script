"""潜力发现快照 + 快/慢扫合并 + potential.json。"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from oi_mornitor.potential_aggregate import aggregate_candidate, build_export_payload, should_export
from oi_mornitor.potential_discovery import catalog_payload
from oi_mornitor.potential_model_eval import MODEL_LABELS, ModelResult

_lock = threading.RLock()
_payload: dict[str, Any] = {}
_updated_at: float = 0.0
_fast_at: float = 0.0
_slow_at: float = 0.0

_symbol_models: dict[str, dict[str, ModelResult]] = {}
_symbol_meta: dict[str, dict[str, Any]] = {}

_POTENTIAL_JSON = Path(__file__).resolve().parent / "data" / "potential.json"


def _model_result_from_hit(hit: dict[str, Any]) -> ModelResult | None:
    mid = str(hit.get("id") or hit.get("model_id") or "").strip()
    if not mid:
        return None
    reasons = hit.get("reasons")
    entry = str(hit.get("entry") or "")
    if not entry and isinstance(reasons, list) and reasons:
        entry = str(reasons[0] or "")
    st_ms = hit.get("signal_time_ms")
    try:
        signal_time_ms = int(st_ms) if st_ms is not None else None
    except (TypeError, ValueError):
        signal_time_ms = None
    from oi_mornitor.potential_score_explain import finalize_model_result

    return finalize_model_result(
        ModelResult(
            model_id=mid,
            hit=True,
            score=float(hit.get("score") or 0),
            stage=str(hit.get("stage") or "watch"),
            entry=entry,
            exit=str(hit.get("exit") or ""),
            metrics=dict(hit.get("metrics") or {}) if isinstance(hit.get("metrics"), dict) else {},
            tf=str(hit.get("signal_tf") or hit.get("tf") or "1h"),
            signal_time_ms=signal_time_ms,
            hard_fail=bool(hit.get("hard_fail")),
            label=str(hit.get("label") or MODEL_LABELS.get(mid, mid)),
            end_signals=[str(x) for x in (hit.get("end_signals") or []) if x],
            direction=str(hit.get("direction") or "neutral"),
            score_reasons=[
                str(x) for x in (hit.get("score_reasons") or hit.get("reasons") or []) if x
            ],
        )
    )


def hydrate_discovery_from_disk(*, force: bool = False) -> bool:
    """进程启动时从 potential.json 恢复看板（collect:ui 重启 OI 后内存默认为空）。"""
    global _payload, _updated_at, _symbol_models, _symbol_meta, _fast_at, _slow_at
    if not force and _updated_at > 0:
        return False
    if not _POTENTIAL_JSON.is_file():
        return False
    try:
        raw = _POTENTIAL_JSON.read_text(encoding="utf-8")
        doc = json.loads(raw)
    except Exception:
        return False
    if not isinstance(doc, dict):
        return False
    cands = doc.get("candidates")
    if not isinstance(cands, list):
        cands = []

    models: dict[str, dict[str, ModelResult]] = {}
    meta: dict[str, dict[str, Any]] = {}
    for c in cands:
        if not isinstance(c, dict):
            continue
        sym = str(c.get("symbol") or "").upper()
        if not sym:
            continue
        hits = c.get("model_hits")
        if not isinstance(hits, list):
            hits = []
        slot: dict[str, ModelResult] = {}
        for h in hits:
            if not isinstance(h, dict):
                continue
            r = _model_result_from_hit(h)
            if r and not r.hard_fail:
                slot[r.model_id] = r
        if not slot:
            continue
        models[sym] = slot
        meta[sym] = {
            "symbol": sym,
            "mcap_usd": c.get("mcap_usd"),
            "mcap_tier": c.get("mcap_tier"),
            "notes": c.get("notes") or "",
        }

    with _lock:
        _symbol_models.clear()
        _symbol_models.update(models)
        _symbol_meta.clear()
        _symbol_meta.update(meta)
        if models:
            _flush_locked()
        else:
            _payload = dict(doc)
            try:
                _updated_at = _POTENTIAL_JSON.stat().st_mtime
            except OSError:
                _updated_at = time.time()
    return True


def merge_scan_results(
    *,
    model_ids: list[str],
    rows: list[tuple[str, dict[str, Any], list[ModelResult]]],
    fast_scan: bool = False,
    slow_scan: bool = False,
) -> None:
    """按 symbol 更新指定模型结果，并重建 export。"""
    global _fast_at, _slow_at
    now = time.time()
    with _lock:
        for sym, meta, results in rows:
            sym = sym.upper()
            slot = _symbol_models.setdefault(sym, {})
            for mid in model_ids:
                slot.pop(mid, None)
            from oi_mornitor.potential_discovery_config import POTENTIAL_SOFT_EXPORT_MIN

            for r in results:
                if r.model_id not in model_ids:
                    continue
                soft_ok = (
                    POTENTIAL_SOFT_EXPORT_MIN > 0
                    and float(r.score) >= float(POTENTIAL_SOFT_EXPORT_MIN)
                )
                if not r.hard_fail and (r.hit or soft_ok):
                    slot[r.model_id] = r
            if not slot:
                _symbol_models.pop(sym, None)
                _symbol_meta.pop(sym, None)
            else:
                prev = _symbol_meta.get(sym) or {}
                _symbol_meta[sym] = {**prev, **meta, "symbol": sym}
        if fast_scan:
            _fast_at = now
        if slow_scan:
            _slow_at = now
        _sync_potential_outcome_tracks(rows)
        _flush_locked()


def _sync_potential_outcome_tracks(
    rows: list[tuple[str, dict[str, Any], list[ModelResult]]],
) -> None:
    from oi_mornitor.potential_discovery_config import POTENTIAL_SOFT_EXPORT_MIN
    from oi_mornitor.potential_outcome_tracker import register_model_signal, sync_symbol_slot

    touched: set[str] = set()
    for sym, _meta, _results in rows:
        touched.add(sym.upper())
    for sym in touched:
        slot = _symbol_models.get(sym)
        sync_symbol_slot(sym, slot)
        if not slot:
            continue
        for r in slot.values():
            if r.hard_fail:
                continue
            soft_ok = POTENTIAL_SOFT_EXPORT_MIN > 0 and float(r.score) >= float(
                POTENTIAL_SOFT_EXPORT_MIN
            )
            if r.hit or soft_ok:
                register_model_signal(sym, r)


def _flush_locked() -> None:
    global _payload, _updated_at
    candidates: list[dict[str, Any]] = []
    for sym, slot in list(_symbol_models.items()):
        if not slot:
            continue
        meta = _symbol_meta.get(sym) or {}
        cand = aggregate_candidate(
            sym,
            list(slot.values()),
            mcap_usd=meta.get("mcap_usd"),
            mcap_tier=str(meta.get("mcap_tier") or "t3"),
            notes=str(meta.get("notes") or ""),
        )
        if cand and should_export(cand):
            candidates.append(cand)
        elif not slot:
            _symbol_models.pop(sym, None)
    doc = build_export_payload(candidates)
    doc["fast_scan_at_utc8"] = _ts_utc8(_fast_at) if _fast_at else None
    doc["slow_scan_at_utc8"] = _ts_utc8(_slow_at) if _slow_at else None
    _payload = doc
    _updated_at = time.time()
    try:
        _POTENTIAL_JSON.parent.mkdir(parents=True, exist_ok=True)
        _POTENTIAL_JSON.write_text(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except Exception:  # noqa: BLE001
        pass
    _maybe_publish_github(_POTENTIAL_JSON)


def _maybe_publish_github(local_path: Path) -> None:
    import os

    if os.environ.get("OI_POTENTIAL_GH_PUBLISH", "").strip().lower() not in (
        "1",
        "true",
        "yes",
        "on",
    ):
        return
    try:
        from oi_mornitor.potential_github_publish import publish_potential_json

        publish_potential_json(local_path, die_on_error=False)
    except Exception as exc:  # noqa: BLE001
        import logging

        logging.getLogger("OI_Radar").warning("potential.json GitHub 发布失败: %s", exc)


def _ts_utc8(ts: float) -> str:
    from datetime import datetime, timedelta, timezone

    tz = timezone(timedelta(hours=8))
    return datetime.fromtimestamp(ts, tz=tz).strftime("%Y-%m-%d %H:%M")


def update_discovery_snapshot(export_doc: dict[str, Any]) -> None:
    """全量覆盖（兼容旧调用）。"""
    global _payload, _updated_at, _symbol_models, _symbol_meta
    with _lock:
        _symbol_models.clear()
        _symbol_meta.clear()
        for c in export_doc.get("candidates") or []:
            sym = str(c.get("symbol") or "").upper()
            if not sym:
                continue
            _symbol_meta[sym] = {
                "mcap_usd": c.get("mcap_usd"),
                "mcap_tier": c.get("mcap_tier"),
                "notes": c.get("notes") or "",
            }
        _payload = dict(export_doc)
        _updated_at = time.time()


def _enrich_hit_signal(h: dict[str, Any]) -> dict[str, Any]:
    from oi_mornitor.potential_features import ms_to_utc8_str

    out = dict(h)
    if not out.get("signal_tf") and out.get("tf"):
        out["signal_tf"] = out["tf"]
    ms = out.get("signal_time_ms")
    if ms is not None and not out.get("signal_time_utc8"):
        try:
            out["signal_time_utc8"] = ms_to_utc8_str(int(ms))
        except (TypeError, ValueError):
            pass
    return out


def _attach_outcome(sym: str, hit: dict[str, Any]) -> dict[str, Any]:
    from oi_mornitor.potential_outcome_tracker import outcome_for_model_hit

    out = dict(hit)
    oc = outcome_for_model_hit({**out, "symbol": sym})
    if oc:
        out["outcome"] = oc
    return out


def _model_hits_for_candidate(c: dict[str, Any]) -> list[dict[str, Any]]:
    """优先内存中的 ModelResult（含 K 线时刻），否则用快照 model_hits。"""
    sym = str(c.get("symbol") or "").upper()
    slot = _symbol_models.get(sym)
    if slot:
        hits = [_enrich_hit_signal(r.to_hit_dict()) for r in slot.values()]
    else:
        raw = c.get("model_hits")
        if not isinstance(raw, list):
            hits = []
        else:
            hits = [_enrich_hit_signal(h) for h in raw if isinstance(h, dict)]
    return [_attach_outcome(sym, h) for h in hits]


def _resolve_item_signal_fields(
    c: dict[str, Any], models: list[dict[str, Any]]
) -> tuple[str | None, int | None, str | None]:
    from oi_mornitor.potential_features import ms_to_utc8_str

    tf = c.get("signal_tf") or c.get("tf")
    ms = c.get("signal_time_ms")
    utc8 = c.get("signal_time_utc8")
    top_id = str(c.get("top_model") or "")
    best: dict[str, Any] | None = None
    if models:
        if top_id:
            for m in models:
                if str(m.get("id") or "") == top_id:
                    best = m
                    break
        if best is None:
            best = max(models, key=lambda x: int(x.get("score") or 0))
    if best:
        tf = tf or best.get("signal_tf") or best.get("tf")
        if ms is None:
            ms = best.get("signal_time_ms")
        if not utc8:
            utc8 = best.get("signal_time_utc8")
    if ms is not None and not utc8:
        utc8 = ms_to_utc8_str(int(ms))
    try:
        ms_i = int(ms) if ms is not None else None
    except (TypeError, ValueError):
        ms_i = None
    return (str(tf) if tf else None, ms_i, str(utc8) if utc8 else None)


def get_discovery_payload() -> dict[str, Any]:
    if _updated_at <= 0:
        hydrate_discovery_from_disk()
    with _lock:
        doc = dict(_payload)
        cands = list(doc.get("candidates") or [])
        return {
            "ok": True,
            "updated_at": int(_updated_at) if _updated_at else None,
            "updated_utc8": doc.get("updated_utc8"),
            "fast_scan_at_utc8": doc.get("fast_scan_at_utc8"),
            "slow_scan_at_utc8": doc.get("slow_scan_at_utc8"),
            "refresh_hours": doc.get("refresh_hours"),
            "risk_hint": doc.get("risk_hint"),
            "source_note": doc.get("source_note"),
            "catalog": catalog_payload(),
            "items": [_candidate_to_item(c) for c in cands],
            "candidates": cands,
        }


def _candidate_to_item(c: dict[str, Any]) -> dict[str, Any]:
    models = _model_hits_for_candidate(c)
    signal_tf, signal_ms, signal_utc8 = _resolve_item_signal_fields(c, models)
    sym = str(c.get("symbol") or "").upper()
    top_id = str(c.get("top_model") or "")
    card_outcome = None
    for m in models:
        if top_id and str(m.get("id") or "") == top_id and m.get("outcome"):
            card_outcome = m.get("outcome")
            break
    if card_outcome is None:
        for m in sorted(models, key=lambda x: -int(x.get("score") or 0)):
            if m.get("outcome"):
                card_outcome = m.get("outcome")
                break
    score_f = float(c.get("score") or 0)
    explain_extra: dict[str, Any] = {}
    if not c.get("score_summary"):
        slot = _symbol_models.get(sym)
        if slot:
            from oi_mornitor.potential_discovery_config import POTENTIAL_SOFT_EXPORT_MIN
            from oi_mornitor.potential_score_explain import composite_score_breakdown

            soft_min = float(POTENTIAL_SOFT_EXPORT_MIN or 0)
            valid = [
                r
                for r in slot.values()
                if not r.hard_fail
                and (r.hit or (soft_min > 0 and float(r.score) >= soft_min))
            ]
            if valid:
                explain_extra = composite_score_breakdown(valid, score_f)
    return {
        "symbol": c.get("symbol"),
        "mcap_usd": c.get("mcap_usd"),
        "mcap_tier": c.get("mcap_tier"),
        "score": c.get("score"),
        "stage": c.get("stage"),
        "entry": c.get("entry"),
        "exit": c.get("exit"),
        "tf": c.get("tf") or signal_tf,
        "signal_tf": signal_tf,
        "signal_time_ms": signal_ms,
        "signal_time_utc8": signal_utc8,
        "scan_at_utc8": c.get("scan_at_utc8") or c.get("ts_utc8"),
        "direction": c.get("direction") or explain_extra.get("direction"),
        "direction_label": c.get("direction_label") or explain_extra.get("direction_label"),
        "score_summary": c.get("score_summary") or explain_extra.get("score_summary"),
        "score_reasons": c.get("score_reasons") or explain_extra.get("score_reasons") or [],
        "max_model_score": c.get("max_model_score") or explain_extra.get("max_model_score"),
        "resonance_bonus": c.get("resonance_bonus") if c.get("resonance_bonus") is not None else explain_extra.get("resonance_bonus"),
        "model_count": c.get("model_count") or explain_extra.get("model_count"),
        "outcome": card_outcome,
        "models": models,
        "top_model": c.get("top_model"),
        "metrics": c.get("metrics"),
        "notes": c.get("notes"),
    }


try:
    hydrate_discovery_from_disk()
except Exception:  # noqa: BLE001
    pass
