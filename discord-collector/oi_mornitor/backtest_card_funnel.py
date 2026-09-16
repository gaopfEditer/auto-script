"""回测复刻 Live 形态卡片推送漏斗（与 pattern_monitor._scan_candle_pattern_cards 对齐）。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from oi_mornitor.backtest_kline_store import BacktestKlineStore
from oi_mornitor.config import (
    CARD_PUSH_COOLDOWN_BARS,
    CANDLE_CARD_ALT_INTERVALS,
    CANDLE_CARD_ALT_RANK_TF,
    CANDLE_CARD_ALT_TOP_N,
    CANDLE_CARD_MAJOR_INTERVALS,
    CANDLE_CARD_MAJOR_SYMBOLS,
)
from oi_mornitor.strategy.structure_signals import (
    STRUCTURE_CARD_INTERVALS,
    STRUCTURE_PUSH_COOLDOWN_BARS,
)

_MAJORS = {s.upper() for s in CANDLE_CARD_MAJOR_SYMBOLS}
_INTERVAL_SECONDS = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400}
_DAY_MS = 86_400_000
_LIVE_DISABLED_INTERVALS = frozenset({"30m"})


def live_majors() -> set[str]:
    return set(_MAJORS)


def build_live_scan_jobs(alt_symbols: list[str]) -> list[tuple[str, str, bool]]:
    """与 Live 相同的 (symbol, interval, is_major) 扫描任务；30m 仍列出但扫描层跳过。"""
    jobs: list[tuple[str, str, bool]] = []
    for sym in sorted(_MAJORS):
        for iv in CANDLE_CARD_MAJOR_INTERVALS:
            jobs.append((sym, iv, True))
    alt_set = sorted({s.upper() for s in alt_symbols if s.upper() not in _MAJORS})
    for sym in alt_set:
        for iv in CANDLE_CARD_ALT_INTERVALS:
            jobs.append((sym, iv, False))
    return jobs


def interval_allowed_for_job(interval: str) -> bool:
    return interval not in _LIVE_DISABLED_INTERVALS


def structure_interval_ok(interval: str) -> bool:
    return interval in STRUCTURE_CARD_INTERVALS


def alt_eligible_at(pool: set[str] | frozenset[str], symbol: str, *, is_major: bool) -> bool:
    if is_major:
        return True
    return symbol.upper() in pool


def _day_key(ms: int) -> int:
    return int(ms) // _DAY_MS


def _score_symbol_at(
    store: BacktestKlineStore,
    symbol: str,
    as_of_ms: int,
    *,
    rank_tf: str,
    lookback_bars: int,
) -> tuple[float, float]:
    """近似 Live pick_candle_card_alt_symbols：价格 |涨跌幅| + 成交量变化幅度。"""
    tf_ms = {"5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000}.get(
        rank_tf, 900_000
    )
    span = lookback_bars * tf_ms * 2 + tf_ms
    rows = store.load_rows(symbol, rank_tf, as_of_ms - span, as_of_ms)
    if len(rows) < lookback_bars * 2 + 1:
        return 0.0, 0.0
    tail = rows[-lookback_bars * 2 :]
    recent = tail[-lookback_bars:]
    prior = tail[-lookback_bars * 2 : -lookback_bars]
    try:
        c0 = float(prior[0][4])
        c1 = float(recent[-1][4])
        price_score = abs((c1 - c0) / c0 * 100.0) if c0 > 0 else 0.0
        q_recent = sum(float(r[7]) for r in recent)
        q_prior = sum(float(r[7]) for r in prior)
        flow_score = abs(q_recent - q_prior)
    except (TypeError, ValueError, IndexError):
        return 0.0, 0.0
    return price_score, flow_score


def pick_alt_symbols_at(
    store: BacktestKlineStore,
    universe: list[str],
    as_of_ms: int,
    *,
    majors: set[str] | None = None,
    top_n: int | None = None,
    rank_tf: str | None = None,
) -> list[str]:
    """在 as_of_ms 时刻用本地 K 线近似 Live 山寨 TopN（价幅 ∪ 量幅）。"""
    majors = majors or _MAJORS
    top_n = int(top_n if top_n is not None else CANDLE_CARD_ALT_TOP_N)
    rank_tf = rank_tf or CANDLE_CARD_ALT_RANK_TF
    eligible = [s for s in universe if s.upper() not in majors]
    price_ranked: list[tuple[str, float]] = []
    flow_ranked: list[tuple[str, float]] = []
    for sym in eligible:
        ps, fs = _score_symbol_at(store, sym, as_of_ms, rank_tf=rank_tf, lookback_bars=4)
        if ps > 0:
            price_ranked.append((sym, ps))
        if fs > 0:
            flow_ranked.append((sym, fs))
    price_ranked.sort(key=lambda x: x[1], reverse=True)
    flow_ranked.sort(key=lambda x: x[1], reverse=True)
    out: list[str] = []
    seen: set[str] = set()
    for sym, _ in price_ranked[:top_n]:
        su = sym.upper()
        if su not in seen:
            seen.add(su)
            out.append(su)
    for sym, _ in flow_ranked[:top_n]:
        su = sym.upper()
        if su not in seen:
            seen.add(su)
            out.append(su)
    return out


def build_daily_alt_pools(
    store: BacktestKlineStore,
    universe: list[str],
    start_ms: int,
    end_ms: int,
    *,
    majors: set[str] | None = None,
    top_n: int | None = None,
    rank_tf: str | None = None,
) -> dict[int, frozenset[str]]:
    """UTC 自然日 → 当日山寨池（用前一日收盘时刻排名，避免窥视）。"""
    majors = majors or _MAJORS
    pools: dict[int, frozenset[str]] = {}
    day = _day_key(start_ms)
    last_day = _day_key(end_ms)
    while day <= last_day:
        as_of = day * _DAY_MS - 1 if day > 0 else start_ms
        if as_of < start_ms:
            as_of = start_ms
        syms = pick_alt_symbols_at(
            store,
            universe,
            as_of,
            majors=majors,
            top_n=top_n,
            rank_tf=rank_tf,
        )
        pools[day] = frozenset(syms)
        day += 1
    return pools


def union_alt_symbols(pools: dict[int, frozenset[str]]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for day_syms in pools.values():
        for s in day_syms:
            su = s.upper()
            if su in seen:
                continue
            seen.add(su)
            out.append(su)
    return sorted(out)


@dataclass
class CardFunnelState:
    """跨全回测的 dedupe + 冷却（对齐 Live _card_seen / _card_last_emit）。"""

    card_seen: set[str] = field(default_factory=set)
    candle_last: dict[str, int] = field(default_factory=dict)
    struct_last: dict[str, int] = field(default_factory=dict)

    def candle_dedupe_key(self, sym: str, iv: str, kind: str, bar_close_sec: int) -> str:
        return f"{sym.upper()}:{iv}:{kind}:{bar_close_sec}"

    def struct_dedupe_key(self, sym: str, iv: str, kind: str, bar_close_sec: int) -> str:
        return f"{sym.upper()}:{iv}:struct:{kind}:{bar_close_sec}"

    def candle_cooldown_key(self, sym: str, iv: str, side: str) -> str:
        return f"{sym.upper()}:{iv}:{side}"

    def struct_cooldown_key(self, sym: str, iv: str, side: str) -> str:
        return f"struct:{sym.upper()}:{iv}:{side}"

    def _cooldown_blocked(
        self,
        last_map: dict[str, int],
        key: str,
        *,
        bar_close_sec: int,
        interval: str,
        cooldown_bars: int,
    ) -> bool:
        if cooldown_bars <= 0:
            return False
        last = last_map.get(key)
        if last is None:
            return False
        bar_sec = _INTERVAL_SECONDS.get(interval)
        if not bar_sec:
            return False
        return (int(bar_close_sec) - int(last)) <= cooldown_bars * bar_sec

    def try_candle_emit(
        self,
        *,
        sym: str,
        iv: str,
        kind: str,
        side: str,
        bar_close_sec: int,
    ) -> bool:
        dk = self.candle_dedupe_key(sym, iv, kind, bar_close_sec)
        if dk in self.card_seen:
            return False
        ck = self.candle_cooldown_key(sym, iv, side)
        if self._cooldown_blocked(
            self.candle_last,
            ck,
            bar_close_sec=bar_close_sec,
            interval=iv,
            cooldown_bars=CARD_PUSH_COOLDOWN_BARS,
        ):
            return False
        self.card_seen.add(dk)
        self.candle_last[ck] = bar_close_sec
        return True

    def try_struct_emit(
        self,
        *,
        sym: str,
        iv: str,
        kind: str,
        side: str,
        bar_close_sec: int,
    ) -> bool:
        dk = self.struct_dedupe_key(sym, iv, kind, bar_close_sec)
        if dk in self.card_seen:
            return False
        ck = self.struct_cooldown_key(sym, iv, side)
        if self._cooldown_blocked(
            self.struct_last,
            ck,
            bar_close_sec=bar_close_sec,
            interval=iv,
            cooldown_bars=STRUCTURE_PUSH_COOLDOWN_BARS,
        ):
            return False
        self.card_seen.add(dk)
        self.struct_last[ck] = bar_close_sec
        return True


def live_funnel_meta(pools: dict[int, frozenset[str]], jobs: list[tuple[str, str, bool]]) -> dict[str, Any]:
    return {
        "mode": "live_card_funnel",
        "majorSymbols": sorted(_MAJORS),
        "majorIntervals": list(CANDLE_CARD_MAJOR_INTERVALS),
        "altIntervals": list(CANDLE_CARD_ALT_INTERVALS),
        "altTopN": CANDLE_CARD_ALT_TOP_N,
        "altRankTf": CANDLE_CARD_ALT_RANK_TF,
        "dailyAltPoolDays": len(pools),
        "uniqueAltSymbols": len(union_alt_symbols(pools)),
        "scanJobs": len(jobs),
        "disabledIntervals": sorted(_LIVE_DISABLED_INTERVALS),
    }
