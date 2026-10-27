"""潜力五模型配置（默认与 potential_models.yaml / spec v0.2 一致）。"""
from __future__ import annotations

import copy
import os
from typing import Any

DEFAULTS: dict[str, Any] = {
    "universe": {
        "mcap_min": 20_000_000,
        "mcap_max": 100_000_000,
        "min_quote_volume_24h": 500_000,
        "exclude_tokenized_stocks": True,
    },
    "scan": {
        "fast_interval_sec": 900,
        "slow_interval_sec": 3600,
        "fast_models": [
            "short_squeeze",
            "relative_strength",
            "liquidity_sweep",
        ],
        "slow_models": ["quiet_oi_breakout", "wyckoff_spring"],
    },
    "export": {
        "score_push": 70,
        "score_list_min": 55,
        "max_candidates": 50,
        "refresh_hours": 1,
        "risk_hint": "单笔风险建议≤本金1%–2%；非实盘信号",
    },
    "models_enabled": [
        "quiet_oi_breakout",
        "short_squeeze",
        "relative_strength",
        "wyckoff_spring",
        "liquidity_sweep",
    ],
    "quiet_oi_breakout": {
        "tf_primary": "4h",
        "oi_quiet_max": 0.85,
        "oi_chg_7d_min": 0.15,
        "oi_chg_14d_min": 0.20,
        "oi_accel_min": 0.0,
        "atr_pctile_max": 0.40,
        "volume_ratio_mild_min": 1.3,
        "volume_ratio_mild_max": 4.0,
        "volume_ratio_spike": 5.0,
        "lookback_range_bars": 60,
        "reclaim_ma": 20,
        "score_hit_min": 55,
    },
    "short_squeeze": {
        "tf_primary": "1h",
        "fund_mean_n": 3,
        "fund_extreme": -0.005,
        "fund_extreme_pctile": 0.10,
        "fund_neg_streak_min": 3,
        "oi_chg_1d_min": 0.08,
        "oi_chg_3d_min": 0.15,
        "price_anti_drop_max": 0.03,
        "basis_spot_premium_min": 0.0,
        "exit_fund_recover": -0.0005,
        "exit_oi_cliff_1d": -0.10,
    },
    "relative_strength_fast": {
        "tf_primary": "1h",
        "tf_trigger": "15m",
        "btc_lookback_bars": 8,
        "btc_down_th": -0.02,
        "btc_flat_th": 0.01,
        "vs_btc_down_min": 0.015,
        "break_lookback": 12,
        "vol_break_min": 1.4,
    },
    "relative_strength": {
        "tf_primary": "4h",
        "tf_trigger": "1h",
        "btc_lookback_bars": 12,
        "btc_down_th": -0.03,
        "btc_flat_th": 0.015,
        "vs_btc_down_min": 0.02,
        "break_lookback": 20,
        "ema_fast": 20,
        "ema_slow": 50,
        "vol_break_min": 1.5,
        "exit_vs_btc_lag": -0.02,
    },
    "wyckoff_spring": {
        "tf_primary": "4h",
        "box_min_bars": 40,
        "box_max_bars": 180,
        "box_width_pctile_max": 0.55,
        "spring_min_break": 0.005,
        "spring_max_break": 0.04,
        "spring_max_bars": 3,
        "spring_max_vol_z": 1.0,
        "test_max_vol_z": 0.5,
        "bc_vol_z": 3.0,
        "bc_body_atr_min": 1.5,
        "ar_retrace_min": 0.5,
    },
    "liquidity_sweep": {
        "tf_primary": "15m",
        "swing_L": 3,
        "eh_tol_pct": 0.0015,
        "el_tol_pct": 0.0015,
        "min_sep_bars": 5,
        "max_sep_bars": 80,
        "wick_min_atr": 0.8,
        "reclaim_required": True,
    },
}


def load_potential_config() -> dict[str, Any]:
    cfg = copy.deepcopy(DEFAULTS)
    raw = os.environ.get("OI_POTENTIAL_MODELS_ENABLED", "").strip()
    if raw:
        cfg["models_enabled"] = [x.strip() for x in raw.split(",") if x.strip()]
    push = os.environ.get("OI_POTENTIAL_SCORE_PUSH", "").strip()
    if push:
        cfg["export"]["score_push"] = int(push)
    list_min = os.environ.get("OI_POTENTIAL_SCORE_LIST_MIN", "").strip()
    legacy_min = os.environ.get("OI_POTENTIAL_DISCOVERY_MIN_SCORE", "").strip()
    if list_min:
        cfg["export"]["score_list_min"] = int(list_min)
    elif legacy_min:
        cfg["export"]["score_list_min"] = int(legacy_min)
    fast = os.environ.get("OI_POTENTIAL_FAST_SEC", "").strip()
    if fast:
        cfg["scan"]["fast_interval_sec"] = int(fast)
    slow = os.environ.get("OI_POTENTIAL_SLOW_SEC", "").strip()
    if slow:
        cfg["scan"]["slow_interval_sec"] = int(slow)
    legacy = os.environ.get("OI_POTENTIAL_DISCOVERY_INTERVAL_SEC", "").strip()
    if legacy and not fast:
        cfg["scan"]["fast_interval_sec"] = int(legacy)
    mcap_min = os.environ.get("OI_POTENTIAL_MCAP_MIN", "").strip()
    mcap_max = os.environ.get("OI_POTENTIAL_MCAP_MAX", "").strip()
    if mcap_min:
        cfg["universe"]["mcap_min"] = float(mcap_min)
    if mcap_max:
        cfg["universe"]["mcap_max"] = float(mcap_max)
    return cfg
