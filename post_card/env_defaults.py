"""Environment-backed defaults with safe hard-coded fallbacks."""

from __future__ import annotations

import os

DEFAULT_SL_PCT = float(os.environ.get("POST_CARD_DEFAULT_SL_PCT", "0.05"))
DEFAULT_TP_PCT = float(os.environ.get("POST_CARD_DEFAULT_TP_PCT", "0.10"))
MERGE_WINDOW_SEC = int(os.environ.get("POST_CARD_MERGE_WINDOW_SEC", "900"))
DEDUPE_WINDOW_SEC = int(os.environ.get("POST_CARD_DEDUPE_WINDOW_SEC", "300"))
BACKTEST_MAX_HORIZON_SEC = int(os.environ.get("POST_CARD_BACKTEST_HORIZON_SEC", str(7 * 24 * 3600)))
