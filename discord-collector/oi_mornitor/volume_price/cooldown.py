"""量价正式信号冷却（仅 formal 占槽）。"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

from oi_mornitor.config import PATTERN_STATE_DB
from oi_mornitor.volume_price.vp_config import COOLDOWN_BARS

logger = logging.getLogger(__name__)

_LOCK = threading.RLock()
_STATE_FILE = Path(PATTERN_STATE_DB).resolve().parent / "vp_signal_cooldown.json"
_state: dict[str, dict[str, Any]] | None = None


def _load() -> dict[str, dict[str, Any]]:
    global _state
    with _LOCK:
        if _state is not None:
            return dict(_state)
        raw: dict[str, dict[str, Any]] = {}
        if _STATE_FILE.is_file():
            try:
                data = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    raw = {str(k): v for k, v in data.items() if isinstance(v, dict)}
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取量价冷却状态失败: %s", exc)
        _state = raw
        return dict(raw)


def _save(data: dict[str, dict[str, Any]]) -> None:
    global _state
    with _LOCK:
        _state = dict(data)
        try:
            _STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            _STATE_FILE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            logger.warning("写入量价冷却状态失败: %s", exc)


def series_key(symbol: str, tf: str, side: str, series: str) -> str:
    return f"{symbol.upper()}|{tf}|{side.lower()}|{series}"


def is_cooldown_active(key: str, *, bar_index: int) -> bool:
    st = _load().get(key)
    if not st:
        return False
    until = int(st.get("cooldown_until_index") or -1)
    return bar_index <= until


def register_formal_signal(
    key: str,
    *,
    bar_index: int,
    signal_low: float,
    signal_high: float,
    entry: float,
    ema20: float,
    side: str,
) -> None:
    data = _load()
    data[key] = {
        "bar_index": bar_index,
        "signal_low": signal_low,
        "signal_high": signal_high,
        "entry": entry,
        "ema20": ema20,
        "side": side,
        "cooldown_until_index": -1,
    }
    _save(data)


def update_invalidation(
    key: str,
    *,
    bar_index: int,
    close: float,
    ema20: float,
) -> None:
    """若已失效则进入冷却窗口。"""
    data = _load()
    st = data.get(key)
    if not st:
        return
    side = str(st.get("side") or "long")
    inv = False
    if side == "long":
        if close < float(st.get("signal_low") or 0):
            inv = True
        if ema20 and close < float(ema20):
            inv = True
    else:
        if close > float(st.get("signal_high") or 0):
            inv = True
        if ema20 and close > float(ema20):
            inv = True
    if inv:
        st["cooldown_until_index"] = bar_index + COOLDOWN_BARS
        data[key] = st
        _save(data)


def refresh_all_from_market(
    enriched_by_key: dict[tuple[str, str], Any],
    closed_index_by_sym_tf: dict[tuple[str, str], int],
) -> None:
    """用最新收盘 K 更新所有活跃冷却状态的失效判定。"""
    data = _load()
    for key in list(data.keys()):
        parts = key.split("|")
        if len(parts) != 4:
            continue
        sym, tf, _side, _series = parts
        chunk = enriched_by_key.get((sym, tf))
        idx = closed_index_by_sym_tf.get((sym, tf), -1)
        if chunk is None or idx < 0 or idx >= len(chunk):
            continue
        row = chunk.iloc[idx]
        update_invalidation(
            key,
            bar_index=idx,
            close=float(row.get("close") or 0),
            ema20=float(row.get("ema20") or 0),
        )


def refresh_cooldown_for_bar(
    symbol: str,
    tf: str,
    *,
    bar_index: int,
    close: float,
    ema20: float,
    side: str,
    series: str,
) -> None:
    key = series_key(symbol, tf, side, series)
    update_invalidation(key, bar_index=bar_index, close=close, ema20=ema20)
