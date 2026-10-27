"""15m 紧止损出场：现行 composite（trail）与守利润 protect 对照结算。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from oi_mornitor.config import (
    BTC_BACKTEST_FEE_RATE_PER_SIDE,
    BTC_PROTECT_BE_R,
    BTC_PROTECT_EARLY_BARS,
    BTC_PROTECT_EARLY_MIN_MFE_R,
    BTC_PROTECT_LADDER_STEP_R,
    BTC_PROTECT_LADDER_TRAIL_R,
    BTC_PROTECT_MAX_BARS,
    BTC_PROTECT_REV_EXTREME_BARS,
    BTC_PROTECT_TP1_R,
    BTC_TRAIL_BE_R,
    BTC_TRAIL_MAX_BARS,
    BTC_TRAIL_TP1_R,
)

SettlementMode = Literal["entry_sl_tp_trail", "entry_sl_tp_protect"]

SETTLEMENT_LABELS: dict[str, str] = {
    "entry_sl_tp_trail": "现行 composite",
    "entry_sl_tp_protect": "守利润 protect",
}


@dataclass
class OhlcBar:
    ts: int
    open: float
    high: float
    low: float
    close: float


@dataclass
class TradePlan:
    side: str  # long | short
    entry: float
    sl: float
    risk: float
    tick: float = 0.0

    @property
    def is_long(self) -> bool:
        return self.side == "long"


@dataclass
class SimResult:
    settlement: str
    gross_pct: float
    fee_pct: float
    net_pct: float
    exit_reason: str
    bars_held: int
    won: bool
    tp_sl_settled: bool
    expired: bool
    max_favorable_r: float
    giveback_r: float
    partials: list[dict[str, Any]] = field(default_factory=list)


def _tick_size(entry: float) -> float:
    return max(entry * 1e-6, 0.01)


def compute_composite_trade_plan(
    *,
    side: str,
    entry: float,
    sl: float,
) -> TradePlan:
    side_n = "long" if str(side).lower() in ("long", "bull", "buy") else "short"
    risk = abs(entry - sl)
    if risk <= 0:
        risk = entry * 0.005
    return TradePlan(side=side_n, entry=float(entry), sl=float(sl), risk=risk, tick=_tick_size(entry))


def _price_at_r(plan: TradePlan, r_mult: float) -> float:
    if plan.is_long:
        return plan.entry + plan.risk * r_mult
    return plan.entry - plan.risk * r_mult


def _signed_r(plan: TradePlan, price: float) -> float:
    if plan.is_long:
        return (price - plan.entry) / plan.risk
    return (plan.entry - price) / plan.risk


def _fee_pct(notional_frac: float, fee_rate: float) -> float:
    """单边费率 × 开+平（按仓位比例）。"""
    return notional_frac * fee_rate * 2.0 * 100.0


def _ema(values: list[float], span: int) -> list[float | None]:
    if not values:
        return []
    alpha = 2.0 / (span + 1.0)
    out: list[float | None] = []
    ema: float | None = None
    for v in values:
        if ema is None:
            ema = v
        else:
            ema = alpha * v + (1 - alpha) * ema
        out.append(ema)
    return out


def _bar_mfe_mae(plan: TradePlan, bar: OhlcBar) -> tuple[float, float]:
    if plan.is_long:
        return _signed_r(plan, bar.high), _signed_r(plan, bar.low)
    return _signed_r(plan, bar.low), _signed_r(plan, bar.high)


def simulate_tight_sl_outcome(
    plan: TradePlan,
    bars: list[OhlcBar],
    *,
    settlement: SettlementMode = "entry_sl_tp_trail",
    fee_rate: float | None = None,
) -> SimResult:
    """逐 15m 柱模拟；bars[0] 为入场后第一根。"""
    fee = float(fee_rate if fee_rate is not None else BTC_BACKTEST_FEE_RATE_PER_SIDE)
    if not bars:
        return SimResult(
            settlement=settlement,
            gross_pct=0.0,
            fee_pct=0.0,
            net_pct=0.0,
            exit_reason="no_bars",
            bars_held=0,
            won=False,
            tp_sl_settled=False,
            expired=False,
            max_favorable_r=0.0,
            giveback_r=0.0,
        )

    closes = [b.close for b in bars]
    ema13 = _ema(closes, 13)
    ema21 = _ema(closes, 21)
    ema144 = _ema(closes, 144)

    if settlement == "entry_sl_tp_protect":
        return _simulate_protect(plan, bars, ema144, fee)
    return _simulate_trail(plan, bars, ema13, ema21, fee)


def _simulate_trail(
    plan: TradePlan,
    bars: list[OlcBar],
    ema13: list[float | None],
    ema21: list[float | None],
    fee: float,
) -> SimResult:
    sl = plan.sl
    pos = 1.0
    gross = 0.0
    fees = 0.0
    peak_r = 0.0
    tp1_done = False
    be_armed = False
    exit_reason = "expired"
    tp_sl = False
    max_bars = int(BTC_TRAIL_MAX_BARS)

    for i, bar in enumerate(bars[:max_bars]):
        mfe, mae = _bar_mfe_mae(plan, bar)
        peak_r = max(peak_r, mfe)

        if not be_armed and peak_r >= float(BTC_TRAIL_BE_R):
            be_armed = True
            sl = plan.entry + (plan.tick if plan.is_long else -plan.tick)

        hit_sl = (plan.is_long and bar.low <= sl) or (not plan.is_long and bar.high >= sl)
        if hit_sl and pos > 0:
            px = sl
            part = _signed_r(plan, px) * pos
            gross += part * 100.0
            fees += _fee_pct(pos, fee)
            pos = 0.0
            exit_reason = "stop_loss"
            tp_sl = True
            return _finish(
                "entry_sl_tp_trail",
                gross,
                fees,
                exit_reason,
                i + 1,
                tp_sl,
                False,
                peak_r,
                part,
            )

        if not tp1_done and mfe >= float(BTC_TRAIL_TP1_R):
            tp_px = _price_at_r(plan, float(BTC_TRAIL_TP1_R))
            part = float(BTC_TRAIL_TP1_R) * 0.5
            gross += part * 50.0
            fees += _fee_pct(0.5, fee)
            pos = 0.5
            tp1_done = True
            exit_reason = "tp1_partial"

        if pos > 0 and tp1_done:
            e13, e21 = ema13[i], ema21[i]
            if e13 is not None and e21 is not None:
                if plan.is_long and bar.close < min(e13, e21):
                    part = _signed_r(plan, bar.close) * pos
                    gross += part * 100.0
                    fees += _fee_pct(pos, fee)
                    pos = 0.0
                    exit_reason = "ema_runner_exit"
                    tp_sl = True
                    return _finish(
                        "entry_sl_tp_trail",
                        gross,
                        fees,
                        exit_reason,
                        i + 1,
                        tp_sl,
                        False,
                        peak_r,
                        part,
                    )
                if not plan.is_long and bar.close > max(e13, e21):
                    part = _signed_r(plan, bar.close) * pos
                    gross += part * 100.0
                    fees += _fee_pct(pos, fee)
                    pos = 0.0
                    exit_reason = "ema_runner_exit"
                    tp_sl = True
                    return _finish(
                        "entry_sl_tp_trail",
                        gross,
                        fees,
                        exit_reason,
                        i + 1,
                        tp_sl,
                        False,
                        peak_r,
                        part,
                    )

    if pos > 0:
        last = bars[min(len(bars), max_bars) - 1]
        part = _signed_r(plan, last.close) * pos
        gross += part * 100.0
        fees += _fee_pct(pos, fee)
        exit_reason = "expired"
        return _finish(
            "entry_sl_tp_trail",
            gross,
            fees,
            exit_reason,
            min(len(bars), max_bars),
            False,
            True,
            peak_r,
            part,
        )

    return _finish("entry_sl_tp_trail", gross, fees, exit_reason, max_bars, tp_sl, False, peak_r, 0.0)


def _simulate_protect(
    plan: TradePlan,
    bars: list[OhlcBar],
    ema144: list[float | None],
    fee: float,
) -> SimResult:
    sl = plan.sl
    pos = 1.0
    gross = 0.0
    fees = 0.0
    peak_r = 0.0
    tp1_done = False
    be_armed = False
    ladder_anchor_r = 0.0
    exit_reason = "expired"
    tp_sl = False
    max_bars = int(BTC_PROTECT_MAX_BARS)
    early_bars = int(BTC_PROTECT_EARLY_BARS)

    for i, bar in enumerate(bars[:max_bars]):
        mfe, mae = _bar_mfe_mae(plan, bar)
        peak_r = max(peak_r, mfe)

        if i + 1 == early_bars and peak_r < float(BTC_PROTECT_EARLY_MIN_MFE_R) and pos > 0:
            # 前 2h 未到 +0.5R：减半；若仍无进展则本根收盘全平
            if pos >= 1.0:
                part = _signed_r(plan, bar.close) * 0.5
                gross += part * 100.0
                fees += _fee_pct(0.5, fee)
                pos = 0.5
                exit_reason = "early_half_exit"
            else:
                part = _signed_r(plan, bar.close) * pos
                gross += part * 100.0
                fees += _fee_pct(pos, fee)
                pos = 0.0
                exit_reason = "early_flat"
                return _finish(
                    "entry_sl_tp_protect",
                    gross,
                    fees,
                    exit_reason,
                    i + 1,
                    True,
                    False,
                    peak_r,
                    part,
                )

        if not be_armed and peak_r >= float(BTC_PROTECT_BE_R):
            be_armed = True
            sl = plan.entry + (plan.tick if plan.is_long else -plan.tick)

        if tp1_done and pos > 0:
            extra = peak_r - float(BTC_PROTECT_TP1_R)
            if extra > 0:
                steps = int(extra / float(BTC_PROTECT_LADDER_STEP_R))
                target_r = steps * float(BTC_PROTECT_LADDER_TRAIL_R)
                if target_r > ladder_anchor_r:
                    ladder_anchor_r = target_r
                    sl = _price_at_r(plan, ladder_anchor_r)
                    if plan.is_long:
                        sl = max(sl, plan.entry)
                    else:
                        sl = min(sl, plan.entry)
            n = int(BTC_PROTECT_REV_EXTREME_BARS)
            if i >= n - 1:
                window = bars[i - n + 1 : i + 1]
                if plan.is_long:
                    floor = min(b.low for b in window)
                    sl = max(sl, floor)
                else:
                    ceil = max(b.high for b in window)
                    sl = min(sl, ceil)

        hit_sl = (plan.is_long and bar.low <= sl) or (not plan.is_long and bar.high >= sl)
        if hit_sl and pos > 0:
            px = sl
            part = _signed_r(plan, px) * pos
            gross += part * 100.0
            fees += _fee_pct(pos, fee)
            pos = 0.0
            exit_reason = "stop_loss"
            tp_sl = True
            return _finish(
                "entry_sl_tp_protect",
                gross,
                fees,
                exit_reason,
                i + 1,
                tp_sl,
                False,
                peak_r,
                part,
            )

        if not tp1_done and mfe >= float(BTC_PROTECT_TP1_R):
            part = float(BTC_PROTECT_TP1_R) * 0.5
            gross += part * 50.0
            fees += _fee_pct(0.5, fee)
            pos = 0.5
            tp1_done = True
            exit_reason = "tp1_partial"

        if pos > 0 and tp1_done:
            e144 = ema144[i] if i < len(ema144) else None
            if e144 is not None:
                if plan.is_long and bar.close < e144:
                    part = _signed_r(plan, bar.close) * pos
                    gross += part * 100.0
                    fees += _fee_pct(pos, fee)
                    pos = 0.0
                    exit_reason = "ema144_exit"
                    tp_sl = True
                    return _finish(
                        "entry_sl_tp_protect",
                        gross,
                        fees,
                        exit_reason,
                        i + 1,
                        tp_sl,
                        False,
                        peak_r,
                        part,
                    )
                if not plan.is_long and bar.close > e144:
                    part = _signed_r(plan, bar.close) * pos
                    gross += part * 100.0
                    fees += _fee_pct(pos, fee)
                    pos = 0.0
                    exit_reason = "ema144_exit"
                    tp_sl = True
                    return _finish(
                        "entry_sl_tp_protect",
                        gross,
                        fees,
                        exit_reason,
                        i + 1,
                        tp_sl,
                        False,
                        peak_r,
                        part,
                    )

    if pos > 0:
        last = bars[min(len(bars), max_bars) - 1]
        part = _signed_r(plan, last.close) * pos
        gross += part * 100.0
        fees += _fee_pct(pos, fee)
        return _finish(
            "entry_sl_tp_protect",
            gross,
            fees,
            "expired",
            min(len(bars), max_bars),
            False,
            True,
            peak_r,
            part,
        )

    return _finish("entry_sl_tp_protect", gross, fees, exit_reason, max_bars, tp_sl, False, peak_r, 0.0)


def _finish(
    settlement: str,
    gross: float,
    fees: float,
    reason: str,
    bars: int,
    tp_sl: bool,
    expired: bool,
    peak_r: float,
    final_r: float,
) -> SimResult:
    giveback = max(0.0, peak_r - final_r)
    net = gross - fees
    won = net > 0
    return SimResult(
        settlement=settlement,
        gross_pct=round(gross, 4),
        fee_pct=round(fees, 4),
        net_pct=round(net, 4),
        exit_reason=reason,
        bars_held=bars,
        won=won,
        tp_sl_settled=tp_sl or reason.startswith("tp"),
        expired=expired,
        max_favorable_r=round(peak_r, 4),
        giveback_r=round(giveback, 4),
    )


def evaluate_future_outcome(
    plan: TradePlan,
    bars: list[OlcBar],
    *,
    horizon_bars: int,
) -> bool | None:
    """Horizon 胜率：入场后第 N 根收盘价方向（不走 TP/SL）。"""
    if horizon_bars <= 0 or len(bars) < horizon_bars:
        return None
    close = bars[horizon_bars - 1].close
    if plan.is_long:
        return close > plan.entry
    return close < plan.entry


def summarize_sim_results(results: list[SimResult]) -> dict[str, Any]:
    if not results:
        return {"count": 0}
    n = len(results)
    wins = sum(1 for r in results if r.won)
    tp_sl_wins = sum(1 for r in results if r.tp_sl_settled and r.won)
    tp_sl_n = sum(1 for r in results if r.tp_sl_settled)
    expired = sum(1 for r in results if r.expired)
    gross = sum(r.gross_pct for r in results)
    fees = sum(r.fee_pct for r in results)
    net = sum(r.net_pct for r in results)
    giveback = sum(r.giveback_r for r in results) / n
    return {
        "count": n,
        "wins": wins,
        "losses": n - wins,
        "win_rate": round(wins / n, 4) if n else None,
        "tp_sl_settle_win_rate": round(tp_sl_wins / tp_sl_n, 4) if tp_sl_n else None,
        "tp_sl_settled": tp_sl_n,
        "expired_ratio": round(expired / n, 4),
        "gross_pct_sum": round(gross, 4),
        "fee_pct_sum": round(fees, 4),
        "net_pct_sum": round(net, 4),
        "avg_giveback_r": round(giveback, 4),
    }
