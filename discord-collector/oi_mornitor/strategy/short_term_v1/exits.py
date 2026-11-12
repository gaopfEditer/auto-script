"""分批止盈 + 跟踪止盈状态机。

- 止损放在触发结构极值之外加波动缓冲，入场后永不扩大止损，不补仓。
- 到达第一档止盈后，不把剩余仓位自动移到保本。
- 部分止盈后可收紧跟踪，但剩余风险有上限（不得无限放大）。
- 同柱先止损再止盈（悲观口径）。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Iterable

from oi_mornitor.strategy.short_term_v1.params import (
    BREAKEVEN_AFTER_TP1,
    MAX_RESIDUAL_RISK_R,
    SAME_BAR_SL_FIRST,
    TIMEOUT_BARS_5M,
    TRAIL_GIVEBACK_R,
    take_profit_payload,
)


def _is_short(side: str) -> bool:
    return str(side or "").lower() in ("short", "bear", "sell", "空")


def r_distance(entry: float, stop: float) -> float:
    return abs(float(entry) - float(stop))


def price_to_r(price: float, *, entry: float, stop: float, is_short: bool) -> float:
    risk = r_distance(entry, stop)
    if risk <= 0:
        return 0.0
    if is_short:
        return (entry - price) / risk
    return (price - entry) / risk


def r_to_price(r: float, *, entry: float, stop: float, is_short: bool) -> float:
    risk = r_distance(entry, stop)
    if is_short:
        return entry - risk * r
    return entry + risk * r


def _adverse(price_low: float, price_high: float, level: float, *, is_short: bool) -> bool:
    return price_high >= level if is_short else price_low <= level


def _favorable(price_low: float, price_high: float, level: float, *, is_short: bool) -> bool:
    return price_low <= level if is_short else price_high >= level


@dataclass
class ExitState:
    side: str
    entry: float
    initial_stop: float
    current_stop: float
    remaining: float = 1.0
    realized_r: float = 0.0
    realized_frac: float = 0.0  # 已实现仓位比例上的加权 R
    tp_hits: list[dict[str, Any]] = field(default_factory=list)
    done: bool = False
    exit_reason: str | None = None
    exit_price: float | None = None
    mfe_r: float = 0.0
    mae_r: float = 0.0
    bars_held: int = 0
    trail_active: bool = False
    structure_level: float | None = None  # 15m 结构跟踪参考
    moved_to_breakeven: bool = False  # V1 默认应为 False
    widened: bool = False

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d


def init_exit_state(
    *,
    side: str,
    entry: float,
    stop: float,
    structure_level: float | None = None,
) -> ExitState:
    return ExitState(
        side=side,
        entry=float(entry),
        initial_stop=float(stop),
        current_stop=float(stop),
        structure_level=structure_level,
    )


def _tighten_stop(state: ExitState, new_stop: float) -> None:
    """只允许向有利方向收紧，永不扩大。"""
    short = _is_short(state.side)
    if short:
        if new_stop < state.current_stop:
            state.current_stop = new_stop
        elif new_stop > state.current_stop + 1e-12:
            # 试图扩大：拒绝
            state.widened = True  # 标记有人试图扩大，但实际未改
    else:
        if new_stop > state.current_stop:
            state.current_stop = new_stop
        elif new_stop < state.current_stop - 1e-12:
            state.widened = True


def _bound_residual_stop(state: ExitState, tier: str) -> None:
    """剩余仓位的止损不得让剩余风险超过档位上限。"""
    cap = MAX_RESIDUAL_RISK_R.get(tier, 1.0)
    short = _is_short(state.side)
    # 以当前价尚未给出时，用初始风险度量：current_stop 相对 entry 的 R
    cur_r_risk = abs(price_to_r(state.current_stop, entry=state.entry, stop=state.initial_stop, is_short=short))
    # current_stop 在不利侧时 risk 为正的「还可能亏多少 R」
    if short:
        residual = (state.current_stop - state.entry) / r_distance(state.entry, state.initial_stop)
    else:
        residual = (state.entry - state.current_stop) / r_distance(state.entry, state.initial_stop)
    if residual > cap:
        # 收紧到 cap
        bound = r_to_price(-cap, entry=state.entry, stop=state.initial_stop, is_short=short)
        _tighten_stop(state, bound)
    _ = cur_r_risk


def step_bar(
    state: ExitState,
    bar: dict[str, float],
    *,
    targets: list[dict[str, Any]],
    tier: str = "A",
    timeout_bars: int = TIMEOUT_BARS_5M,
    breakeven_after_tp1: bool = BREAKEVEN_AFTER_TP1,
    structure_broken: bool = False,
    structure_stop: float | None = None,
    atr_trail: float | None = None,
    sl_first: bool = SAME_BAR_SL_FIRST,
) -> ExitState:
    """处理一根已完成 K（默认 5m）。同柱先 SL 再 TP。"""
    if state.done or state.remaining <= 1e-12:
        state.done = True
        return state

    short = _is_short(state.side)
    high = float(bar["high"])
    low = float(bar["low"])
    close = float(bar.get("close") or ((high + low) / 2.0))
    state.bars_held += 1

    fav = low if short else high
    adv = high if short else low
    state.mfe_r = max(state.mfe_r, price_to_r(fav, entry=state.entry, stop=state.initial_stop, is_short=short))
    state.mae_r = min(state.mae_r, price_to_r(adv, entry=state.entry, stop=state.initial_stop, is_short=short))

    def _close_at(price: float, reason: str, frac: float | None = None) -> None:
        f = state.remaining if frac is None else min(frac, state.remaining)
        r = price_to_r(price, entry=state.entry, stop=state.initial_stop, is_short=short)
        state.realized_r += r * f
        state.realized_frac += f
        state.remaining = max(0.0, state.remaining - f)
        state.tp_hits.append({"reason": reason, "price": price, "r": r, "closed": f})
        if state.remaining <= 1e-12:
            state.done = True
            state.exit_reason = reason
            state.exit_price = price
            state.remaining = 0.0

    # 1) 止损（同柱优先）
    sl_hit = _adverse(low, high, state.current_stop, is_short=short)
    if sl_hit and sl_first:
        _close_at(state.current_stop, "stop_loss")
        return state

    # 2) 固定 R 止盈档（不包括 trailing）
    fixed = [t for t in targets if not isinstance(t.get("r"), str)]
    # 按 R 从低到高，同柱可连续打到多档（仍在 SL 未优先触发之后）
    for t in sorted(fixed, key=lambda x: float(x["r"])):
        if state.done:
            break
        already = any(h.get("r_level") == float(t["r"]) for h in state.tp_hits)
        if already:
            continue
        level = r_to_price(float(t["r"]), entry=state.entry, stop=state.initial_stop, is_short=short)
        if _favorable(low, high, level, is_short=short):
            frac = float(t.get("close_ratio") or 0.0)
            _close_at(level, f"tp_{t['r']}R", frac=frac)
            if state.tp_hits:
                state.tp_hits[-1]["r_level"] = float(t["r"])
            if breakeven_after_tp1 and not state.moved_to_breakeven:
                # 默认关闭；若显式打开才移动（测试对照）
                _tighten_stop(state, state.entry)
                state.moved_to_breakeven = True
            # 部分止盈后可按剩余风险上限收紧，但默认不移保本
            _bound_residual_stop(state, tier)

    if state.done:
        return state

    # 若同柱也打到止损且 sl_first=False（不推荐），在 TP 之后再处理
    if sl_hit and not sl_first:
        _close_at(state.current_stop, "stop_loss")
        return state

    # 3) 跟踪：结构破坏或 ATR/回吐
    trail_ratio = 0.0
    for t in targets:
        if t.get("r") == "trailing":
            trail_ratio = float(t.get("close_ratio") or 0.0)
    if trail_ratio > 0 and state.remaining > 0:
        state.trail_active = True
        giveback = TRAIL_GIVEBACK_R.get(tier, 0.6)
        # 从 MFE 回吐
        if state.mfe_r > 0 and (state.mfe_r - price_to_r(close, entry=state.entry, stop=state.initial_stop, is_short=short)) >= giveback:
            _close_at(close, "trail_giveback")
            return state
        if structure_broken:
            px = close
            if structure_stop is not None:
                px = float(structure_stop)
            _close_at(px, "structure_break")
            return state
        if atr_trail is not None and atr_trail > 0:
            trail_stop = (close + atr_trail) if short else (close - atr_trail)
            _tighten_stop(state, trail_stop)
            _bound_residual_stop(state, tier)
            if _adverse(low, high, state.current_stop, is_short=short):
                _close_at(state.current_stop, "atr_trail")
                return state
        if structure_stop is not None:
            _tighten_stop(state, float(structure_stop))
            _bound_residual_stop(state, tier)

    # 4) 超时
    if state.bars_held >= timeout_bars and not state.done:
        _close_at(close, "timeout")

    return state


def run_exit_path(
    bars: Iterable[dict[str, float]],
    *,
    side: str,
    entry: float,
    stop: float,
    tier: str = "A",
    per_tier_targets: bool = True,
    timeout_bars: int = TIMEOUT_BARS_5M,
    breakeven_after_tp1: bool = BREAKEVEN_AFTER_TP1,
) -> ExitState:
    targets = take_profit_payload(tier, per_tier=per_tier_targets)
    state = init_exit_state(side=side, entry=entry, stop=stop)
    for bar in bars:
        step_bar(
            state,
            bar,
            targets=targets,
            tier=tier,
            timeout_bars=timeout_bars,
            breakeven_after_tp1=breakeven_after_tp1,
        )
        if state.done:
            break
    if not state.done and state.remaining > 0:
        # 数据结束：按最后收盘平剩余
        last = list(bars)[-1] if not isinstance(bars, list) else (bars[-1] if bars else None)
        # 上面 list(bars) 可能耗尽迭代器；调用方应传 list
    return state
