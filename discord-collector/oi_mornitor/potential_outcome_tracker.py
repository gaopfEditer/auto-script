"""潜力信号 · 默认 7 天跟踪窗、检查点与 JSON 持久化（与发现扫描解耦）。"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

from oi_mornitor.potential_model_eval import ModelResult
from oi_mornitor.potential_outcome_config import (
    POTENTIAL_OUTCOME_ENABLED,
    POTENTIAL_OUTCOME_HOURS,
    POTENTIAL_TRACK_CHECKPOINT_DAYS,
    POTENTIAL_TRACK_DECOUPLE_DISCOVERY,
    POTENTIAL_TRACK_DAYS,
)

logger = logging.getLogger("OI_Radar")

_LOCK = threading.RLock()
_FILE = Path(__file__).resolve().parent / "data" / "potential_outcomes.json"
_store: dict[str, dict[str, Any]] | None = None

SETTLE_WINDOW = "window_end"
SETTLE_12H = SETTLE_WINDOW  # 兼容旧 settle_reason
SETTLE_EXITING = "exiting"
SETTLE_DROPPED = "dropped"
SETTLE_RENEWED = "renewed"

_MS_PER_DAY = 24 * 3600 * 1000


def track_id(symbol: str, model_id: str, signal_time_ms: int) -> str:
    return f"{symbol.upper()}:{model_id}:{int(signal_time_ms)}"


def _checkpoint_keys() -> list[str]:
    return [f"d{int(d)}" for d in POTENTIAL_TRACK_CHECKPOINT_DAYS]


def _empty_checkpoints(signal_time_ms: int) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for d in POTENTIAL_TRACK_CHECKPOINT_DAYS:
        key = f"d{int(d)}"
        out[key] = {
            "day": int(d),
            "due_ms": int(signal_time_ms) + int(d) * _MS_PER_DAY,
            "status": "pending",
            "recorded_at_ms": None,
            "return_pct": None,
            "mfe_pct": None,
            "mae_pct": None,
        }
    return out


def _load() -> dict[str, dict[str, Any]]:
    global _store
    if _store is not None:
        return _store
    out: dict[str, dict[str, Any]] = {}
    if _FILE.is_file():
        try:
            raw = json.loads(_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                for k, v in raw.items():
                    if isinstance(v, dict):
                        out[str(k)] = v
        except Exception as exc:  # noqa: BLE001
            logger.warning("读取 potential_outcomes.json 失败: %s", exc)
    _store = out
    return out


def _save() -> None:
    if _store is None:
        return
    try:
        _FILE.parent.mkdir(parents=True, exist_ok=True)
        _FILE.write_text(
            json.dumps(_store, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("写入 potential_outcomes.json 失败: %s", exc)


def window_end_default_ms(signal_time_ms: int) -> int:
    return int(signal_time_ms) + int(POTENTIAL_OUTCOME_HOURS * 3600 * 1000)


def _snapshot_from_result(r: ModelResult) -> dict[str, Any]:
    metrics = r.metrics if isinstance(r.metrics, dict) else {}
    slim_metrics: dict[str, Any] = {}
    for k in (
        "oi_chg_pct",
        "fund_pctile",
        "vol_z",
        "atr_pctile",
        "vs_btc",
        "btc_regime",
    ):
        if k in metrics:
            slim_metrics[k] = metrics[k]
    return {
        "score": int(round(r.score)),
        "stage": r.stage,
        "direction": r.direction or "neutral",
        "tf": r.tf,
        "entry_hint": r.entry,
        "exit_hint": r.exit,
        "reasons": list(r.score_reasons)[:10] if r.score_reasons else ([r.entry] if r.entry else []),
        "metrics": slim_metrics,
    }


def register_model_signal(symbol: str, r: ModelResult) -> None:
    if not POTENTIAL_OUTCOME_ENABLED:
        return
    ms = r.signal_time_ms
    if ms is None:
        return
    sym = symbol.upper()
    tid = track_id(sym, r.model_id, int(ms))
    with _LOCK:
        db = _load()
        prev_open = [
            (k, v)
            for k, v in db.items()
            if v.get("status") == "pending"
            and str(v.get("symbol") or "").upper() == sym
            and str(v.get("model_id") or "") == r.model_id
            and int(v.get("signal_time_ms") or 0) != int(ms)
        ]
        for k, v in prev_open:
            v["status"] = "settled"
            v["settle_reason"] = SETTLE_RENEWED
            v["window_end_ms"] = int(time.time() * 1000)
            v["settled_at_ms"] = int(time.time() * 1000)
            v["note"] = "同模型出现新 K 线信号，旧窗口提前结案"

        if tid in db and db[tid].get("status") == "settled":
            return

        db[tid] = {
            "id": tid,
            "symbol": sym,
            "model_id": r.model_id,
            "model_label": r.label,
            "signal_time_ms": int(ms),
            "signal_tf": r.tf,
            "direction": r.direction or "long",
            "stage_at_register": r.stage,
            "track_days": POTENTIAL_TRACK_DAYS,
            "snapshot": _snapshot_from_result(r),
            "status": "pending",
            "settle_reason": None,
            "window_end_ms": window_end_default_ms(int(ms)),
            "registered_at": time.time(),
            "last_stage": r.stage,
            "entry_price": None,
            "max_profit_pct": None,
            "max_drawdown_pct": None,
            "end_pnl_pct": None,
            "checkpoints": _empty_checkpoints(int(ms)),
            "expectation": None,
            "settled_at_ms": None,
        }
        _save()


def sync_symbol_slot(symbol: str, slot: dict[str, ModelResult] | None) -> None:
    """扫描后同步阶段；解耦模式下不因衰竭/离池缩短观察窗。"""
    if not POTENTIAL_OUTCOME_ENABLED:
        return
    sym = symbol.upper()
    now_ms = int(time.time() * 1000)
    active_ids = set()
    with _LOCK:
        db = _load()
        if slot:
            for r in slot.values():
                if r.signal_time_ms is None:
                    continue
                active_ids.add(track_id(sym, r.model_id, int(r.signal_time_ms)))
                tid = track_id(sym, r.model_id, int(r.signal_time_ms))
                if tid in db and db[tid].get("status") == "pending":
                    db[tid]["last_stage"] = r.stage
                    if not POTENTIAL_TRACK_DECOUPLE_DISCOVERY:
                        if r.stage == "exiting":
                            db[tid]["window_end_ms"] = min(
                                int(db[tid].get("window_end_ms") or now_ms),
                                now_ms,
                            )
                            db[tid]["early_end"] = SETTLE_EXITING

        if not POTENTIAL_TRACK_DECOUPLE_DISCOVERY:
            for k, v in list(db.items()):
                if v.get("status") != "pending":
                    continue
                if str(v.get("symbol") or "").upper() != sym:
                    continue
                mid = str(v.get("model_id") or "")
                st_ms = int(v.get("signal_time_ms") or 0)
                cur_tid = track_id(sym, mid, st_ms)
                if cur_tid not in active_ids:
                    v["window_end_ms"] = min(int(v.get("window_end_ms") or now_ms), now_ms)
                    v["early_end"] = SETTLE_DROPPED
        _save()


def list_due_for_checkpoint(now_ms: int | None = None) -> list[tuple[str, str, dict[str, Any]]]:
    """返回 (track_id, checkpoint_key, track_row) 待写入检查点。"""
    now_ms = int(now_ms if now_ms is not None else time.time() * 1000)
    due: list[tuple[str, str, dict[str, Any]]] = []
    with _LOCK:
        db = _load()
        for tid, row in db.items():
            if row.get("status") != "pending":
                continue
            cps = row.get("checkpoints")
            if not isinstance(cps, dict):
                continue
            for key in _checkpoint_keys():
                cp = cps.get(key)
                if not isinstance(cp, dict):
                    continue
                if cp.get("status") != "pending":
                    continue
                due_ms = int(cp.get("due_ms") or 0)
                if due_ms <= now_ms:
                    due.append((tid, key, dict(row)))
        due.sort(key=lambda x: int(x[2].get("signal_time_ms") or 0))
        return due


def apply_checkpoint(tid: str, cp_key: str, result: dict[str, Any]) -> None:
    with _LOCK:
        db = _load()
        row = db.get(tid)
        if not row or row.get("status") != "pending":
            return
        cps = row.get("checkpoints")
        if not isinstance(cps, dict):
            return
        cp = cps.get(cp_key)
        if not isinstance(cp, dict):
            return
        cp["recorded_at_ms"] = int(time.time() * 1000)
        if result.get("ok"):
            cp["status"] = "done"
            cp["return_pct"] = result.get("end_pnl_pct")
            cp["mfe_pct"] = result.get("max_profit_pct")
            cp["mae_pct"] = result.get("max_drawdown_pct")
            if row.get("entry_price") is None and result.get("entry_price"):
                row["entry_price"] = result.get("entry_price")
        else:
            cp["status"] = "error"
            cp["error"] = str(result.get("error") or "eval_failed")
        _save()


def list_due_for_settlement(now_ms: int | None = None) -> list[dict[str, Any]]:
    now_ms = int(now_ms if now_ms is not None else time.time() * 1000)
    with _LOCK:
        db = _load()
        due: list[dict[str, Any]] = []
        for v in db.values():
            if v.get("status") != "pending":
                continue
            end_ms = int(v.get("window_end_ms") or 0)
            if end_ms <= now_ms:
                due.append(dict(v))
        due.sort(key=lambda x: int(x.get("window_end_ms") or 0))
        return due


def apply_settlement(tid: str, result: dict[str, Any], *, reason: str) -> None:
    from oi_mornitor.potential_outcome_expect import evaluate_track_expectation

    with _LOCK:
        db = _load()
        row = db.get(tid)
        if not row or row.get("status") != "pending":
            return
        row["status"] = "settled"
        row["settle_reason"] = reason
        row["settled_at_ms"] = int(time.time() * 1000)
        if result.get("ok"):
            row["entry_price"] = result.get("entry_price")
            row["max_profit_pct"] = result.get("max_profit_pct")
            row["max_drawdown_pct"] = result.get("max_drawdown_pct")
            row["end_pnl_pct"] = result.get("end_pnl_pct")
            row["bars"] = result.get("bars")
            row["expectation"] = evaluate_track_expectation(
                direction=str(row.get("direction") or "long"),
                end_pnl_pct=result.get("end_pnl_pct"),
                max_profit_pct=result.get("max_profit_pct"),
                max_drawdown_pct=result.get("max_drawdown_pct"),
            )
        else:
            row["error"] = str(result.get("error") or "eval_failed")
        _save()


def lookup_outcome(symbol: str, model_id: str, signal_time_ms: int | None) -> dict[str, Any] | None:
    if signal_time_ms is None:
        return None
    tid = track_id(symbol, model_id, int(signal_time_ms))
    with _LOCK:
        db = _load()
        row = db.get(tid)
        return dict(row) if row else None


def list_tracking_history(
    *,
    limit: int = 200,
    status: str | None = None,
) -> list[dict[str, Any]]:
    """供 API / 脚本查询的历史跟踪列表（新→旧）。"""
    with _LOCK:
        db = _load()
        rows = [dict(v) for v in db.values()]
    if status in ("pending", "settled"):
        rows = [r for r in rows if str(r.get("status")) == status]
    rows.sort(key=lambda x: int(x.get("signal_time_ms") or 0), reverse=True)
    return [_public_track(r) for r in rows[: max(1, limit)]]


def outcome_for_model_hit(hit: dict[str, Any]) -> dict[str, Any] | None:
    sym = str(hit.get("symbol") or hit.get("_symbol") or "")
    mid = str(hit.get("id") or "")
    ms = hit.get("signal_time_ms")
    if not sym or not mid:
        return None
    row = lookup_outcome(sym, mid, int(ms) if ms is not None else None)
    if not row:
        return None
    return _public_outcome(row)


def _window_label() -> str:
    if POTENTIAL_TRACK_DAYS >= 1 and abs(POTENTIAL_OUTCOME_HOURS - POTENTIAL_TRACK_DAYS * 24) < 0.01:
        d = int(POTENTIAL_TRACK_DAYS) if POTENTIAL_TRACK_DAYS == int(POTENTIAL_TRACK_DAYS) else POTENTIAL_TRACK_DAYS
        return f"满{d}天"
    return f"满{POTENTIAL_OUTCOME_HOURS:.0f}h"


def _public_checkpoints(row: dict[str, Any]) -> list[dict[str, Any]]:
    cps = row.get("checkpoints")
    if not isinstance(cps, dict):
        return []
    out: list[dict[str, Any]] = []
    for key in _checkpoint_keys():
        cp = cps.get(key)
        if isinstance(cp, dict):
            out.append(
                {
                    "key": key,
                    "day": cp.get("day"),
                    "status": cp.get("status"),
                    "due_ms": cp.get("due_ms"),
                    "return_pct": cp.get("return_pct"),
                    "mfe_pct": cp.get("mfe_pct"),
                    "mae_pct": cp.get("mae_pct"),
                }
            )
    return out


def _public_track(row: dict[str, Any]) -> dict[str, Any]:
    oc = _public_outcome(row)
    return {
        **oc,
        "id": row.get("id"),
        "symbol": row.get("symbol"),
        "model_id": row.get("model_id"),
        "model_label": row.get("model_label"),
        "signal_time_ms": row.get("signal_time_ms"),
        "signal_tf": row.get("signal_tf"),
        "direction": row.get("direction"),
        "snapshot": row.get("snapshot"),
        "track_days": row.get("track_days", POTENTIAL_TRACK_DAYS),
    }


def _public_outcome(row: dict[str, Any]) -> dict[str, Any]:
    reason = str(row.get("settle_reason") or row.get("early_end") or "")
    reason_label = {
        SETTLE_WINDOW: _window_label(),
        SETTLE_12H: _window_label(),
        SETTLE_EXITING: "信号衰竭",
        SETTLE_DROPPED: "离池/失效",
        SETTLE_RENEWED: "新信号覆盖",
    }.get(reason, reason or "观察中")
    status = str(row.get("status") or "pending")
    pending = status == "pending"
    end_ms = int(row.get("window_end_ms") or 0)
    now_ms = int(time.time() * 1000)
    exp = row.get("expectation") if isinstance(row.get("expectation"), dict) else None
    return {
        "status": status,
        "pending": pending,
        "settle_reason": reason if not pending else None,
        "settle_label": reason_label if not pending else None,
        "window_end_ms": end_ms,
        "track_days": row.get("track_days", POTENTIAL_TRACK_DAYS),
        "hours_left": max(0.0, (end_ms - now_ms) / 3600000.0) if pending else 0.0,
        "days_left": max(0.0, (end_ms - now_ms) / _MS_PER_DAY) if pending else 0.0,
        "max_profit_pct": row.get("max_profit_pct"),
        "max_drawdown_pct": row.get("max_drawdown_pct"),
        "end_pnl_pct": row.get("end_pnl_pct"),
        "entry_price": row.get("entry_price"),
        "settled_at_ms": row.get("settled_at_ms"),
        "checkpoints": _public_checkpoints(row),
        "expectation_met": exp.get("met") if exp else None,
        "expectation_label": exp.get("label") if exp else None,
    }
