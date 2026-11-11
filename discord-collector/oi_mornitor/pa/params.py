"""PA algorithm versions and fixed thresholds (immutable record versioning)."""

from __future__ import annotations

SWING_ALGO_VERSION = "swing-v1"
LIQUIDITY_ALGO_VERSION = "liquidity-v1"
OBFVG_ALGO_VERSION = "obfvg-v1"
VWAP_ALGO_VERSION = "vwap-v1"
SESSION_ALGO_VERSION = "session-v1"
PA_BUNDLE_VERSION = "pa-bundle-v1"

SWING_LOOKBACK = 2
EQUAL_LEVEL_TOLERANCE_PCT = 0.05
SWEEP_EXCEED_PCT = 0.0
LIQUIDITY_WEIGHTS = {
    "equal_levels": 40.0,
    "open_interest": 35.0,
    "funding_rate": 15.0,
    "liquidation": 10.0,
}
FVG_MIN_GAP_PCT = 0.0
OB_DEDUP_TOLERANCE_PCT = 0.05

# Crypto: UTC calendar day VWAP reset (documented convention for 24h markets).
SESSION_TIMEZONE = "UTC"
KILLZONES = {
    "asian": (0, 8),
    "london": (7, 16),
    "newyork": (12, 21),
}

PA_LOOKBACK = 200

TIMEFRAME_SECONDS: dict[str, int] = {
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "2h": 7200,
    "4h": 14400,
    "6h": 21600,
    "8h": 28800,
    "12h": 43200,
    "1d": 86400,
}
