"""OI 三层入场过滤：共识分类 → 量价背离 → 形态确认。

现网默认关闭（OI_ENTRY_FILTER_V2=0）。回测脚本默认开启完整三层。
形态 allowlist 当前固定：射击之星 / 倒锤子 / 吞没（后续可经 OI_ENTRY_PATTERNS 增删）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

import pandas as pd

from oi_mornitor.config import (
    OI_ENTRY_DIVERGENCE_MODE,
    OI_ENTRY_FLAT_ABS_PCT,
    OI_ENTRY_FILTER_V2,
    OI_ENTRY_FILTER_V2_GATE_ALERT,
    OI_ENTRY_PATTERN_TIMEOUT_BARS,
    OI_ENTRY_PATTERN_TIMEOUT_SEC,
    OI_ENTRY_PATTERNS,
)
from oi_mornitor.strategy.indicators import detect_hammer, detect_inverted_hammer, detect_shooting_star

CONSENSUS_LABELS = {
    "long_build": "多头加仓",
    "short_build": "空头加仓",
    "short_cover": "空头回补",
    "long_exit": "多头离场",
    "flat": "价横盘",
    "unknown": "未知",
}

# 共识 → 偏好交易方向（与同向形态对齐）
CONSENSUS_SIDE = {
    "long_build": "long",
    "short_cover": "long",
    "short_build": "short",
    "long_exit": "short",
}


def _parse_patterns(raw: str | None = None) -> frozenset[str]:
    s = (raw if raw is not None else OI_ENTRY_PATTERNS) or ""
    parts = [p.strip() for p in s.split(",") if p.strip()]
    return frozenset(parts) if parts else frozenset(
        {"shooting_star", "inverted_hammer", "engulfing"}
    )


def classify_consensus(
    *,
    oi_up: bool,
    price_pct: float,
    flat_abs_pct: float | None = None,
) -> str:
    """L1：纯规则四象限。price_pct 单位为 %。"""
    flat = OI_ENTRY_FLAT_ABS_PCT if flat_abs_pct is None else float(flat_abs_pct)
    if abs(float(price_pct)) <= flat:
        return "flat"
    price_up = float(price_pct) > 0
    if oi_up and price_up:
        return "long_build"
    if oi_up and not price_up:
        return "short_build"
    if (not oi_up) and price_up:
        return "short_cover"
    if (not oi_up) and not price_up:
        return "long_exit"
    return "unknown"


def is_oi_price_divergence(
    *,
    oi_up: bool,
    pct_price_5m: float,
    pct_price_15m: float,
    flat_abs_pct: float | None = None,
) -> bool:
    """L2：OI↑ 且 5m+15m 价均横盘 → 量价背离。"""
    if not oi_up:
        return False
    flat = OI_ENTRY_FLAT_ABS_PCT if flat_abs_pct is None else float(flat_abs_pct)
    return abs(float(pct_price_5m)) <= flat and abs(float(pct_price_15m)) <= flat


def detect_engulfing_side(prev: Mapping[str, Any], cur: Mapping[str, Any]) -> str | None:
    """最小吞没实现：返回 bull/bear，否则 None。"""
    try:
        po, pc = float(prev["open"]), float(prev["close"])
        co, cc = float(cur["open"]), float(cur["close"])
    except (KeyError, TypeError, ValueError):
        return None
    prev_bear = pc < po
    prev_bull = pc > po
    cur_bull = cc > co
    cur_bear = cc < co
    # 阳吞阴
    if prev_bear and cur_bull and cc >= po and co <= pc:
        return "bull"
    # 阴吞阳
    if prev_bull and cur_bear and cc <= po and co >= pc:
        return "bear"
    return None


def _row_series(bar: Mapping[str, Any]) -> pd.Series:
    return pd.Series(
        {
            "open": float(bar["open"]),
            "high": float(bar["high"]),
            "low": float(bar["low"]),
            "close": float(bar["close"]),
        }
    )


def scan_patterns_on_bar(
    bars: Sequence[Mapping[str, Any]],
    index: int,
    *,
    allowed: frozenset[str] | None = None,
) -> list[dict[str, Any]]:
    """在 bars[index] 上检测 allowlist 形态；吞没需要前一根。"""
    allow = allowed if allowed is not None else _parse_patterns()
    if index < 0 or index >= len(bars):
        return []
    cur = bars[index]
    hits: list[dict[str, Any]] = []
    ser = _row_series(cur)
    if "shooting_star" in allow and detect_shooting_star(ser):
        hits.append({"kind": "shooting_star", "side": "short", "bar_index": index})
    if "inverted_hammer" in allow and detect_inverted_hammer(ser):
        hits.append({"kind": "inverted_hammer", "side": "long", "bar_index": index})
    if "hammer" in allow and detect_hammer(ser):
        hits.append({"kind": "hammer", "side": "long", "bar_index": index})
    if "engulfing" in allow and index >= 1:
        side = detect_engulfing_side(bars[index - 1], cur)
        if side:
            hits.append(
                {
                    "kind": "engulfing",
                    "side": "long" if side == "bull" else "short",
                    "bar_index": index,
                    "engulf_side": side,
                }
            )
    return hits


def find_pattern_confirmation(
    bars: Sequence[Mapping[str, Any]],
    *,
    signal_bar_index: int,
    preferred_side: str | None,
    timeout_bars: int | None = None,
    allowed: frozenset[str] | None = None,
) -> dict[str, Any] | None:
    """L3：自信号下一根起，在 timeout_bars 内找与 preferred_side 同向的形态。

    preferred_side 为 None 时接受任一方向。信号当根不计入（避免用未完成信息）。
    """
    tmax = OI_ENTRY_PATTERN_TIMEOUT_BARS if timeout_bars is None else int(timeout_bars)
    allow = allowed if allowed is not None else _parse_patterns()
    start = signal_bar_index + 1
    end = min(len(bars), start + max(1, tmax))
    for i in range(start, end):
        for hit in scan_patterns_on_bar(bars, i, allowed=allow):
            if preferred_side and hit.get("side") != preferred_side:
                continue
            return hit
    return None


@dataclass
class EntryFilterResult:
    consensus: str
    consensus_label: str
    preferred_side: str | None
    divergence: bool
    divergence_action: str  # pass | filter | downweight
    l2_pass: bool
    entry_status: str  # annotated | filtered_divergence | wait_pattern | entry_ready | expired | skipped
    entry_pattern: str | None = None
    entry_side: str | None = None
    entry_bar_index: int | None = None
    reasons: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "consensus": self.consensus,
            "consensus_label": self.consensus_label,
            "preferred_side": self.preferred_side,
            "divergence": self.divergence,
            "divergence_action": self.divergence_action,
            "l2_pass": self.l2_pass,
            "entry_status": self.entry_status,
            "entry_pattern": self.entry_pattern,
            "entry_side": self.entry_side,
            "entry_bar_index": self.entry_bar_index,
            "entry_reasons": list(self.reasons),
        }


def apply_entry_filter(
    *,
    oi_up: bool,
    pct_price_5m: float,
    pct_price_15m: float,
    bars: Sequence[Mapping[str, Any]] | None = None,
    signal_bar_index: int | None = None,
    flat_abs_pct: float | None = None,
    divergence_mode: str | None = None,
    timeout_bars: int | None = None,
    run_l3: bool = True,
    price_pct_for_l1: float | None = None,
) -> EntryFilterResult:
    """对单条 OI 异动跑 L1→L2→(可选)L3。

    L1 价向默认取 15m（更稳）；若 |15m| 过小则回退 5m。
    """
    flat = OI_ENTRY_FLAT_ABS_PCT if flat_abs_pct is None else float(flat_abs_pct)
    mode = (divergence_mode or OI_ENTRY_DIVERGENCE_MODE or "filter").strip().lower()
    px = (
        float(price_pct_for_l1)
        if price_pct_for_l1 is not None
        else (
            float(pct_price_15m)
            if abs(float(pct_price_15m)) > flat
            else float(pct_price_5m)
        )
    )
    consensus = classify_consensus(oi_up=oi_up, price_pct=px, flat_abs_pct=flat)
    label = CONSENSUS_LABELS.get(consensus, consensus)
    preferred = CONSENSUS_SIDE.get(consensus)
    reasons = [f"L1={consensus}"]

    div = is_oi_price_divergence(
        oi_up=oi_up,
        pct_price_5m=pct_price_5m,
        pct_price_15m=pct_price_15m,
        flat_abs_pct=flat,
    )
    if div and mode == "filter":
        return EntryFilterResult(
            consensus=consensus,
            consensus_label=label,
            preferred_side=preferred,
            divergence=True,
            divergence_action="filter",
            l2_pass=False,
            entry_status="filtered_divergence",
            reasons=reasons + ["L2=divergence_filter"],
        )
    if div and mode == "downweight":
        reasons.append("L2=divergence_downweight")
        l2_pass = True
        div_action = "downweight"
    else:
        l2_pass = True
        div_action = "pass"
        if not div:
            reasons.append("L2=pass")

    if not run_l3 or bars is None or signal_bar_index is None:
        return EntryFilterResult(
            consensus=consensus,
            consensus_label=label,
            preferred_side=preferred,
            divergence=div,
            divergence_action=div_action,
            l2_pass=l2_pass,
            entry_status="wait_pattern" if l2_pass else "filtered_divergence",
            reasons=reasons + (["L3=pending"] if l2_pass else []),
        )

    if consensus == "flat" or preferred is None:
        return EntryFilterResult(
            consensus=consensus,
            consensus_label=label,
            preferred_side=preferred,
            divergence=div,
            divergence_action=div_action,
            l2_pass=l2_pass,
            entry_status="expired",
            reasons=reasons + ["L3=no_preferred_side"],
        )

    hit = find_pattern_confirmation(
        bars,
        signal_bar_index=signal_bar_index,
        preferred_side=preferred,
        timeout_bars=timeout_bars,
    )
    if hit:
        return EntryFilterResult(
            consensus=consensus,
            consensus_label=label,
            preferred_side=preferred,
            divergence=div,
            divergence_action=div_action,
            l2_pass=True,
            entry_status="entry_ready",
            entry_pattern=str(hit.get("kind")),
            entry_side=str(hit.get("side")),
            entry_bar_index=int(hit["bar_index"]),
            reasons=reasons + [f"L3={hit.get('kind')}"],
        )
    return EntryFilterResult(
        consensus=consensus,
        consensus_label=label,
        preferred_side=preferred,
        divergence=div,
        divergence_action=div_action,
        l2_pass=True,
        entry_status="expired",
        reasons=reasons + ["L3=timeout"],
    )


def annotate_alert_row(row: dict[str, Any], *, enabled: bool | None = None) -> dict[str, Any]:
    """现网轻量挂钩：仅 L1+L2（无 K 线则 L3=wait_pattern）。可选门控 is_alert。"""
    on = OI_ENTRY_FILTER_V2 if enabled is None else bool(enabled)
    if not on:
        return row
    status = str(row.get("status") or "")
    typ = str(row.get("type") or "")
    oi_up = status == "pump" or typ == "OI_PUMP"
    if status not in ("pump", "dump") and typ not in ("OI_PUMP", "OI_DUMP"):
        row["entry_filter"] = {"entry_status": "skipped", "reasons": ["not_oi_alert"]}
        return row
    pct5 = float(row.get("pct_price_5m") or 0.0)
    pct15 = float(row.get("pct_price_15m") or 0.0)
    result = apply_entry_filter(
        oi_up=oi_up,
        pct_price_5m=pct5,
        pct_price_15m=pct15,
        run_l3=False,
    )
    row["entry_filter"] = result.as_dict()
    row["consensus"] = result.consensus
    row["consensus_label"] = result.consensus_label
    if OI_ENTRY_FILTER_V2_GATE_ALERT and row.get("is_alert"):
        if not result.l2_pass or result.consensus in ("flat", "unknown"):
            row["is_alert"] = False
            row["alert_reason"] = f"entry_filter({result.entry_status})"
    return row


def bars_from_ohlcv_rows(rows: Iterable[Sequence[Any]]) -> list[dict[str, float]]:
    """Binance/Bybit kline row → dict bars。"""
    out: list[dict[str, float]] = []
    for r in rows:
        try:
            out.append(
                {
                    "open_time": float(r[0]),
                    "open": float(r[1]),
                    "high": float(r[2]),
                    "low": float(r[3]),
                    "close": float(r[4]),
                    "volume": float(r[5]) if len(r) > 5 else 0.0,
                    "close_time": float(r[6]) if len(r) > 6 else float(r[0]),
                }
            )
        except (IndexError, TypeError, ValueError):
            continue
    return out


def price_pct_between(bars: Sequence[Mapping[str, Any]], end_idx: int, lookback_bars: int) -> float:
    """用 close[end]/close[end-lookback]-1 得 %。"""
    if end_idx < 0 or end_idx >= len(bars):
        return 0.0
    start = end_idx - lookback_bars
    if start < 0:
        return 0.0
    c0 = float(bars[start]["close"])
    c1 = float(bars[end_idx]["close"])
    if c0 == 0:
        return 0.0
    return (c1 / c0 - 1.0) * 100.0


def forward_return_pct(
    bars: Sequence[Mapping[str, Any]],
    entry_idx: int,
    *,
    hold_bars: int,
    side: str,
) -> float | None:
    """固定持有 hold_bars 根，按 side 计算收益率 %（多：收涨为正；空：收跌为正）。"""
    exit_idx = entry_idx + hold_bars
    if entry_idx < 0 or exit_idx >= len(bars):
        return None
    e = float(bars[entry_idx]["close"])
    x = float(bars[exit_idx]["close"])
    if e == 0:
        return None
    raw = (x / e - 1.0) * 100.0
    return raw if side == "long" else -raw


__all__ = [
    "CONSENSUS_LABELS",
    "CONSENSUS_SIDE",
    "EntryFilterResult",
    "annotate_alert_row",
    "apply_entry_filter",
    "bars_from_ohlcv_rows",
    "classify_consensus",
    "detect_engulfing_side",
    "detect_hammer",
    "find_pattern_confirmation",
    "forward_return_pct",
    "is_oi_price_divergence",
    "price_pct_between",
    "scan_patterns_on_bar",
]
