"""潜力发现扫描配置（env 可覆盖）。"""
from __future__ import annotations

import os

POTENTIAL_DISCOVERY_ENABLED = os.environ.get("OI_POTENTIAL_DISCOVERY", "1").strip().lower() not in (
    "0",
    "false",
    "no",
)
POTENTIAL_DISCOVERY_INTERVAL_SEC = int(os.environ.get("OI_POTENTIAL_DISCOVERY_INTERVAL_SEC") or "900")
POTENTIAL_FAST_SCAN_SEC = int(
    os.environ.get("OI_POTENTIAL_FAST_SEC") or os.environ.get("OI_POTENTIAL_DISCOVERY_INTERVAL_SEC") or "900"
)
POTENTIAL_SLOW_SCAN_SEC = int(os.environ.get("OI_POTENTIAL_SLOW_SEC") or "3600")
POTENTIAL_DISCOVERY_MAX_SCAN = int(os.environ.get("OI_POTENTIAL_DISCOVERY_MAX_SCAN") or "100")
POTENTIAL_DISCOVERY_KLINE_LIMIT = int(os.environ.get("OI_POTENTIAL_DISCOVERY_KLINE_LIMIT") or "720")
POTENTIAL_DISCOVERY_INTERVAL = str(os.environ.get("OI_POTENTIAL_DISCOVERY_TF") or "1h").strip() or "1h"
POTENTIAL_DISCOVERY_MIN_SCORE = int(os.environ.get("OI_POTENTIAL_DISCOVERY_MIN_SCORE") or "35")
# 未达 hit 但单模型 score ≥ 此值仍参与合并（0=仅 spec 命中）；默认 22 避免看板长期为空
POTENTIAL_SOFT_EXPORT_MIN = int(os.environ.get("OI_POTENTIAL_SOFT_EXPORT_MIN") or "22")
