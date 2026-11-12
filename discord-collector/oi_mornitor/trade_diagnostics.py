"""每笔交易出场诊断：MFE/MAE、TP 命中、强平、持仓时间；导出与审计报告。"""
from __future__ import annotations

import csv
import json
import statistics
from pathlib import Path
from typing import Any, Iterable

from oi_mornitor.trade_leverage import (
    FUNDING_MODELED,
    FUNDING_NOTE,
    audit_assumptions,
    leverage_for_symbol,
)


def _price_move_pct(entry: float, price: float, *, is_short: bool) -> float:
    if entry <= 0:
        return 0.0
    if is_short:
        return (entry - price) / entry * 100.0
    return (price - entry) / entry * 100.0


DIAGNOSTIC_FIELDS = (
    "exitReason",
    "mfePct",
    "maePct",
    "mfeR",
    "maeR",
    "tp1Hit",
    "tp2Hit",
    "runnerActivated",
    "tp1ThenBreakeven",
    "initialSlHit",
    "holdMs",
    "feePctPerSide",
    "slippagePctPerSide",
    "fundingModeled",
    "fundingNote",
    "liquidated",
    "lossExceededMargin",
    "liquidationPrice",
    "leverage",
    "pnlPctRaw",
    "initialSl",
    "tp1Price",
    "tp2Price",
    "regime4h",
    "regime1h",
    "oiChange",
    "volumeChange",
    "opportunity",
)


class WalkDiagnostics:
    """结算走步时累加 MFE/MAE 与命中标记。"""

    def __init__(
        self,
        *,
        entry: float,
        is_short: bool,
        sl_price: float,
        tp1: float,
        tp2: float,
        risk_r: float | None = None,
        signal_at_ms: int = 0,
    ) -> None:
        self.entry = entry
        self.is_short = is_short
        self.sl_price = sl_price
        self.initial_sl = sl_price
        self.tp1 = tp1
        self.tp2 = tp2
        self.risk_r = float(risk_r) if risk_r and risk_r > 0 else abs(entry - sl_price)
        self.signal_at_ms = signal_at_ms
        self.mfe_pct = 0.0
        self.mae_pct = 0.0
        self.tp1_hit = False
        self.tp2_hit = False
        self.runner_activated = False
        self.sl_moved_to_be = False
        self.tp1_then_be = False
        self.liquidated = False
        self.exit_reason = "timeout"
        self.hit_at: int | None = None

    def update_excursions(self, bar: dict[str, float]) -> None:
        entry, is_short = self.entry, self.is_short
        fav_px = float(bar["low"] if is_short else bar["high"])
        adv_px = float(bar["high"] if is_short else bar["low"])
        fav = _price_move_pct(entry, fav_px, is_short=is_short)
        adv = _price_move_pct(entry, adv_px, is_short=is_short)
        if fav > self.mfe_pct:
            self.mfe_pct = fav
        # MAE：最大不利，记为正数
        if adv < 0 and (-adv) > self.mae_pct:
            self.mae_pct = -adv

    def mark_tp1(self) -> None:
        self.tp1_hit = True

    def mark_tp2(self) -> None:
        self.tp2_hit = True

    def mark_runner(self) -> None:
        self.runner_activated = True

    def mark_be(self) -> None:
        self.sl_moved_to_be = True

    def _r(self, pct: float) -> float | None:
        if self.entry <= 0 or self.risk_r <= 0:
            return None
        risk_pct = self.risk_r / self.entry * 100.0
        if risk_pct <= 0:
            return None
        return round(pct / risk_pct, 4)

    def finish(
        self,
        *,
        exit_reason: str,
        hit_at: int | None,
        liquidated: bool = False,
        fee_pct: float = 0.0,
        slippage_pct: float = 0.0,
        leverage: float | None = None,
        liquidation_px: float | None = None,
        loss_exceeded_margin: bool = False,
        pnl_pct_raw: float | None = None,
    ) -> dict[str, Any]:
        initial_sl_hit = exit_reason == "initial_sl" or (
            exit_reason in ("stop_loss", "liquidation") and not self.tp1_hit
        )
        if self.tp1_hit and self.sl_moved_to_be and exit_reason in ("tp1_breakeven", "stop_loss"):
            self.tp1_then_be = True
        hold = None
        if hit_at is not None and self.signal_at_ms:
            hold = int(hit_at) - int(self.signal_at_ms)
        return {
            "exitReason": exit_reason,
            "mfePct": round(self.mfe_pct, 6),
            "maePct": round(self.mae_pct, 6),
            "mfeR": self._r(self.mfe_pct),
            "maeR": self._r(self.mae_pct),
            "tp1Hit": bool(self.tp1_hit),
            "tp2Hit": bool(self.tp2_hit),
            "runnerActivated": bool(self.runner_activated),
            "tp1ThenBreakeven": bool(self.tp1_then_be),
            "initialSlHit": bool(initial_sl_hit),
            "holdMs": hold,
            "feePctPerSide": fee_pct,
            "slippagePctPerSide": slippage_pct,
            "fundingModeled": FUNDING_MODELED,
            "fundingNote": FUNDING_NOTE,
            "liquidated": bool(liquidated),
            "lossExceededMargin": bool(loss_exceeded_margin),
            "liquidationPrice": liquidation_px,
            "leverage": leverage,
            "pnlPctRaw": pnl_pct_raw,
            "initialSl": self.initial_sl,
        }


def summarize_diagnostics(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    items = [r for r in rows if isinstance(r, dict) and str(r.get("outcome") or "") not in ("pending", "error", "")]
    n = len(items)
    if n == 0:
        return {"n": 0, "assumptions": audit_assumptions()}

    def _rate(pred) -> float | None:
        return round(sum(1 for r in items if pred(r)) / n, 4)

    def _nums(key: str) -> list[float]:
        out: list[float] = []
        for r in items:
            try:
                v = r.get(key)
                if v is not None:
                    out.append(float(v))
            except (TypeError, ValueError):
                pass
        return out

    wins = [r for r in items if str(r.get("outcome")) == "take_profit"]
    losses = [r for r in items if str(r.get("outcome")) == "stop_loss" or r.get("liquidated")]
    win_pnls = [float(r["pnlPct"]) for r in wins if r.get("pnlPct") is not None]
    loss_pnls = [float(r["pnlPct"]) for r in losses if r.get("pnlPct") is not None]
    gross_win = sum(x for x in win_pnls if x > 0)
    gross_loss = abs(sum(x for x in loss_pnls if x < 0))
    pf = (gross_win / gross_loss) if gross_loss > 0 else (None if gross_win <= 0 else None)
    expectancy = (sum(win_pnls) + sum(loss_pnls)) / n if (win_pnls or loss_pnls) else None
    avg_win = statistics.mean(win_pnls) if win_pnls else None
    avg_loss = statistics.mean(loss_pnls) if loss_pnls else None
    rr = (abs(avg_win) / abs(avg_loss)) if (avg_win and avg_loss and avg_loss != 0) else None
    holds = _nums("holdMs")
    liq_n = sum(1 for r in items if r.get("liquidated"))
    exceed_n = sum(1 for r in items if r.get("lossExceededMargin") or (
        r.get("pnlPctRaw") is not None and float(r["pnlPctRaw"]) < -100
    ))
    raw_below = [float(r["pnlPctRaw"]) for r in items if r.get("pnlPctRaw") is not None and float(r["pnlPctRaw"]) < -100]

    return {
        "n": n,
        "tp1HitRate": _rate(lambda r: r.get("tp1Hit")),
        "tp2HitRate": _rate(lambda r: r.get("tp2Hit")),
        "runnerActivationRate": _rate(lambda r: r.get("runnerActivated")),
        "tp1ThenBreakevenRate": _rate(lambda r: r.get("tp1ThenBreakeven")),
        "initialSlHitRate": _rate(lambda r: r.get("initialSlHit")),
        "liquidationRate": _rate(lambda r: r.get("liquidated")),
        "liquidationCount": liq_n,
        "lossExceededMarginCount": exceed_n,
        "pnlPctRawBelowMargin": raw_below[:20],
        "avgHoldMs": round(sum(holds) / len(holds), 0) if holds else None,
        "avgMfePct": round(sum(_nums("mfePct")) / n, 4) if n else None,
        "avgMaePct": round(sum(_nums("maePct")) / n, 4) if n else None,
        "avgMfeR": (lambda xs: round(sum(xs) / len(xs), 4) if xs else None)(_nums("mfeR")),
        "avgMaeR": (lambda xs: round(sum(xs) / len(xs), 4) if xs else None)(_nums("maeR")),
        "expectancy": round(expectancy, 4) if expectancy is not None else None,
        "profitFactor": round(pf, 4) if pf is not None else None,
        "avgWin": round(avg_win, 4) if avg_win is not None else None,
        "avgLoss": round(avg_loss, 4) if avg_loss is not None else None,
        "payoffRatio": round(rr, 4) if rr is not None else None,
        "exitReasons": _count_by(items, "exitReason"),
        "assumptions": audit_assumptions(),
    }


def _count_by(items: list[dict[str, Any]], key: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in items:
        k = str(r.get(key) or "unknown")
        out[k] = out.get(k, 0) + 1
    return out


def auditor_report_text(summary: dict[str, Any]) -> str:
    a = summary.get("assumptions") or audit_assumptions()
    lines = [
        "=== 交易诊断 / 杠杆审计 ===",
        f"样本 {summary.get('n', 0)} 笔已结算",
        f"TP1 命中率 {summary.get('tp1HitRate')}  TP2 {summary.get('tp2HitRate')}  "
        f"Runner 激活 {summary.get('runnerActivationRate')}",
        f"TP1 后回保本 {summary.get('tp1ThenBreakevenRate')}  初始 SL（无止盈）{summary.get('initialSlHitRate')}",
        f"强平 {summary.get('liquidationCount')}（{summary.get('liquidationRate')}）  "
        f"未封顶前亏损超保证金 {summary.get('lossExceededMarginCount')}",
        f"期望值 {summary.get('expectancy')}  利润因子 {summary.get('profitFactor')}  "
        f"盈亏比 {summary.get('payoffRatio')}",
        f"平均盈利 {summary.get('avgWin')}  平均亏损 {summary.get('avgLoss')}",
        f"平均 MFE {summary.get('avgMfePct')}% / {summary.get('avgMfeR')}R  "
        f"MAE {summary.get('avgMaePct')}% / {summary.get('avgMaeR')}R",
        f"平均持仓 {summary.get('avgHoldMs')} ms",
        f"出场分布 {summary.get('exitReasons')}",
        "--- 假设 ---",
        f"ROE = 价变% × 杠杆；主流 {a.get('leverageMajor')}x {a.get('leverageMajorAssets')}，山寨 {a.get('leverageAlt')}x",
        f"维持保证金 主流 {a.get('mmrMajorPct')}% / 山寨 {a.get('mmrAltPct')}%；"
        f"强平模拟={a.get('liquidationEnabled')} 亏损封顶={a.get('capLossAtMargin')}",
        f"手续费默认 {a.get('feePctPerSideDefault')}%/边；滑点 {a.get('slippagePctPerSideDefault')}%/边",
        f"资金费率：{a.get('fundingNote')}",
        f"同柱优先级：{a.get('sameBarPriority')}",
        str(a.get("sandboxAltLeverageNote") or ""),
        str(a.get("feeNote") or ""),
    ]
    raw = summary.get("pnlPctRawBelowMargin") or []
    if raw:
        lines.append(f"未封顶原始 ROE 低于 -100 的样例: {raw}")
    return "\n".join(lines)


EXPORT_COLUMNS = [
    "symbol", "interval", "kind", "typeLabel", "patternLabel", "side", "strategy",
    "signalAt", "entry", "outcome", "exitReason", "exitPrice",
    "slPrice", "tp1Price", "tp2Price", "initialSl",
    "movePct", "netMovePct", "pnlPct", "pnlPctRaw",
    "mfePct", "maePct", "mfeR", "maeR",
    "tp1Hit", "tp2Hit", "runnerActivated", "tp1ThenBreakeven", "initialSlHit",
    "holdMs", "feePctPerSide", "slippagePctPerSide",
    "fundingModeled", "fundingNote",
    "liquidated", "lossExceededMargin", "liquidationPrice", "leverage",
    "regime4h", "regime1h", "oiChange", "volumeChange",
    "error",
]


def export_trades(
    rows: list[dict[str, Any]],
    *,
    dest_dir: Path,
    stem: str = "trade_diagnostics",
) -> dict[str, Path]:
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    json_path = dest_dir / f"{stem}.json"
    csv_path = dest_dir / f"{stem}.csv"
    summary = summarize_diagnostics(rows)
    payload = {"summary": summary, "items": rows, "assumptions": audit_assumptions()}
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    with csv_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=EXPORT_COLUMNS, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            flat = dict(r)
            for k in ("regime4h", "regime1h", "opportunity"):
                v = flat.get(k)
                if isinstance(v, dict):
                    flat[k] = v.get("label") or v.get("decision") or json.dumps(v, ensure_ascii=False)
            w.writerow(flat)
    report_path = dest_dir / f"{stem}_audit.txt"
    report_path.write_text(auditor_report_text(summary), encoding="utf-8")
    return {"json": json_path, "csv": csv_path, "audit": report_path}


def attach_leverage_context(rec: dict[str, Any]) -> dict[str, Any]:
    if rec.get("leverage") is None:
        rec["leverage"] = leverage_for_symbol(
            str(rec.get("tradeSymbol") or rec.get("symbol") or ""),
            str(rec.get("assetClass") or "crypto"),
        )
    rec.setdefault("fundingModeled", FUNDING_MODELED)
    rec.setdefault("fundingNote", FUNDING_NOTE)
    return rec
