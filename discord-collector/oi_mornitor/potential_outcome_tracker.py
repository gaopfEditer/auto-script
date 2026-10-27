"""潜力信号 · 12h / 衰竭 窗口评判持久化。"""
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
)

logger = logging.getLogger("OI_Radar")

_LOCK = threading.RLock()
_FILE = Path(__file__).resolve().parent / "data" / "potential_outcomes.json"
_store: dict[str, dict[str, Any]] | None = None

SETTLE_12H = "12h"
SETTLE_EXITING = "exiting"
SETTLE_DROPPED = "dropped"
SETTLE_RENEWED = "renewed"


def track_id(symbol: str, model_id: str, signal_time_ms: int) -> str:
    return f"{symbol.upper()}:{model_id}:{int(signal_time_ms)}"


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
            "status": "pending",
            "settle_reason": None,
            "window_end_ms": window_end_default_ms(int(ms)),
            "registered_at": time.time(),
            "last_stage": r.stage,
            "entry_price": None,
            "max_profit_pct": None,
            "max_drawdown_pct": None,
            "end_pnl_pct": None,
            "settled_at_ms": None,
        }
        _save()


def sync_symbol_slot(symbol: str, slot: dict[str, ModelResult] | None) -> None:
    """扫描后：衰竭 / 离池 → 缩短观察窗。"""
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
                    if r.stage == "exiting":
                        db[tid]["window_end_ms"] = min(
                            int(db[tid].get("window_end_ms") or now_ms),
                            now_ms,
                        )
                        db[tid]["early_end"] = SETTLE_EXITING

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


def _public_outcome(row: dict[str, Any]) -> dict[str, Any]:
    reason = str(row.get("settle_reason") or row.get("early_end") or "")
    reason_label = {
        SETTLE_12H: "满12h",
        SETTLE_EXITING: "信号衰竭",
        SETTLE_DROPPED: "离池/失效",
        SETTLE_RENEWED: "新信号覆盖",
    }.get(reason, reason or "观察中")
    status = str(row.get("status") or "pending")
    pending = status == "pending"
    end_ms = int(row.get("window_end_ms") or 0)
    now_ms = int(time.time() * 1000)
    return {
        "status": status,
        "pending": pending,
        "settle_reason": reason if not pending else None,
        "settle_label": reason_label if not pending else None,
        "window_end_ms": end_ms,
        "hours_left": max(0.0, (end_ms - now_ms) / 3600000.0) if pending else 0.0,
        "max_profit_pct": row.get("max_profit_pct"),
        "max_drawdown_pct": row.get("max_drawdown_pct"),
        "end_pnl_pct": row.get("end_pnl_pct"),
        "entry_price": row.get("entry_price"),
        "settled_at_ms": row.get("settled_at_ms"),
    }
