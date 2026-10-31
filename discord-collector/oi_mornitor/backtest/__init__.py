"""回测模块。"""
from oi_mornitor.backtest.engine import BacktestResult, run_pullback_backtest
from oi_mornitor.backtest.sequoia_pipeline import (
    SEQUOIA_BT_HOLD_BARS,
    SEQUOIA_BT_LEVERAGE,
    SEQUOIA_BT_MARGIN_CNY,
    SEQUOIA_BT_SL_PCT,
    SEQUOIA_BT_US_HOLD_BARS,
    SEQUOIA_BT_US_LEVERAGE,
    SEQUOIA_BT_US_MARGIN_CNY,
    SEQUOIA_BT_US_SL_PCT,
    SequoiaPipelineResult,
    default_major_symbols,
    leverage_report,
    normalize_track,
    resolve_klines_root,
    run_sequoia_pipeline,
    track_defaults,
)
from oi_mornitor.backtest.strategies import CostDefenseTrailingManager, RiskConfig

__all__ = [
    "BacktestResult",
    "CostDefenseTrailingManager",
    "RiskConfig",
    "SEQUOIA_BT_HOLD_BARS",
    "SEQUOIA_BT_LEVERAGE",
    "SEQUOIA_BT_MARGIN_CNY",
    "SEQUOIA_BT_SL_PCT",
    "SEQUOIA_BT_US_HOLD_BARS",
    "SEQUOIA_BT_US_LEVERAGE",
    "SEQUOIA_BT_US_MARGIN_CNY",
    "SEQUOIA_BT_US_SL_PCT",
    "SequoiaPipelineResult",
    "default_major_symbols",
    "leverage_report",
    "normalize_track",
    "resolve_klines_root",
    "run_pullback_backtest",
    "run_sequoia_pipeline",
    "track_defaults",
]
