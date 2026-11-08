"""按 scan_ts 落盘 matrix / dormant-funnel，供 v3 回测读存档而非 rebuild。"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Iterator

logger = logging.getLogger("OI_Radar")

_ARCHIVE_ROOT = Path(__file__).resolve().parent / "data" / "scan_timeline"
_MATRIX_DIR = _ARCHIVE_ROOT / "matrix"
_DORMANT_DIR = _ARCHIVE_ROOT / "dormant-funnel"
_INDEX_PATH = _ARCHIVE_ROOT / "index.jsonl"

_lock = threading.Lock()
_last_radar_scan_ts: float = 0.0


def archive_root() -> Path:
    return _ARCHIVE_ROOT


def set_last_radar_scan_ts(scan_ts: float) -> None:
    global _last_radar_scan_ts
    _last_radar_scan_ts = float(scan_ts)


def last_radar_scan_ts() -> float:
    return _last_radar_scan_ts


def _matrix_path(scan_ts: int) -> Path:
    return _MATRIX_DIR / f"{scan_ts}.json"


def _dormant_path(scan_ts: int) -> Path:
    return _DORMANT_DIR / f"{scan_ts}.json"


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def _append_index(record: dict[str, Any]) -> None:
    _ARCHIVE_ROOT.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    with _INDEX_PATH.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def persist_matrix_snapshot(*, scan_ts: float, matrix: dict[str, Any]) -> int:
    """落盘与 GET /api/matrix 一致的 payload。"""
    key = int(scan_ts)
    body = dict(matrix)
    body["scan_ts"] = float(scan_ts)
    body["archived_at"] = time.time()
    with _lock:
        _write_json(_matrix_path(key), body)
        _append_index({"scan_ts": key, "kind": "matrix", "ts": body["archived_at"]})
    return key


def persist_dormant_funnel_snapshot(
    *,
    scan_ts: float | None,
    payload: dict[str, Any],
    source: str = "radar_scan",
) -> int:
    """落盘与 GET /api/dormant-funnel 一致的 payload，并写入 scan_ts。"""
    ts = float(scan_ts if scan_ts is not None else time.time())
    key = int(ts)
    body = dict(payload)
    body["scan_ts"] = ts
    body["archive_source"] = source
    body["archived_at"] = time.time()
    with _lock:
        _write_json(_dormant_path(key), body)
        _append_index({"scan_ts": key, "kind": "dormant-funnel", "source": source, "ts": body["archived_at"]})
    return key


def persist_radar_scan(*, scan_ts: float, matrix: dict[str, Any], dormant: dict[str, Any]) -> None:
    """雷达主扫描一轮：矩阵 + 当前漏斗态各一份。"""
    set_last_radar_scan_ts(scan_ts)
    persist_matrix_snapshot(scan_ts=scan_ts, matrix=matrix)
    persist_dormant_funnel_snapshot(scan_ts=scan_ts, payload=dormant, source="radar_scan")


def iter_scan_ts_in_range(start: int, end: int, *, kind: str = "matrix") -> Iterator[int]:
    base = _MATRIX_DIR if kind == "matrix" else _DORMANT_DIR
    if not base.is_dir():
        return
    for path in sorted(base.glob("*.json")):
        try:
            key = int(path.stem)
        except ValueError:
            continue
        if start <= key <= end:
            yield key


def list_matrix_scan_ts(start: int, end: int) -> list[int]:
    return sorted(iter_scan_ts_in_range(start, end, kind="matrix"))


def list_dormant_scan_ts(start: int, end: int) -> list[int]:
    return sorted(iter_scan_ts_in_range(start, end, kind="dormant-funnel"))


def load_matrix_snapshot(scan_ts: int) -> dict[str, Any] | None:
    path = _matrix_path(int(scan_ts))
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("读取 matrix 存档失败 %s: %s", path.name, exc)
        return None


def load_dormant_snapshot(scan_ts: int) -> dict[str, Any] | None:
    path = _dormant_path(int(scan_ts))
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("读取 dormant 存档失败 %s: %s", path.name, exc)
        return None


def load_dormant_at_or_before(ts: int) -> tuple[int | None, dict[str, Any] | None]:
    """回测对齐：取 <= ts 的最近一份 dormant 存档。"""
    if not _DORMANT_DIR.is_dir():
        return None, None
    keys = sorted(
        int(p.stem)
        for p in _DORMANT_DIR.glob("*.json")
        if p.stem.isdigit() and int(p.stem) <= ts
    )
    if not keys:
        return None, None
    key = keys[-1]
    return key, load_dormant_snapshot(key)


def archive_stats() -> dict[str, Any]:
    m = len(list(_MATRIX_DIR.glob("*.json"))) if _MATRIX_DIR.is_dir() else 0
    d = len(list(_DORMANT_DIR.glob("*.json"))) if _DORMANT_DIR.is_dir() else 0
    return {
        "root": str(_ARCHIVE_ROOT),
        "matrix_files": m,
        "dormant_files": d,
        "last_radar_scan_ts": _last_radar_scan_ts or None,
    }
