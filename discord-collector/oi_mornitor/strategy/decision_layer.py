"""阶段 4 脚手架：按 4h/1h 环境分发三个独立策略。

组合收益不得当作已验证结果。重叠持仓只计一次风险，不可把各策略盈亏简单相加。
预留滚动训练/验证/测试窗口（默认 3 个月开发 / 1 个月验证 / 1 个月测试）。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable

from oi_mornitor.market_regime import classify_trend_regime
from oi_mornitor.strategy.liquidity_reversal import (
    STRATEGY_ID as LIQ_ID,
    detect_liquidity_reversal_trades,
)
from oi_mornitor.strategy.range_reversion import (
    STRATEGY_ID as RANGE_ID,
    detect_range_reversion_trades,
)
from oi_mornitor.strategy.trend_continuation import (
    STRATEGY_ID as TREND_ID,
    detect_trend_pullback_trades,
)

# 分发优先级：同一标的同一时段只保留一个策略的交易（不简单加总）。
PRIORITY = (TREND_ID, LIQ_ID, RANGE_ID)

DEVELOP_DAYS = 90
VALIDATE_DAYS = 30
TEST_DAYS = 30


def strategies_for_regime(regime_4h: str | None, regime_1h: str | None) -> list[str]:
    r4 = str(regime_4h or "").lower()
    r1 = str(regime_1h or "").lower()
    if r4 in ("trend_up", "trend_down"):
        return [TREND_ID, LIQ_ID]  # 趋势中可做回调；反转仅在严格流动性条件下
    if r4 == "range" or r1 == "range":
        return [RANGE_ID, LIQ_ID]
    # 转换期：更保守，只跑严格流动性
    return [LIQ_ID]


def collect_independent_signals(
    df_1h,
    df_4h=None,
    *,
    symbol: str = "",
    sl_profile: str = "structure",
    dispatch: bool = True,
) -> list[dict[str, Any]]:
    """按环境调用对应策略。dispatch=False 时三个都跑（用于对照，仍须去重叠）。"""
    r4 = r1 = None
    if df_4h is not None and len(df_4h):
        r4 = classify_trend_regime(df_4h, end_idx=len(df_4h) - 1, tf="4h").label
    if df_1h is not None and len(df_1h):
        r1 = classify_trend_regime(df_1h, end_idx=len(df_1h) - 1, tf="1h").label
    want = set(strategies_for_regime(r4, r1)) if dispatch else {TREND_ID, LIQ_ID, RANGE_ID}
    out: list[dict[str, Any]] = []
    if TREND_ID in want:
        out.extend(detect_trend_pullback_trades(df_1h, df_4h, symbol=symbol, sl_profile=sl_profile))
    if LIQ_ID in want:
        out.extend(detect_liquidity_reversal_trades(df_1h, df_4h, symbol=symbol, sl_profile=sl_profile))
    if RANGE_ID in want:
        out.extend(detect_range_reversion_trades(df_1h, df_4h, symbol=symbol, sl_profile=sl_profile))
    return out


def dedupe_overlapping_trades(
    trades: list[dict[str, Any]],
    *,
    overlap_ms: int = 6 * 3600_000,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """同一标的时间重叠的交易只保留优先级更高者。返回 (kept, dropped_as_overlap)。"""
    pri = {s: i for i, s in enumerate(PRIORITY)}
    ordered = sorted(
        trades,
        key=lambda t: (str(t.get("symbol")), int(t.get("signalAt") or t.get("bar_index") or 0), pri.get(t.get("strategy"), 99)),
    )
    kept: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for t in ordered:
        sym = str(t.get("symbol") or "")
        t0 = int(t.get("signalAt") or 0)
        timeout = int(t.get("timeoutBars") or 24) * 3600_000  # 1h 近似
        clash = False
        for k in kept:
            if str(k.get("symbol") or "") != sym:
                continue
            k0 = int(k.get("signalAt") or 0)
            k_to = int(k.get("timeoutBars") or 24) * 3600_000
            if abs(t0 - k0) < overlap_ms or (t0 < k0 + k_to and k0 < t0 + timeout):
                # 已保留的优先（排序已按优先级）
                clash = True
                d = dict(t)
                d["droppedAsOverlap"] = True
                d["overlapWith"] = k.get("strategy")
                dropped.append(d)
                break
        if not clash:
            kept.append(t)
    return kept, dropped


def walk_forward_windows(
    start_ms: int,
    end_ms: int,
    *,
    develop_days: int = DEVELOP_DAYS,
    validate_days: int = VALIDATE_DAYS,
    test_days: int = TEST_DAYS,
) -> list[dict[str, int | str]]:
    """滚动窗口：develop / validate / test，向前滚动 test_days。"""
    day = 86_400_000
    step = test_days * day
    span = (develop_days + validate_days + test_days) * day
    windows: list[dict[str, int | str]] = []
    t = int(start_ms)
    idx = 0
    while t + span <= int(end_ms) + day:
        d0 = t
        d1 = d0 + develop_days * day
        v1 = d1 + validate_days * day
        t1 = v1 + test_days * day
        windows.append({
            "index": idx,
            "developStart": d0,
            "developEnd": d1,
            "validateStart": d1,
            "validateEnd": v1,
            "testStart": v1,
            "testEnd": min(t1, int(end_ms)),
        })
        t += step
        idx += 1
        if idx > 64:
            break
    return windows


def combined_equity_disclaimer() -> str:
    return (
        "组合收益仅为脚手架汇总，不是已验证的样本外结果。"
        "重叠交易已按优先级去重，禁止把各策略独立盈亏直接相加。"
        "需完成滚动训练/验证/测试后再考虑模拟盘。"
    )
