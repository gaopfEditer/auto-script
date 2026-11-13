"""短线策略 V1 锁定默认参数。研究起点，不是已验证的最优参数或盈利承诺。

本文件与 `strategy/short_term_v1` 即「现有形态信号列表 / 信号产生策略」的 V1 基准。
V2 在 `strategy/short_term_v2`，并行产出，默认不叠加。
"""
from __future__ import annotations

from typing import Any

STRATEGY_VERSION = "v1"

# 场地与持仓：合约优先，灵活短线 5 分钟–4 小时。
VENUE = "usdt_m_futures"
VENUE_LABEL = "USDT-M 永续（合约优先）"
HORIZON = "5m-4h"
HORIZON_LABEL = "灵活短线：5 分钟–4 小时"
TIMEFRAME_STACK = {
    "4h": "市场环境（趋势 / 震荡 / 高波动风险）",
    "1h": "交易结构（摆动、支撑阻力、流动性区域）",
    "15m": "机会形成（扫单 / 回踩 / 吸收）",
    "5m": "执行进场（价格反应；不用单一指标异动开仓）",
}
EXECUTION_TF = "5m"
SETUP_TF = "15m"
STRUCTURE_TF = "1h"
REGIME_TF = "4h"
DEFAULT_EQUITY = 10_000.0  # USDT，仅用于回测仓位换算

# 单笔风险预算（占权益 %），取建议区间中值。不是名义仓位占比。
TIER_RISK_PERCENT = {"A": 0.40, "B": 0.30, "C": 0.18, "D": 0.10}

# 止损相对 ATR(15m) 的默认倍数（区间中值）；D 档用结构止损+滑点缓冲，不用纯 ATR。
TIER_ATR_K = {"A": 1.4, "B": 1.6, "C": 1.75, "D": None}
TIER_ATR_BAND = {
    "A": (1.2, 1.6),
    "B": (1.4, 1.8),
    "C": (1.5, 2.0),
    "D": None,
}
# D 档结构止损之外的滑点缓冲（占价格）。
D_SLIPPAGE_BUFFER_PCT = 0.08
# 所有档结构止损的微小缓冲（占价格），与 sl_profiles 一致量级再略宽。
STRUCTURE_BUFFER_PCT = 0.05 / 100.0  # 0.05%

# 分批止盈（R 倍数, 平仓比例）。剩余走跟踪；到达 TP1 后不自动把剩余移到保本。
TIER_TARGETS: dict[str, list[tuple[float | str, float]]] = {
    "A": [(1.0, 0.25), (2.0, 0.35), ("trailing", 0.40)],
    "B": [(1.0, 0.35), (1.8, 0.35), ("trailing", 0.30)],
    "C": [(0.8, 0.35), (1.5, 0.40), ("trailing", 0.25)],
    "D": [(0.8, 0.50), (1.5, 0.30), ("trailing", 0.20)],
}
# 实验 A–D 共用一套退出参数，把消融隔离在过滤条件而非仓位/出场差异。
SHARED_RISK_PERCENT = 0.30
SHARED_ATR_K = 1.5
SHARED_TARGETS: list[tuple[float | str, float]] = [(1.0, 0.30), (2.0, 0.30), ("trailing", 0.40)]

# 第一档计划止盈若低于此 R，视为盈亏比不合格，放弃。
MIN_FIRST_TARGET_R = 0.80
# 结构止损宽于「档位 ATR 上限 × 该倍数」则放弃。记录此倍数以便回测对照。
STOP_VS_ATR_CAP_MULT = 1.15
# 仓位过小（数量低于此）也放弃。
MIN_POSITION_QTY = 1e-8

# 组合并发风险上限：同时开仓的单笔风险预算之和（占权益 %）。
# 高度相关的同向持仓（如 BTC 带动的山寨多头）共用此上限；超出则跳过新开仓。
CONCURRENT_RISK_CAP_PERCENT = 1.20
# 简单相关组：BTC 与主要山寨视为同一风险簇；ETH 与 BTC 同簇。
CORRELATED_CLUSTER = "crypto_btc_beta"

# 成交：不利滑点超过该上限（单边 %）则视为无法成交，保守跳过。
MAX_SLIPPAGE_PCT = 0.15
# 到达 TP1 后不把剩余仓位止损移到保本（正常回踩容易被扫出）。
BREAKEVEN_AFTER_TP1 = False
# 同柱先止损再止盈（沿用现有悲观口径）。
SAME_BAR_SL_FIRST = True
# 跟踪止盈允许的最大剩余风险（相对初始 1R 的倍数）；部分止盈后不得无限放大剩余风险。
MAX_RESIDUAL_RISK_R = {
    "A": 1.00,
    "B": 0.90,
    "C": 0.70,
    "D": 0.55,
}
# 跟踪回吐（从有利极值回撤多少 R 出场），C/D 更紧。
TRAIL_GIVEBACK_R = {
    "A": 0.80,
    "B": 0.65,
    "C": 0.45,
    "D": 0.35,
}

# 持仓超时：灵活短线上限约 4 小时（5m 执行周期 48 根）。
TIMEOUT_BARS_5M = 48
ATR_PERIOD = 14

# 30 日均成交额（计价货币）分档阈值：流动性一票否决市值初分组。
VOL_B_MIN = 80_000_000.0
VOL_C_MIN = 15_000_000.0

# 默认回测宇宙不含美股代币。
EXCLUDE_EQUITY_TOKENS = True

PRICE_PROXY_NOTE = (
    "K 线价格仅作 USDT-M 永续的价格代理（本地库可能是现货或永续）。"
    "未单独建模基差；资金费率在有序列时计入，否则标记未建模、不虚构。"
)
RESEARCH_DISCLAIMER = (
    "短线策略 V1 是可回测的研究框架，参数是起点，不是已经验证的盈利承诺。"
    "优化目标是单笔净期望转正、盈亏比不长期低于 1、利润因子在样本外大于 1，"
    "以及更少但更高质量的交易——不是追求 55% 胜率。"
)


def take_profit_payload(tier: str, *, per_tier: bool = True) -> list[dict[str, Any]]:
    rows = TIER_TARGETS.get(tier, SHARED_TARGETS) if per_tier else SHARED_TARGETS
    out: list[dict[str, Any]] = []
    for r, ratio in rows:
        out.append({"r": r, "close_ratio": ratio})
    return out


def risk_percent_for(tier: str, *, per_tier: bool = True) -> float:
    if per_tier:
        return float(TIER_RISK_PERCENT.get(tier, SHARED_RISK_PERCENT))
    return float(SHARED_RISK_PERCENT)


def atr_k_for(tier: str, *, per_tier: bool = True) -> float | None:
    if per_tier:
        return TIER_ATR_K.get(tier)
    return SHARED_ATR_K


def atr_cap_for(tier: str, *, per_tier: bool = True) -> float | None:
    """档位 ATR 止损区间上沿，用于「止损过宽」检查。"""
    if not per_tier:
        return SHARED_ATR_K
    band = TIER_ATR_BAND.get(tier)
    if not band:
        return None
    return float(band[1])


def defaults_dict() -> dict[str, Any]:
    return {
        "strategyVersion": STRATEGY_VERSION,
        "venue": VENUE,
        "venueLabel": VENUE_LABEL,
        "horizon": HORIZON,
        "horizonLabel": HORIZON_LABEL,
        "timeframeStack": dict(TIMEFRAME_STACK),
        "tierRiskPercent": dict(TIER_RISK_PERCENT),
        "tierAtrK": {k: v for k, v in TIER_ATR_K.items()},
        "tierAtrBand": {k: list(v) if v else None for k, v in TIER_ATR_BAND.items()},
        "tierTargets": {k: take_profit_payload(k) for k in TIER_TARGETS},
        "sharedRiskPercent": SHARED_RISK_PERCENT,
        "sharedAtrK": SHARED_ATR_K,
        "minFirstTargetR": MIN_FIRST_TARGET_R,
        "stopVsAtrCapMult": STOP_VS_ATR_CAP_MULT,
        "concurrentRiskCapPercent": CONCURRENT_RISK_CAP_PERCENT,
        "maxSlippagePct": MAX_SLIPPAGE_PCT,
        "breakevenAfterTp1": BREAKEVEN_AFTER_TP1,
        "sameBarSlFirst": SAME_BAR_SL_FIRST,
        "timeoutBars5m": TIMEOUT_BARS_5M,
        "excludeEquityTokens": EXCLUDE_EQUITY_TOKENS,
        "priceProxyNote": PRICE_PROXY_NOTE,
        "researchDisclaimer": RESEARCH_DISCLAIMER,
        "pausedBottomSecondaryDefault": True,
        "pausedShootingStarDefault": False,
    }
