"""放弃 / 观望规则：一等公民过滤器，不是注释。"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Iterable

import pandas as pd


@dataclass
class AbortHit:
    rule: str
    triggered: bool
    action: str  # skip / wait / size_down / stand_aside
    reason: str
    data_missing: bool = False
    data_flag: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AbortContext:
    symbol: str = ""
    tier: str = ""
    direction: str | None = None  # long / short
    is_btc: bool = False
    btc_regime_4h: str | None = None
    btc_return: float | None = None
    coin_return: float | None = None
    rs_lookback_bars: int = 12
    alt_spike: bool = False
    alt_spike_pct: float | None = None
    oi_change_pct: float | None = None
    price_range_atr: float | None = None
    oi_available: bool = False
    is_breakout: bool = False
    breakout_volume_ok: bool | None = None
    depth: float | None = None
    depth_ref: float | None = None
    depth_available: bool = False
    funding_rate: float | None = None  # 8h 口径小数，如 0.001 = 0.1%
    funding_available: bool = False
    crowded_side: str | None = None  # long / short
    upper_wick_ratio: float | None = None  # 上影 / 振幅
    upper_wick_vs_atr: float | None = None
    is_equity: bool = False
    depeg_pct: float | None = None  # 相对底层绝对值
    underlying_available: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# 阈值（研究起点）
ALT_SPIKE_PCT = 0.08  # 山寨短窗涨幅
OI_FAST_RISE_PCT = 0.03
PRICE_STALL_ATR = 0.35
DEPTH_DROP_RATIO = 0.50
EXTREME_FUNDING = 0.0005  # 0.05% / 8h
HUGE_UPPER_WICK = 0.55
HUGE_WICK_ATR = 1.5
RS_LAG_THRESHOLD = -0.02  # 相对 BTC 累计落后
DEPEG_PCT = 0.02


def _side(direction: str | None) -> str:
    s = str(direction or "").lower()
    if s in ("bull", "long", "buy", "多"):
        return "long"
    if s in ("bear", "short", "sell", "空"):
        return "short"
    return s


def rule_btc_4h_down_alt_spike(ctx: AbortContext) -> AbortHit:
    """BTC 4H 下跌 + 山寨突然暴涨：不追高。"""
    if ctx.is_btc:
        return AbortHit("btc_4h_down_alt_spike", False, "ok", "标的是 BTC，本规则不适用")
    r4 = str(ctx.btc_regime_4h or "").lower()
    btc_down = r4 in ("trend_down", "downtrend", "down") or (
        ctx.btc_return is not None and ctx.btc_return < 0 and r4 in ("trend_down", "downtrend", "down", "")
    )
    if r4 in ("trend_down", "downtrend", "down") and ctx.alt_spike:
        return AbortHit(
            "btc_4h_down_alt_spike",
            True,
            "skip",
            "BTC 4H 下跌而山寨突然暴涨，不追高",
        )
    if r4 in ("trend_down", "downtrend", "down") and ctx.alt_spike_pct is not None and ctx.alt_spike_pct >= ALT_SPIKE_PCT:
        return AbortHit(
            "btc_4h_down_alt_spike",
            True,
            "skip",
            f"BTC 4H 下跌且山寨短窗涨幅 {ctx.alt_spike_pct:.1%}，不追高",
        )
    return AbortHit("btc_4h_down_alt_spike", False, "ok", "未触发" if btc_down or r4 else "未触发")


def rule_btc_up_laggard_long(ctx: AbortContext) -> AbortHit:
    """BTC 上涨但该币持续跑输：不盲目做多。"""
    if ctx.is_btc:
        return AbortHit("btc_up_laggard_long", False, "ok", "标的是 BTC")
    if _side(ctx.direction) != "long":
        return AbortHit("btc_up_laggard_long", False, "ok", "非做多，本规则不拦截")
    btc_up = str(ctx.btc_regime_4h or "").lower() in ("trend_up", "uptrend", "up") or (
        ctx.btc_return is not None and ctx.btc_return > 0
    )
    if not btc_up:
        return AbortHit("btc_up_laggard_long", False, "ok", "BTC 非上涨")
    if ctx.btc_return is None or ctx.coin_return is None:
        return AbortHit(
            "btc_up_laggard_long",
            False,
            "ok",
            "相对强弱收益缺失，不静默拦截",
            data_missing=True,
            data_flag="rs_returns_missing",
        )
    rel = ctx.coin_return - ctx.btc_return
    if rel <= RS_LAG_THRESHOLD:
        return AbortHit(
            "btc_up_laggard_long",
            True,
            "skip",
            f"BTC 上涨但该币相对落后 {rel:.2%}，不盲目做多",
        )
    return AbortHit("btc_up_laggard_long", False, "ok", "相对强弱未持续落后")


def rule_oi_rise_price_stall(ctx: AbortContext) -> AbortHit:
    """OI 快速上升而价格停滞：等待方向，不猜多空。"""
    if not ctx.oi_available or ctx.oi_change_pct is None:
        return AbortHit(
            "oi_rise_price_stall",
            False,
            "ok",
            "OI 序列缺失，本规则跳过并标记",
            data_missing=True,
            data_flag="oi_missing",
        )
    stall = ctx.price_range_atr is not None and ctx.price_range_atr <= PRICE_STALL_ATR
    if ctx.oi_change_pct >= OI_FAST_RISE_PCT and stall:
        return AbortHit(
            "oi_rise_price_stall",
            True,
            "wait",
            f"OI 上升 {ctx.oi_change_pct:.1%} 而价格停滞（振幅 {ctx.price_range_atr:.2f}×ATR），等待方向",
        )
    return AbortHit("oi_rise_price_stall", False, "ok", "未触发")


def rule_breakout_no_volume(ctx: AbortContext) -> AbortHit:
    """价格突破但成交量不支持：不追突破，等待回踩。"""
    if not ctx.is_breakout:
        return AbortHit("breakout_no_volume", False, "ok", "非突破情境")
    if ctx.breakout_volume_ok is None:
        return AbortHit(
            "breakout_no_volume",
            False,
            "ok",
            "成交量确认缺失，不静默当作放量",
            data_missing=True,
            data_flag="volume_confirm_missing",
        )
    if ctx.breakout_volume_ok is False:
        return AbortHit(
            "breakout_no_volume",
            True,
            "skip",
            "突破缺少成交量支持，不追；等待回踩",
        )
    return AbortHit("breakout_no_volume", False, "ok", "突破成交量支持")


def rule_book_depth_thin(ctx: AbortContext) -> AbortHit:
    """盘口深度突然下降：降低仓位或取消。深度不可用则跳过本规则并标记。"""
    if not ctx.depth_available or ctx.depth is None:
        return AbortHit(
            "book_depth_thin",
            False,
            "ok",
            "盘口深度不可用，跳过本规则并标记 depth_missing",
            data_missing=True,
            data_flag="depth_missing",
        )
    ref = ctx.depth_ref
    thin = ctx.depth <= 0 or (ref is not None and ref > 0 and ctx.depth < ref * DEPTH_DROP_RATIO)
    if thin:
        action = "skip" if ctx.tier in ("C", "D") else "size_down"
        return AbortHit("book_depth_thin", True, action, "盘口深度突然下降，降低仓位或取消交易")
    return AbortHit("book_depth_thin", False, "ok", "盘口深度尚可")


def rule_extreme_funding_crowded(ctx: AbortContext) -> AbortHit:
    """资金费率极端且一侧拥挤：降低追单意愿。无资金费序列则标记并跳过。"""
    if not ctx.funding_available or ctx.funding_rate is None:
        return AbortHit(
            "extreme_funding_crowded",
            False,
            "ok",
            "资金费率序列缺失，不虚构、不拦截",
            data_missing=True,
            data_flag="funding_missing",
        )
    rate = ctx.funding_rate
    side = _side(ctx.direction)
    crowded = ctx.crowded_side
    extreme = abs(rate) >= EXTREME_FUNDING
    # 正费率拥挤多头时不追多；负费率拥挤空头时不追空
    chase_crowded = (
        (side == "long" and rate >= EXTREME_FUNDING and (crowded in (None, "long")))
        or (side == "short" and rate <= -EXTREME_FUNDING and (crowded in (None, "short")))
    )
    if extreme and chase_crowded:
        return AbortHit(
            "extreme_funding_crowded",
            True,
            "skip",
            f"资金费率极端（{rate:.4%}）且与追单方向同侧拥挤，降低追单意愿",
        )
    return AbortHit("extreme_funding_crowded", False, "ok", "未触发")


def rule_small_cap_huge_upper_wick(ctx: AbortContext) -> AbortHit:
    """小币巨大长上影：不立即抄底/反向，等待重新站回结构。"""
    if ctx.tier != "D":
        return AbortHit("small_cap_huge_upper_wick", False, "ok", "非 D 档")
    wick = ctx.upper_wick_ratio
    wick_atr = ctx.upper_wick_vs_atr
    huge = (wick is not None and wick >= HUGE_UPPER_WICK) or (
        wick_atr is not None and wick_atr >= HUGE_WICK_ATR
    )
    if huge:
        return AbortHit(
            "small_cap_huge_upper_wick",
            True,
            "skip",
            "小币出现巨大长上影，不立即抄底或反向，等待结构收回",
        )
    return AbortHit("small_cap_huge_upper_wick", False, "ok", "未触发")


def rule_equity_depeg(ctx: AbortContext) -> AbortHit:
    """美股代币：V1 默认跳过；若有底层价格且明显脱锚也跳过。"""
    if not ctx.is_equity:
        return AbortHit("equity_depeg", False, "ok", "非美股代币")
    if ctx.underlying_available and ctx.depeg_pct is not None and ctx.depeg_pct >= DEPEG_PCT:
        return AbortHit(
            "equity_depeg",
            True,
            "skip",
            f"美股代币相对底层脱锚 {ctx.depeg_pct:.1%}，暂停交易",
        )
    return AbortHit(
        "equity_depeg",
        True,
        "skip",
        "美股代币 V1 默认排除，不套用加密参数",
        data_missing=not ctx.underlying_available,
        data_flag="underlying_missing" if not ctx.underlying_available else None,
    )


ALL_RULES = (
    rule_btc_4h_down_alt_spike,
    rule_btc_up_laggard_long,
    rule_oi_rise_price_stall,
    rule_breakout_no_volume,
    rule_book_depth_thin,
    rule_extreme_funding_crowded,
    rule_small_cap_huge_upper_wick,
    rule_equity_depeg,
)


def evaluate_aborts(ctx: AbortContext) -> list[AbortHit]:
    return [fn(ctx) for fn in ALL_RULES]


def blocking_hits(hits: Iterable[AbortHit]) -> list[AbortHit]:
    return [h for h in hits if h.triggered and h.action in ("skip", "wait", "stand_aside")]


def size_down_hits(hits: Iterable[AbortHit]) -> list[AbortHit]:
    return [h for h in hits if h.triggered and h.action == "size_down"]


def first_block_reason(hits: Iterable[AbortHit]) -> str | None:
    blocked = blocking_hits(hits)
    return blocked[0].reason if blocked else None
