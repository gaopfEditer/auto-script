"""杠杆、强平与保证金审计：现货 K 线仅作价格代理，ROE=价变%×杠杆。

实际合约交易还需资金费率、合约基差；本模块不虚构费率。
手续费/滑点默认与 backtest_trade_config 对齐（taker 0.06%/边、滑点 0.03%/边），可经 env 覆盖。
"""
from __future__ import annotations

from typing import Any

from oi_mornitor.env_parse import env_bool, env_float
from oi_mornitor.symbol_aliases import human_base_asset

# 与 pattern_alert_stats._leverage 历史口径一致：BTC/ETH/SOL 100x，其他加密 20x。
# 注意：沙盒 SANDBOX_LEVERAGE_ALT 默认 30x，是另一套纸面系统，此处不混用。
LEV_100_ASSETS = frozenset({"BTC", "ETH", "SOL"})
LEVERAGE_MAJOR = env_float("OI_SETTLE_LEVERAGE_MAJOR", 100.0, min_val=1.0, max_val=125.0)
LEVERAGE_ALT = env_float("OI_SETTLE_LEVERAGE_ALT", 20.0, min_val=1.0, max_val=125.0)

# 维持保证金率（占名义本金）。Binance USDT-M 小仓 BTC 约 0.4%；山寨取更保守的 1.0%。
# 隔离仓大约：强平价 ≈ entry × (1 ∓ (1/lev − mmr))。
MMR_MAJOR = env_float("OI_SETTLE_MMR_MAJOR", 0.4, min_val=0.0, max_val=10.0) / 100.0
MMR_ALT = env_float("OI_SETTLE_MMR_ALT", 1.0, min_val=0.0, max_val=10.0) / 100.0

# 默认开启：模拟强平 + 单笔亏损不超过保证金（ROE 不低于 -100）。
OI_SETTLE_LIQUIDATION = env_bool("OI_SETTLE_LIQUIDATION", True)
OI_SETTLE_CAP_LOSS_AT_MARGIN = env_bool("OI_SETTLE_CAP_LOSS_AT_MARGIN", True)

# 资金费率：无合约数据时不建模。
FUNDING_MODELED = False
FUNDING_NOTE = "not modeled（无合约资金费序列，不虚构费率）"

# 与 backtest_trade_config 文档一致；结算侧引用此处做审计说明。
DOC_FEE_PCT = 0.06
DOC_SLIPPAGE_PCT = 0.03


def leverage_for_symbol(symbol: str, asset_class: str = "crypto") -> float:
    if str(asset_class or "").lower() == "equity":
        from oi_mornitor.config import OI_EQUITY_STATS_LEVERAGE

        lev = float(OI_EQUITY_STATS_LEVERAGE or 5)
        return lev if lev > 0 else 0.0
    return float(LEVERAGE_MAJOR) if human_base_asset(symbol) in LEV_100_ASSETS else float(LEVERAGE_ALT)


def maintenance_margin_rate(symbol: str, asset_class: str = "crypto") -> float:
    if str(asset_class or "").lower() == "equity":
        return 0.0
    if human_base_asset(symbol) in LEV_100_ASSETS:
        return float(MMR_MAJOR)
    return float(MMR_ALT)


def liquidation_distance_pct(leverage: float, mmr: float) -> float:
    """从入场到强平的价格距离（%）。杠杆 100、MMR 0.4% → 0.6%。"""
    lev = float(leverage) if leverage and leverage > 0 else 0.0
    if lev <= 0:
        return 0.0
    dist = (1.0 / lev - float(mmr)) * 100.0
    return max(dist, 0.0)


def liquidation_price(
    entry: float,
    *,
    is_short: bool,
    leverage: float,
    mmr: float,
) -> float | None:
    if entry <= 0 or leverage <= 0:
        return None
    dist = liquidation_distance_pct(leverage, mmr) / 100.0
    if dist <= 0:
        return entry
    if is_short:
        return entry * (1.0 + dist)
    return entry * (1.0 - dist)


def roe_from_price_move(move_pct: float, leverage: float) -> float:
    return float(move_pct) * float(leverage) if leverage else float(move_pct)


def cap_roe_at_margin(roe: float) -> tuple[float, bool]:
    """返回 (capped_roe, exceeded_before_cap)。亏损不超过保证金 → ROE ≥ -100。"""
    if not OI_SETTLE_CAP_LOSS_AT_MARGIN:
        return float(roe), bool(roe < -100.0)
    if roe < -100.0:
        return -100.0, True
    return float(roe), False


def move_pct_for_capped_roe(roe_capped: float, leverage: float) -> float:
    lev = float(leverage) if leverage and leverage > 0 else 1.0
    return roe_capped / lev


def audit_assumptions() -> dict[str, Any]:
    return {
        "priceSource": "spot_or_perp_klines_as_price_proxy",
        "roeFormula": "price_net_move_pct * leverage",
        "leverageMajor": LEVERAGE_MAJOR,
        "leverageAlt": LEVERAGE_ALT,
        "leverageMajorAssets": sorted(LEV_100_ASSETS),
        "mmrMajorPct": MMR_MAJOR * 100.0,
        "mmrAltPct": MMR_ALT * 100.0,
        "liquidationEnabled": OI_SETTLE_LIQUIDATION,
        "capLossAtMargin": OI_SETTLE_CAP_LOSS_AT_MARGIN,
        "feePctPerSideDefault": DOC_FEE_PCT,
        "slippagePctPerSideDefault": DOC_SLIPPAGE_PCT,
        "feeNote": "默认对齐 Bitget 合约 taker 约 0.06%/边（OI_BT_FEE_PCT）；沙盒 SANDBOX_FEE_PCT 默认 0.04，勿混用。",
        "slippageNote": "默认固定 0.03%/边（OI_BT_SLIPPAGE_PCT），未按流动性分档。",
        "fundingModeled": FUNDING_MODELED,
        "fundingNote": FUNDING_NOTE,
        "sandboxAltLeverageNote": "沙盒 SANDBOX_LEVERAGE_ALT 默认 30x，形态结算/回测为 20x；两套系统独立。",
        "contractBasisNote": "现货与永续基差未建模。",
        "sameBarPriority": "同柱先强平/止损，再止盈（v3 口径，不改）。",
    }
