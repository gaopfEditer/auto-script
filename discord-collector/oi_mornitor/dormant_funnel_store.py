"""沉寂拉盘候选池 / 点火快照（供顶栏 API）。"""

from __future__ import annotations



import threading

import time

from typing import Any



_lock = threading.RLock()

_candidates: list[dict[str, Any]] = []

_ignitions: list[dict[str, Any]] = []

_updated_at: float = 0.0

_slow_at: float = 0.0

_fast_at: float = 0.0





def update_funnel_snapshot(

    *,

    candidates: list[dict[str, Any]],

    ignitions: list[dict[str, Any]] | None = None,

    slow_scan: bool = False,

    fast_scan: bool = False,

) -> None:

    global _candidates, _ignitions, _updated_at, _slow_at, _fast_at

    now = time.time()

    with _lock:

        _candidates = sorted(candidates, key=lambda x: -int(x.get("score") or 0))[:80]

        if ignitions is not None:

            _ignitions = ignitions[:40]

        _updated_at = now

        if slow_scan:

            _slow_at = now

        if fast_scan:

            _fast_at = now





def _merge_board(
    candidates: list[dict[str, Any]],
    ignitions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    board: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in ignitions:
        sym = str(row.get("symbol") or "").upper()
        if not sym or sym in seen:
            continue
        seen.add(sym)
        board.append(row)
    for row in candidates:
        sym = str(row.get("symbol") or "").upper()
        if not sym or sym in seen:
            continue
        seen.add(sym)
        board.append(row)
    return board


def get_funnel_payload() -> dict[str, Any]:

    with _lock:

        cands = list(_candidates)
        ign = list(_ignitions)
        return {

            "ok": True,

            "updated_at": int(_updated_at) if _updated_at else None,

            "slow_scan_at": int(_slow_at) if _slow_at else None,

            "fast_scan_at": int(_fast_at) if _fast_at else None,

            "candidates": cands,

            "ignitions": ign,

            "board": _merge_board(cands, ign),

        }





def candidate_symbols() -> list[str]:

    with _lock:

        return [str(c.get("symbol") or "").upper() for c in _candidates if c.get("symbol")]


