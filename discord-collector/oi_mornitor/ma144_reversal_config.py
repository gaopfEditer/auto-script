"""144 均线附近射击之星 / 倒锤子 → MAIN 群（env 可覆盖）。"""
from __future__ import annotations

import os


def _env_bool(key: str, default: str = "1") -> bool:
    return os.environ.get(key, default).strip().lower() not in ("0", "false", "no")


MA144_MAIN_ENABLED = _env_bool("OI_MA144_MAIN_ENABLED", "1")
# 贴近 EMA144 的相对容差（占 EMA 价位比例）
MA144_NEAR_TOL_PCT = float(os.environ.get("OI_MA144_NEAR_TOL_PCT") or "0.012")
# 信号柱前 N 根（不含信号柱）内，收盘在 EMA144 上方且放量的 K 线至少几根
MA144_VOL_LOOKBACK = max(1, int(os.environ.get("OI_MA144_VOL_LOOKBACK") or "5"))
MA144_VOL_MIN_BARS = max(1, int(os.environ.get("OI_MA144_VOL_MIN_BARS") or "2"))
MA144_VOL_MULT = float(os.environ.get("OI_MA144_VOL_MULT") or "1.2")

_DEFAULT_T12 = "1h,4h"
_DEFAULT_T3 = "15m,1h"
_DEFAULT_EQUITY = "4h,1d,1w"


def _parse_intervals(raw: str) -> tuple[str, ...]:
    out: list[str] = []
    for part in str(raw or "").split(","):
        iv = part.strip().lower()
        if iv:
            out.append(iv)
    return tuple(out)


MA144_T12_INTERVALS = _parse_intervals(
    os.environ.get("OI_MA144_T12_INTERVALS") or _DEFAULT_T12
)
MA144_T3_INTERVALS = _parse_intervals(
    os.environ.get("OI_MA144_T3_INTERVALS") or _DEFAULT_T3
)
MA144_EQUITY_INTERVALS = _parse_intervals(
    os.environ.get("OI_MA144_EQUITY_INTERVALS") or _DEFAULT_EQUITY
)


def is_ma144_main_enabled() -> bool:
    return MA144_MAIN_ENABLED
