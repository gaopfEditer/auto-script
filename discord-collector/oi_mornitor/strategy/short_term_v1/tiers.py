"""币种分层：市值排名为初分组，近 30 日均成交额与盘口深度（若有）一票否决。

扩展现有 mcap_tier（t1/t2/t3），产出 V1 档位 A/B/C/D/E。
美股代币（E）独立，默认回测宇宙排除，不套用 A 档加密参数。
盘口深度若历史库没有：用市值+成交额打分，标记 depth_missing=true；
D 档在缺少深度时默认收紧或跳过，不虚构深度。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

import pandas as pd

from oi_mornitor.mcap_tier import resolve_mcap_tier
from oi_mornitor.strategy.short_term_v1.params import VOL_B_MIN, VOL_C_MIN
from oi_mornitor.symbol_aliases import human_base_asset, normalize_usdt_symbol

TIER_A_CORE = frozenset({"BTC", "ETH"})
TIER_B_EXAMPLES = frozenset({"SOL", "DOGE", "BNB", "XRP", "ADA"})
TIER_C_EXAMPLES = frozenset({"UNI", "LINK", "AVAX", "NEAR", "AAVE", "ATOM"})

# 代币化个股 / ETF 相关资产：V1 存根，默认跳过。名单可扩展，不是完整登记。
EQUITY_TOKEN_BASES = frozenset({
    "AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "NFLX",
    "AMD", "INTC", "SPY", "QQQ", "HOOD", "COIN", "MSTR", "GME", "PLTR",
    "BABA", "NIO", "UBER", "CRM", "JPM", "V", "MA", "DIS", "BA", "TSM",
    "ORCL", "AVGO", "AMAT", "MU", "SMCI", "ARM", "SNOW", "CRWD", "APP",
    "IVV", "VOO", "DIA", "IWM",
})

TIER_LABELS = {
    "A": "核心高流动性（BTC/ETH）",
    "B": "大市值山寨",
    "C": "中市值币",
    "D": "小市值 / 长尾",
    "E": "美股代币（独立策略，V1 默认跳过）",
}

TIER_HINTS = {
    "A": "趋势跟随、突破回踩、流动性扫单收回。可更多依赖市场整体状态。",
    "B": "趋势、相对 BTC 强弱、突破确认。要求 BTC 方向不冲突。",
    "C": "严格结构 + 真实成交量 + 盘口支持。",
    "D": "仅在深度足够、优先扫单收回确认后短线；降低仓位。不能只看 K 线形态。",
    "E": "独立规则：交易时段、底层股票方向、脱锚与赎回机制。不套用加密 A 档参数。",
}


@dataclass
class TierAssignment:
    symbol: str
    tier: str
    label: str
    mcap_tier: str
    initial_group: str
    vol_30d_quote: float | None = None
    depth: float | None = None
    depth_missing: bool = True
    depth_thin: bool = False
    liquidity_overrode: bool = False
    is_equity_token: bool = False
    skipped: bool = False
    skip_reason: str | None = None
    evidence: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def is_equity_token(symbol: str) -> bool:
    base = human_base_asset(symbol)
    return base in EQUITY_TOKEN_BASES


def _initial_from_mcap(symbol: str, mcap: str) -> str:
    base = human_base_asset(symbol)
    if base in TIER_A_CORE:
        return "A"
    if mcap == "t1":
        return "B"
    if mcap == "t2":
        return "B"
    # t3 and unknown start as C, volume may downgrade to D or upgrade to B
    if base in TIER_B_EXAMPLES:
        return "B"
    if base in TIER_C_EXAMPLES:
        return "C"
    return "C" if mcap == "t3" else "C"


def trailing_30d_quote_volume(
    df: pd.DataFrame | None,
    *,
    end_idx: int | None = None,
    ts_col: str = "open_time",
) -> float | None:
    """近 30 日日均成交额（计价≈volume×典型价）。数据不足则返回 None。"""
    if df is None or len(df) == 0 or "volume" not in df.columns:
        return None
    end = len(df) - 1 if end_idx is None else min(int(end_idx), len(df) - 1)
    if end < 0:
        return None
    day_ms = 86_400_000
    if ts_col in df.columns:
        end_ts = int(df.iloc[end][ts_col])
        if end_ts < 1e12:
            end_ts *= 1000
        start_ts = end_ts - 30 * day_ms
        times = df[ts_col].astype("int64")
        if times.max() < 1e12:
            times = times * 1000
        mask = (times <= end_ts) & (times >= start_ts) & (times.index <= end)
        sl = df.loc[mask]
    else:
        # 无时间戳时按根数近似：1h≈720 根，15m≈2880 根；取末 720 根作 30 日 1h 近似。
        sl = df.iloc[max(0, end - 719) : end + 1]
    if sl is None or len(sl) == 0:
        return None
    typical = None
    if set(["high", "low", "close"]).issubset(sl.columns):
        typical = (sl["high"].astype(float) + sl["low"].astype(float) + sl["close"].astype(float)) / 3.0
    elif "close" in sl.columns:
        typical = sl["close"].astype(float)
    else:
        return None
    quote = sl["volume"].astype(float) * typical
    total = float(quote.sum())
    if ts_col in sl.columns:
        t = sl[ts_col].astype("int64")
        if t.max() < 1e12:
            t = t * 1000
        span_days = max((int(t.max()) - int(t.min())) / day_ms, 1.0)
    else:
        span_days = max(len(sl) / 24.0, 1.0)  # 假定 1h
    return total / span_days


def _apply_volume(initial: str, vol: float | None, *, is_core_a: bool) -> tuple[str, bool]:
    """流动性一票否决：成交额不足则降档；核心 BTC/ETH 不因成交额降出 A，但会标记。"""
    if vol is None:
        return initial, False
    if is_core_a:
        return "A", False
    if vol >= VOL_B_MIN:
        if initial in ("C", "D"):
            return "B", True
        return "B" if initial == "B" else initial, False
    if vol >= VOL_C_MIN:
        if initial == "B":
            return "C", True
        if initial == "D":
            return "C", True
        return "C", False
    # 低流动性 → D
    if initial != "D":
        return "D", True
    return "D", False


def classify_tier(
    symbol: str,
    *,
    vol_30d_quote: float | None = None,
    depth: float | None = None,
    depth_ref: float | None = None,
    df: pd.DataFrame | None = None,
    end_idx: int | None = None,
    skip_d_without_depth: bool = True,
    exclude_equity: bool = True,
) -> TierAssignment:
    """对单币分层。df 可选，用于在未传入成交额时估算 30 日均额。"""
    n = normalize_usdt_symbol(symbol) or str(symbol or "").upper()
    evidence: list[str] = []
    if is_equity_token(n):
        return TierAssignment(
            symbol=n,
            tier="E",
            label=TIER_LABELS["E"],
            mcap_tier=resolve_mcap_tier(n),
            initial_group="E",
            vol_30d_quote=vol_30d_quote,
            depth=depth,
            depth_missing=depth is None,
            is_equity_token=True,
            skipped=bool(exclude_equity),
            skip_reason="equity_token_excluded" if exclude_equity else None,
            evidence=["美股代币：V1 默认排除，不套用加密 A 档参数"],
        )

    mcap = resolve_mcap_tier(n)
    initial = _initial_from_mcap(n, mcap)
    evidence.append(f"市值初分组 mcap={mcap} → {initial}")
    is_core = human_base_asset(n) in TIER_A_CORE

    vol = vol_30d_quote
    if vol is None and df is not None:
        vol = trailing_30d_quote_volume(df, end_idx=end_idx)

    tier, overridden = _apply_volume(initial, vol, is_core_a=is_core)
    if vol is None:
        evidence.append("30 日成交额缺失，暂用市值初分组")
    else:
        evidence.append(f"30 日日均成交额约 {vol:,.0f}")
        if overridden:
            evidence.append(f"流动性将档位从 {initial} 调整为 {tier}")
        if is_core and vol is not None and vol < VOL_C_MIN:
            evidence.append("BTC/ETH 成交额偏低但仍保留 A，需人工复核")

    depth_missing = depth is None
    depth_thin = False
    skipped = False
    skip_reason = None
    if depth is not None:
        ref = depth_ref if depth_ref and depth_ref > 0 else None
        if ref and depth < ref * 0.5:
            depth_thin = True
            evidence.append("盘口深度相对基准下降超过 50%")
        elif depth <= 0:
            depth_thin = True
            evidence.append("盘口深度为零")
    else:
        evidence.append("depth_missing：历史库无盘口深度，未虚构")

    if tier == "D":
        if depth_missing and skip_d_without_depth:
            skipped = True
            skip_reason = "d_tier_depth_missing"
            evidence.append("D 档缺少盘口深度，默认跳过（不按 K 线形态交易小币）")
        elif depth_thin:
            skipped = True
            skip_reason = "d_tier_depth_thin"
            evidence.append("D 档盘口偏薄，跳过")

    return TierAssignment(
        symbol=n,
        tier=tier,
        label=TIER_LABELS.get(tier, tier),
        mcap_tier=mcap,
        initial_group=initial,
        vol_30d_quote=vol,
        depth=depth,
        depth_missing=depth_missing,
        depth_thin=depth_thin,
        liquidity_overrode=overridden,
        is_equity_token=False,
        skipped=skipped,
        skip_reason=skip_reason,
        evidence=evidence,
    )


def tier_catalog_for_api() -> list[dict[str, Any]]:
    return [
        {"id": tid, "label": TIER_LABELS[tid], "hint": TIER_HINTS[tid]}
        for tid in ("A", "B", "C", "D", "E")
    ]
