"""形态信号分批纸面结算：TP 3/7/12/17% · 15m 步进核实 · 三档仓位 + Runner 跟踪止盈。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.pattern_alert_stats import _rec_pnl_pct

# 核实：每 15m 一步，最长 3h（12 根 15m）
_VERIFY_INTERVAL_MS = 15 * 60 * 1000
_VERIFY_DELAY_MS = 3 * 60 * 60 * 1000

# 分批 TP（价格变动 %）与仓位权重
TP_LEVELS_PCT = (3.0, 7.0, 12.0, 17.0)
TP1_PCT, TP2_PCT = TP_LEVELS_PCT[0], TP_LEVELS_PCT[1]
BATCH_WEIGHTS = (0.30, 0.30, 0.40)  # TP1 / TP2 / Runner
DEFAULT_SL_PCT = 5.0
RUNNER_TRAIL_PCT = 5.0  # Runner：从极值回撤 5% 触发（多单上移线 / 空单下移线）

# 兼容旧引用
_DEFAULT_TP_SL_PCT = TP1_PCT


def settle_rules_summary() -> str:
    return (
        "BTC/ETH/SOL 100x · 山寨 20x · TP 3%/7% 分批 30%+30% · Runner 40% 跟踪止盈 · "
        "止损 ±5% · 信号后每 15m 核实 · 最长 3h · 未平则按窗口末价"
    )


def price_move_pct(entry: float, price: float, *, is_short: bool) -> float:
    if entry <= 0:
        return 0.0
    if is_short:
        return (entry - price) / entry * 100.0
    return (price - entry) / entry * 100.0


def _align_factor(ref: float, entry: float) -> float:
    if not (ref > 0 and entry > 0):
        return 1.0
    ratio = ref / entry
    if ratio > 50 or ratio < 0.02:
        p = 10 ** round(__import__("math").log10(ratio))
        return p if abs(ratio / p - 1) < abs(ratio - 1) else ratio
    return 1.0


def _align_bars(bars: list[dict[str, float]], entry: float) -> list[dict[str, float]]:
    if not bars or entry <= 0:
        return bars
    samples = sorted(b["close"] for b in bars[:8] if b["close"] > 0)
    if not samples:
        return bars
    mid = samples[len(samples) // 2]
    factor = _align_factor(mid, entry)
    if factor == 1.0:
        return bars
    return [
        {"ts": b["ts"], "high": b["high"] * factor, "low": b["low"] * factor, "close": b["close"] * factor}
        for b in bars
    ]


def _aggregate_to_15m(bars: list[dict[str, float]]) -> list[dict[str, float]]:
    """5m → 15m 聚合（回测侧仍可用 5m 数据源）。"""
    if len(bars) < 2:
        return bars
    deltas = [bars[i + 1]["ts"] - bars[i]["ts"] for i in range(min(8, len(bars) - 1))]
    med = sorted(deltas)[len(deltas) // 2]
    if med >= 14 * 60_000:
        return bars
    bucket_ms = 15 * 60_000
    buckets: dict[int, dict[str, float]] = {}
    for b in bars:
        key = int(b["ts"] // bucket_ms)
        cur = buckets.get(key)
        if cur is None:
            buckets[key] = {"ts": key * bucket_ms, "high": b["high"], "low": b["low"], "close": b["close"]}
        else:
            cur["high"] = max(cur["high"], b["high"])
            cur["low"] = min(cur["low"], b["low"])
            cur["close"] = b["close"]
    return [buckets[k] for k in sorted(buckets.keys())]


def _tp_price(entry: float, pct: float, *, is_short: bool) -> float:
    step = pct / 100.0
    return entry * (1 - step) if is_short else entry * (1 + step)


def _sl_price(entry: float, pct: float, *, is_short: bool) -> float:
    step = pct / 100.0
    return entry * (1 + step) if is_short else entry * (1 - step)


def settle_signal_batch(
    *,
    side: str,
    entry: float,
    symbol: str,
    signal_at_ms: int,
    bars: list[dict[str, float]],
    sl_pct: float = DEFAULT_SL_PCT,
    verify_delay_ms: int = _VERIFY_DELAY_MS,
    now_ms: int | None = None,
) -> dict[str, Any]:
    """
    三档分批 + Runner 跟踪止盈。
    返回 outcome / movePct（加权价格变动%）/ exitPrice / pnlPct 等。
    """
    is_short = side in ("short", "bear")
    tp1 = _tp_price(entry, TP1_PCT, is_short=is_short)
    tp2 = _tp_price(entry, TP2_PCT, is_short=is_short)
    sl = _sl_price(entry, sl_pct, is_short=is_short)
    verify_at = signal_at_ms + verify_delay_ms
    now = verify_at if now_ms is None else min(now_ms, verify_at)

    aligned = _aggregate_to_15m(_align_bars(bars, entry))
    sorted_bars = [
        b for b in sorted(aligned, key=lambda x: x["ts"]) if signal_at_ms - 1 <= b["ts"] <= now + 60_000
    ]

    rem = list(BATCH_WEIGHTS)
    weighted_move = 0.0
    runner_active = False
    extreme = entry
    runner_stop: float | None = None
    exit_price = entry
    hit_at: int | None = None

    def _finish(outcome: str, *, move: float, price: float, at: int | None) -> dict[str, Any]:
        rec: dict[str, Any] = {
            "outcome": outcome,
            "exitPrice": price,
            "movePct": move,
            "hitAt": at,
            "verifiedAt": now,
            "stepPct": TP1_PCT,
            "tpLevels": list(TP_LEVELS_PCT),
            "batchWeights": list(BATCH_WEIGHTS),
            "side": "short" if is_short else "long",
            "entry": entry,
            "symbol": symbol,
            "tradeSymbol": symbol,
        }
        rec["pnlPct"] = _rec_pnl_pct(rec)
        return rec

    for bar in sorted_bars:
        remaining = sum(rem)
        if remaining <= 1e-9:
            break

        # 1) 全仓剩余止损
        sl_hit = bar["high"] >= sl if is_short else bar["low"] <= sl
        if sl_hit:
            move = price_move_pct(entry, sl, is_short=is_short)
            weighted_move += move * remaining
            rem = [0.0, 0.0, 0.0]
            exit_price = sl
            hit_at = int(bar["ts"])
            break

        # 2) TP1 30%
        if rem[0] > 0:
            tp_hit = bar["low"] <= tp1 if is_short else bar["high"] >= tp1
            if tp_hit:
                move = price_move_pct(entry, tp1, is_short=is_short)
                weighted_move += move * rem[0]
                rem[0] = 0.0

        # 3) TP2 30%
        if rem[1] > 0:
            tp_hit = bar["low"] <= tp2 if is_short else bar["high"] >= tp2
            if tp_hit:
                move = price_move_pct(entry, tp2, is_short=is_short)
                weighted_move += move * rem[1]
                rem[1] = 0.0
                runner_active = True

        # 4) Runner 40% — 达 7% 后启动跟踪；多单上移止损线 / 空单下移
        if rem[2] > 0:
            if not runner_active:
                act = bar["low"] <= tp2 if is_short else bar["high"] >= tp2
                if act:
                    runner_active = True
            if runner_active:
                if is_short:
                    extreme = min(extreme, bar["low"])
                    new_stop = extreme * (1 + RUNNER_TRAIL_PCT / 100.0)
                    runner_stop = new_stop if runner_stop is None else min(runner_stop, new_stop)
                    if bar["high"] >= runner_stop:
                        move = price_move_pct(entry, runner_stop, is_short=True)
                        weighted_move += move * rem[2]
                        rem[2] = 0.0
                        exit_price = runner_stop
                        hit_at = int(bar["ts"])
                else:
                    extreme = max(extreme, bar["high"])
                    new_stop = extreme * (1 - RUNNER_TRAIL_PCT / 100.0)
                    runner_stop = new_stop if runner_stop is None else max(runner_stop, new_stop)
                    if bar["low"] <= runner_stop:
                        move = price_move_pct(entry, runner_stop, is_short=False)
                        weighted_move += move * rem[2]
                        rem[2] = 0.0
                        exit_price = runner_stop
                        hit_at = int(bar["ts"])

    remaining = sum(rem)
    if remaining > 1e-9 and now < verify_at:
        return {"outcome": "pending", "entry": entry, "symbol": symbol, "pnlPct": None}

    if remaining > 1e-9:
        if not sorted_bars:
            return {"outcome": "error", "error": "no_klines", "entry": entry, "symbol": symbol, "pnlPct": None}
        last = sorted_bars[-1]
        move = price_move_pct(entry, last["close"], is_short=is_short)
        weighted_move += move * remaining
        exit_price = last["close"]
        hit_at = int(last["ts"])

    if abs(weighted_move) < 1e-4:
        return _finish("flat", move=weighted_move, price=exit_price, at=hit_at)
    outcome = "take_profit" if weighted_move > 0 else "stop_loss"
    return _finish(outcome, move=weighted_move, price=exit_price, at=hit_at)


def settle_signal_by_5m_bars(
    *,
    side: str,
    entry: float,
    symbol: str,
    signal_at_ms: int,
    bars_5m: list[dict[str, float]],
    step_pct: float = TP1_PCT,
    verify_delay_ms: int = _VERIFY_DELAY_MS,
    now_ms: int | None = None,
) -> dict[str, Any]:
    """兼容旧名：内部聚合 15m 后走分批结算。"""
    del step_pct  # 旧 ±5% 单档已废弃
    return settle_signal_batch(
        side=side,
        entry=entry,
        symbol=symbol,
        signal_at_ms=signal_at_ms,
        bars=bars_5m,
        verify_delay_ms=verify_delay_ms,
        now_ms=now_ms,
    )
