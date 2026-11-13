"""V2 引擎：独立扫描各策略，不叠加进 V1；可与 V1 并行产出。"""
from __future__ import annotations

from typing import Any, Iterable, Sequence

import pandas as pd

from oi_mornitor.strategy.short_term_v2.common import BarContext
from oi_mornitor.strategy.short_term_v2.metrics import bar_ts, precompute_indicators
from oi_mornitor.strategy.short_term_v2.params import (
    BATCH1_STRATEGIES,
    DEDUP_BARS,
    DEFAULT_FEE_PCT,
    DEFAULT_SLIP_PCT,
    RESEARCH_DISCLAIMER,
    STRATEGY_VERSION,
    TIMEOUT_BARS_15M,
    defaults_dict,
)
from oi_mornitor.strategy.short_term_v2.quality_gate import (
    DEFAULT_GATE_MODE,
    DEFAULT_MIN_SCORE_TIER,
    apply_quality_gate,
)
from oi_mornitor.strategy.short_term_v2.signal import V2Signal
from oi_mornitor.strategy.short_term_v2.strategies import enabled_scanners
from oi_mornitor.strategy.short_term_v2.tiers import classify_v2_tier


def _dedupe_key(sig: V2Signal) -> tuple:
    return (
        sig.signal_type,
        sig.direction or "",
        round(float(sig.structure_level or 0), 8),
        int(sig.trigger_idx or -1) // max(DEDUP_BARS, 1),
    )


def merge_duplicate_triggers(signals: list[V2Signal]) -> list[V2Signal]:
    """同一机会重复触发合并（§十六）。保留首次 entry_ready，观察事件可并存。"""
    best: dict[tuple, V2Signal] = {}
    order: list[tuple] = []
    for s in signals:
        k = _dedupe_key(s)
        if k not in best:
            best[k] = s
            order.append(k)
            continue
        cur = best[k]
        rank = {"entry_ready": 3, "confirmed": 2, "triggered": 1, "observe": 0, "skipped": -1, "traded": 4}
        if rank.get(s.status, 0) > rank.get(cur.status, 0):
            best[k] = s
    return [best[k] for k in order]


def simulate_exit(sig: V2Signal, df_15m: pd.DataFrame, *, fee_pct: float, slip_pct: float) -> V2Signal:
    """简单出场：止损 / 止盈 / 超时；填写 MAE/MFE/净收益。不使用入场后未来之外的信息以外的根。"""
    if sig.status != "entry_ready" or sig.entry_idx is None or sig.entry_price is None:
        return sig
    if sig.stop_price is None or sig.target_price is None or sig.direction is None:
        return sig
    start = int(sig.entry_idx) + 1
    end = min(len(df_15m), start + TIMEOUT_BARS_15M)
    entry = float(sig.entry_price)
    stop = float(sig.stop_price)
    target = float(sig.target_price)
    short = sig.direction == "short"
    mae = 0.0
    mfe = 0.0
    exit_price = None
    exit_idx = None
    reason = "timeout"
    for i in range(start, end):
        row = df_15m.iloc[i]
        h, l, c = float(row["high"]), float(row["low"]), float(row["close"])
        if short:
            fav = (entry - l) / entry
            adv = (h - entry) / entry
            hit_stop = h >= stop
            hit_tp = l <= target
        else:
            fav = (h - entry) / entry
            adv = (entry - l) / entry
            hit_stop = l <= stop
            hit_tp = h >= target
        mfe = max(mfe, fav)
        mae = max(mae, adv)
        # 同柱先止损
        if hit_stop:
            exit_price = stop
            exit_idx = i
            reason = "stop"
            break
        if hit_tp:
            exit_price = target
            exit_idx = i
            reason = "target"
            break
    if exit_price is None:
        if end > start:
            exit_idx = end - 1
            exit_price = float(df_15m.iloc[exit_idx]["close"])
        else:
            return sig
    raw = (entry - exit_price) / entry if short else (exit_price - entry) / entry
    cost = (fee_pct + slip_pct) * 2 / 100.0
    sig.price_return = raw * 100.0
    sig.net_return = (raw - cost) * 100.0
    sig.MAE = mae * 100.0
    sig.MFE = mfe * 100.0
    sig.exit_reason = reason
    sig.exit_idx = exit_idx
    sig.exit_price = exit_price
    sig.status = "traded"
    return sig


def collect_signals_on_frames(
    *,
    symbol: str,
    df_15m: pd.DataFrame,
    df_1h: pd.DataFrame | None = None,
    df_4h: pd.DataFrame | None = None,
    df_1d: pd.DataFrame | None = None,
    df_btc_15m: pd.DataFrame | None = None,
    liq_events: list[dict[str, Any]] | None = None,
    strategies: Sequence[str] | None = None,
    include_batch2: bool = False,
    start_idx: int = 80,
    vol_30d_quote: float | None = None,
    depth: float | None = None,
    spread_pct: float | None = None,
    event_flags: dict[str, Any] | None = None,
    fee_pct: float = DEFAULT_FEE_PCT,
    slip_pct: float = DEFAULT_SLIP_PCT,
    simulate: bool = True,
    quality_gate: bool = True,
    min_score_tier: str = DEFAULT_MIN_SCORE_TIER,
    gate_mode: str = DEFAULT_GATE_MODE,
) -> dict[str, Any]:
    """扫描单币 V2 信号。所有触发（含 skip/observe）均记录。

    quality_gate：15m 机会形成；默认 and = 多周期共振 AND 评分≥min_score_tier；
    gate_mode=or 时为共振 OR 评分。
    """
    tier = classify_v2_tier(
        symbol,
        vol_30d_quote=vol_30d_quote,
        depth=depth,
        spread_pct=spread_pct,
        df=df_15m,
    )
    scanners = enabled_scanners(strategies=list(strategies) if strategies else None, include_batch2=include_batch2)
    raw: list[V2Signal] = []
    n = len(df_15m) if df_15m is not None else 0
    if n < start_idx + 2 or tier.skipped:
        return {
            "symbol": symbol,
            "strategyVersion": STRATEGY_VERSION,
            "tier": tier.to_dict(),
            "signals": [],
            "counts": {"total": 0},
            "disclaimer": RESEARCH_DISCLAIMER,
        }

    # 指标一次预计算：S05 等策略若按根重算 ATR% 会变成 O(n²)，3 个月 15m 可跑几十分钟
    precompute_indicators(df_15m)
    if df_1h is not None and len(df_1h):
        precompute_indicators(df_1h)
    if df_4h is not None and len(df_4h):
        precompute_indicators(df_4h)
    if df_btc_15m is not None and len(df_btc_15m):
        precompute_indicators(df_btc_15m)

    progress_every = max(500, (n - start_idx) // 10)
    for i in range(start_idx, n - 1):
        if (i - start_idx) % progress_every == 0:
            print(f"[stv2] {symbol}: bar {i}/{n - 1}", flush=True)
        ctx = BarContext(
            symbol=symbol,
            tier=tier,
            idx=i,
            df_15m=df_15m,
            df_1h=df_1h,
            df_4h=df_4h,
            df_1d=df_1d,
            df_btc_15m=df_btc_15m,
            liq_events=liq_events,
            event_flags=dict(event_flags or {}),
            fee_pct=fee_pct,
            slip_pct=slip_pct,
        )
        bar_got: list[V2Signal] = []
        for sid, fn in scanners.items():
            try:
                got = fn(ctx) or []
            except Exception as exc:  # noqa: BLE001 — 单策略失败不影响其他
                got = [V2Signal(
                    signal_type=sid,
                    market_cap_tier=tier.market_cap_tier,
                    symbol=symbol,
                    status="skipped",
                    skip_reason=f"scanner_error:{type(exc).__name__}",
                    trigger_idx=i,
                    trigger_time=bar_ts(df_15m, i),
                    evidence=[str(exc)[:200]],
                )]
            bar_got.extend(got)
        # 质量闸按根施加（需 BarContext 对齐 1h/4h）
        bar_got = apply_quality_gate(
            ctx,
            bar_got,
            enabled=quality_gate,
            min_score_tier=min_score_tier,
            gate_mode=gate_mode,
        )
        raw.extend(bar_got)

    merged = merge_duplicate_triggers(raw)
    if simulate:
        merged = [
            simulate_exit(s, df_15m, fee_pct=fee_pct, slip_pct=slip_pct)
            if s.status == "entry_ready"
            else s
            for s in merged
        ]

    by_type: dict[str, int] = {}
    by_status: dict[str, int] = {}
    traded = []
    for s in merged:
        by_type[s.signal_type] = by_type.get(s.signal_type, 0) + 1
        by_status[s.status] = by_status.get(s.status, 0) + 1
        if s.status == "traded":
            traded.append(s)

    nets = [float(s.net_return) for s in traded if s.net_return is not None]
    wins = [x for x in nets if x > 0]
    losses = [x for x in nets if x <= 0]
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    pf = (gross_win / gross_loss) if gross_loss > 0 else (None if gross_win <= 0 else float("inf"))
    return {
        "symbol": symbol,
        "strategyVersion": STRATEGY_VERSION,
        "tier": tier.to_dict(),
        "signals": [s.to_dict() for s in merged],
        "traded": [s.to_dict() for s in traded],
        "counts": {
            "total": len(merged),
            "byType": by_type,
            "byStatus": by_status,
            "traded": len(traded),
        },
        "stats": {
            "netReturnSumPct": round(sum(nets), 4) if nets else 0.0,
            "expectancyPct": round(sum(nets) / len(nets), 4) if nets else None,
            "winRate": round(len(wins) / len(nets), 4) if nets else None,
            "profitFactor": (round(pf, 4) if isinstance(pf, float) else pf),
            "n": len(nets),
        },
        "enabledStrategies": list(scanners.keys()),
        "disclaimer": RESEARCH_DISCLAIMER,
        "params": defaults_dict(),
        "qualityGate": {
            "enabled": bool(quality_gate),
            "mode": str(gate_mode or DEFAULT_GATE_MODE).lower(),
            "setupTf": "15m",
            "minScoreTier": str(min_score_tier).upper(),
        },
    }


def merge_v2_symbol_results(results: Iterable[dict[str, Any]]) -> dict[str, Any]:
    rows = list(results)
    all_signals: list[dict[str, Any]] = []
    all_traded: list[dict[str, Any]] = []
    by_type: dict[str, int] = {}
    by_status: dict[str, int] = {}
    for r in rows:
        for s in r.get("signals") or []:
            all_signals.append(s)
            by_type[s["signal_type"]] = by_type.get(s["signal_type"], 0) + 1
            by_status[s.get("status") or ""] = by_status.get(s.get("status") or "", 0) + 1
        all_traded.extend(r.get("traded") or [])
    nets = [float(s["net_return"]) for s in all_traded if s.get("net_return") is not None]
    wins = [x for x in nets if x > 0]
    losses = [x for x in nets if x <= 0]
    gw, gl = sum(wins), abs(sum(losses))
    pf = (gw / gl) if gl > 0 else (None if gw <= 0 else float("inf"))
    return {
        "strategyVersion": STRATEGY_VERSION,
        "symbols": [r.get("symbol") for r in rows],
        "signals": all_signals,
        "traded": all_traded,
        "counts": {"total": len(all_signals), "byType": by_type, "byStatus": by_status, "traded": len(all_traded)},
        "stats": {
            "netReturnSumPct": round(sum(nets), 4) if nets else 0.0,
            "expectancyPct": round(sum(nets) / len(nets), 4) if nets else None,
            "winRate": round(len(wins) / len(nets), 4) if nets else None,
            "profitFactor": (round(pf, 4) if isinstance(pf, float) else pf),
            "n": len(nets),
        },
        "perSymbol": [{
            "symbol": r.get("symbol"),
            "counts": r.get("counts"),
            "stats": r.get("stats"),
            "tier": r.get("tier"),
        } for r in rows],
        "disclaimer": RESEARCH_DISCLAIMER,
        "defaultBatch1": list(BATCH1_STRATEGIES),
    }
