"""Sequoia-X 风格选币策略（加密适配）— 与形态+量能并行，默认扫描关闭。"""
from __future__ import annotations

from oi_mornitor.strategy_sequoia.backtest import SequoiaBacktestResult, run_sequoia_backtest
from oi_mornitor.strategy_sequoia.bridge import hit_to_alert, record_sequoia_alert
from oi_mornitor.strategy_sequoia.config import SEQUOIA_SCAN_ENABLED, is_sequoia_scan_enabled
from oi_mornitor.strategy_sequoia.registry import ALL_STRATEGY_IDS, STRATEGY_META, chinese_catalog
from oi_mornitor.strategy_sequoia.scan import scan_sequoia_ticker_alerts
from oi_mornitor.strategy_sequoia.universe import (
    default_crypto_leader_symbols,
    default_crypto_symbols,
    default_us_equity_symbols,
)
from oi_mornitor.strategy_sequoia.strategies import detect_all, detect_last_closed

__all__ = [
    "ALL_STRATEGY_IDS",
    "STRATEGY_META",
    "SEQUOIA_SCAN_ENABLED",
    "SequoiaBacktestResult",
    "chinese_catalog",
    "detect_all",
    "detect_last_closed",
    "hit_to_alert",
    "is_sequoia_scan_enabled",
    "record_sequoia_alert",
    "run_sequoia_backtest",
    "scan_sequoia_ticker_alerts",
    "default_crypto_leader_symbols",
    "default_crypto_symbols",
    "default_us_equity_symbols",
]
