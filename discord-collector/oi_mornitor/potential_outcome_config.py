"""潜力信号事后评判：观察窗、检查点与「符合预期」口径。"""
from __future__ import annotations

import os

POTENTIAL_OUTCOME_ENABLED = os.environ.get("OI_POTENTIAL_OUTCOME_ENABLED", "1").strip().lower() not in (
    "0",
    "false",
    "no",
)

# 默认 7 天跟踪窗（与发现逻辑解耦，仅用于复盘修正模型）
POTENTIAL_TRACK_DAYS = float(os.environ.get("OI_POTENTIAL_TRACK_DAYS") or "7")
_hours_raw = os.environ.get("OI_POTENTIAL_OUTCOME_HOURS", "").strip()
if _hours_raw:
    POTENTIAL_OUTCOME_HOURS = float(_hours_raw)
else:
    POTENTIAL_OUTCOME_HOURS = POTENTIAL_TRACK_DAYS * 24.0

POTENTIAL_OUTCOME_KLINE_IV = str(os.environ.get("OI_POTENTIAL_OUTCOME_KLINE_IV") or "15m").strip() or "15m"
POTENTIAL_OUTCOME_MAX_SETTLE_PER_PASS = max(
    1, int(os.environ.get("OI_POTENTIAL_OUTCOME_MAX_SETTLE") or "24")
)
POTENTIAL_OUTCOME_MAX_CHECKPOINT_PER_PASS = max(
    1, int(os.environ.get("OI_POTENTIAL_OUTCOME_MAX_CHECKPOINT") or "32")
)

# 检查点日序（相对信号时刻，默认 +1d / +3d / +7d）
_cp_raw = str(os.environ.get("OI_POTENTIAL_TRACK_CHECKPOINT_DAYS") or "1,3,7").strip()
POTENTIAL_TRACK_CHECKPOINT_DAYS: tuple[int, ...] = tuple(
    sorted({max(1, int(x.strip())) for x in _cp_raw.split(",") if x.strip().isdigit()})
) or (1, 3, 7)

# 跟踪与潜力发现解耦：不因衰竭/离池缩短观察窗（仍可用新信号覆盖旧窗）
POTENTIAL_TRACK_DECOUPLE_DISCOVERY = os.environ.get(
    "OI_POTENTIAL_TRACK_DECOUPLE_DISCOVERY", "1"
).strip().lower() not in ("0", "false", "no")

# 「符合预期」简单规则（窗口终点结算时判定，便于调参）
POTENTIAL_TRACK_EXPECT_MIN_RETURN_PCT = float(
    os.environ.get("OI_POTENTIAL_TRACK_EXPECT_MIN_RETURN_PCT") or "1.5"
)
POTENTIAL_TRACK_EXPECT_MAX_MAE_PCT = float(
    os.environ.get("OI_POTENTIAL_TRACK_EXPECT_MAX_MAE_PCT") or "8.0"
)
