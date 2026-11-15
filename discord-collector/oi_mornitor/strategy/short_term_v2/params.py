"""短线策略 V2 参数：可编程规则的初始阈值。研究起点，非已验证盈利参数。

现有形态/MTF/A-B 信号保留为 V1；本包独立产出 S01–S13，可与 V1 并行，不叠加进 V1。
"""
from __future__ import annotations

from typing import Any

STRATEGY_VERSION = "v2"
RESEARCH_DISCLAIMER = (
    "短线策略 V2 是独立于 V1 的可编程机会规则集；"
    "阈值是建议初始值，不是已经过回测验证的盈利参数。"
    "各策略独立扫描与统计，不默认叠加到 V1。"
)

# 扫描主周期：机会形成在 15m；结构确认可用 1h/4h/1d。
SETUP_TF = "15m"
STRUCTURE_TF = "1h"
REGIME_TF = "4h"
ATR_PERIOD = 14
RVOL_LOOKBACK = 20
OI_LOOKBACK_REF = 1  # 相对上一根

# 策略编号与名称（与规则表 §十四 对齐）
STRATEGY_IDS = (
    "S01",  # 短线形态放量
    "S02",  # 大周期形态
    "S03",  # 清算反转
    "S04",  # 清算延续
    "S05",  # 沉寂复苏
    "S06",  # 小币假突破
    "S07",  # 大币假突破
    "S08",  # 消息驱动
    "S09",  # 平台事件
    "S10",  # OI 异常
    "S11",  # 价格异常
    "S12",  # 流动性陷阱
    "S13",  # 恐慌超买超卖
)

STRATEGY_LABELS = {
    "S01": "短线形态放量",
    "S02": "大周期形态",
    "S03": "清算反转",
    "S04": "清算延续",
    "S05": "沉寂复苏",
    "S06": "小币假突破",
    "S07": "大币假突破",
    "S08": "消息驱动",
    "S09": "平台事件",
    "S10": "OI异常",
    "S11": "价格异常",
    "S12": "流动性陷阱",
    "S13": "恐慌超买超卖",
}

# 第一批优先实现（§十五）；其余可注册为观察/过滤 stub。
BATCH1_STRATEGIES = ("S01", "S03", "S04", "S05", "S06", "S07", "S10")
BATCH2_STRATEGIES = ("S02", "S08", "S09", "S11", "S12", "S13")

# 三个梯队初始准入（§一.2）：键为 market_cap_tier 1/2/3
TIER_PARAMS: dict[int, dict[str, float]] = {
    1: {
        "rvol_15m": 1.5,
        "oi_15m_pct": 3.0,
        "oi_1h_pct": 5.0,
        "spread_max_pct": 0.10,
        "depth_mult": 10.0,
        "risk_r": 1.0,
        "breakout_lookback": 20.0,
        "quiet_rvol": 1.5,
        "quiet_oi_pct": 3.0,
        "price_z": 3.0,
        "atr_move": 1.5,
        "liq_pctile": 95.0,
    },
    2: {
        "rvol_15m": 2.0,
        "oi_15m_pct": 5.0,
        "oi_1h_pct": 8.0,
        "spread_max_pct": 0.20,
        "depth_mult": 10.0,
        "risk_r": 0.7,
        "breakout_lookback": 20.0,
        "quiet_rvol": 2.0,
        "quiet_oi_pct": 5.0,
        "price_z": 3.0,
        "atr_move": 2.0,
        "liq_pctile": 95.0,
    },
    3: {
        "rvol_15m": 2.5,
        "oi_15m_pct": 8.0,
        "oi_1h_pct": 12.0,
        "spread_max_pct": 0.40,
        "depth_mult": 15.0,
        "risk_r": 0.4,
        "breakout_lookback": 20.0,
        "quiet_rvol": 2.5,
        "quiet_oi_pct": 8.0,
        "price_z": 3.0,
        "atr_move": 2.5,
        "liq_pctile": 99.0,
    },
}

# 公共约束
MAX_CHASE_ATR = 1.0  # 突破 K 线收盘距突破位超过 1 ATR 不追
MIN_RR_AFTER_COST = 1.0  # 预期收益至少覆盖止损+成本量级
DEFAULT_FEE_PCT = 0.06
DEFAULT_SLIP_PCT = 0.03
TIMEOUT_BARS_15M = 16  # 约 4h，与 V1 灵活短线同量级
STRUCTURE_BUFFER_PCT = 0.05 / 100.0

# 沉寂复苏
QUIET_ATR_PCTILE = 20.0
QUIET_LOOKBACK_DAYS = 30
QUIET_BASELINE_DAYS = 180
REVIVAL_1H_RVOL = 1.5

# 清算
LIQ_LOOKBACK_BARS_30D_15M = 30 * 24 * 4  # 约 30 天 15m
LIQ_SHOCK_ATR = 1.5

# 假突破
FAKE_BREAK_OI_T3 = 8.0
FAKE_BREAK_RVOL_T3 = 2.5
FAKE_BREAK_OI_T1 = 5.0

# 恐慌/过热（第二批，参数预置）
RSI_PANIC_15M = 20.0
RSI_PANIC_1H = 30.0
RSI_HOT_15M = 80.0
RSI_HOT_1H = 70.0

# 去重：同策略同向同结构位在 N 根内合并
DEDUP_BARS = 4


def tier_param(tier: int, key: str, default: float | None = None) -> float:
    row = TIER_PARAMS.get(int(tier), TIER_PARAMS[2])
    if key not in row:
        if default is not None:
            return float(default)
        raise KeyError(key)
    return float(row[key])


def defaults_dict() -> dict[str, Any]:
    return {
        "strategyVersion": STRATEGY_VERSION,
        "disclaimer": RESEARCH_DISCLAIMER,
        "batch1": list(BATCH1_STRATEGIES),
        "batch2": list(BATCH2_STRATEGIES),
        "strategyLabels": dict(STRATEGY_LABELS),
        "tierParams": {str(k): dict(v) for k, v in TIER_PARAMS.items()},
        "setupTf": SETUP_TF,
        "maxChaseAtr": MAX_CHASE_ATR,
        "dedupBars": DEDUP_BARS,
    }
