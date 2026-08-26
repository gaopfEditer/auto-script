"""形态监控引擎 — 自选 N 币 × 15m K 线 × 两步状态机。"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from pathlib import Path
from typing import Any

import aiohttp

from oi_mornitor.config import (
    BREAKOUT_MATRIX_TF,
    FAPI_BASE_URL,
    MATRIX_TOP_N,
    OI_OI_BATCH_CONCURRENCY,
    PATTERN_AUTO_PICK_COUNT,
    PATTERN_CARD_RESERVED,
    PATTERN_CHART_DEFAULT_LIMIT,
    PATTERN_CHART_MAX_LIMIT,
    PATTERN_INACTIVE_PURGE_SEC,
    PATTERN_KLINE_INTERVAL,
    PATTERN_KLINE_LIMIT,
    PATTERN_MULTI_BOARD_MIN,
    PATTERN_OI_AMPLIFY_PCT,
    PATTERN_SEARCHING_STALE_SEC,
    PATTERN_WATCHLIST_REFRESH_SEC,
    PATTERN_WATCHLIST_REFRESH_TF,
)
from oi_mornitor.exchange_sources import fetch_klines_with_fallback
from oi_mornitor.market_snapshot import TIER_HEAVY
from oi_mornitor.matrix_breakout import collect_matrix_leaderboard
from oi_mornitor.pattern_detector import (
    STATUS_EXPIRED,
    STATUS_LABELS,
    STATUS_LH,
    STATUS_SEARCHING,
    STATUS_TRIGGER,
    STATUS_WAITING,
    build_pattern_chart_payload,
    enrich_indicators,
    evaluate_pattern,
)
from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.derivatives_metrics import (
    build_derivatives_context,
    build_mtf_context,
    fetch_premium_index,
)
from oi_mornitor.pattern_state_tracker import MAX_WATCH_SYMBOLS, PatternStateTracker
from oi_mornitor.rank_metrics import TF_LABELS
from oi_mornitor.strategy.candle_signals import (
    PATTERN_MARKER_KINDS,
    collect_candle_signal_markers,
    find_last_closed_pattern_oi_combos,
)
from oi_mornitor.notify_telegram import send_pattern_oi_telegram_async
from oi_mornitor.tv_alert_sync import symbols_on_n_boards

logger = logging.getLogger("OI_Radar")

# 已进入形态阶段 / 已扳机：刷新 watchlist 时保留
_PROTECTED_PATTERN_STATUSES = frozenset({STATUS_LH, STATUS_WAITING, STATUS_TRIGGER})
# 涨幅∩持仓自动入池时，可被腾出的状态
_EVICTABLE_PATTERN_STATUSES = frozenset({STATUS_SEARCHING, STATUS_EXPIRED})
_SHORT_PATTERN_KINDS = frozenset({
    "shooting_star",
    "continuous_upper_wick",
    "continuous_non_upper_wick",
})
_LONG_PATTERN_KINDS = frozenset({
    "inverted_hammer",
    "continuous_lower_wick",
    "continuous_non_lower_wick",
})


def _combo_side_hint(kind: str) -> str:
    if kind in _SHORT_PATTERN_KINDS:
        return "短线做空"
    if kind in _LONG_PATTERN_KINDS:
        return "短线做多"
    return "短线"


async def fetch_pattern_klines(
    session: aiohttp.ClientSession,
    *,
    base_url: str,
    symbol: str,
    interval: str = PATTERN_KLINE_INTERVAL,
    limit: int = PATTERN_KLINE_LIMIT,
    end_time: int | None = None,
) -> list[list[Any]]:
    """拉取单币种 K 线；币安 418/失败时自动走 Bybit/OKX 等备选所。"""
    sym = symbol.strip().upper()
    cap = min(max(limit, 1), PATTERN_CHART_MAX_LIMIT)
    rows, _src = await fetch_klines_with_fallback(
        session,
        symbol=sym,
        interval=interval,
        limit=cap,
        end_time=end_time,
        binance_base_url=base_url,
    )
    return rows


async def fetch_open_interest_hist(
    session: aiohttp.ClientSession,
    *,
    base_url: str,
    symbol: str,
    interval: str,
    limit: int = 500,
) -> dict[int, float]:
    """币安 openInterestHist → {open_time秒: sumOpenInterest}。失败返回空。"""
    sym = symbol.strip().upper()
    cap = min(max(limit, 1), 500)
    url = (
        f"{base_url.rstrip('/')}/futures/data/openInterestHist"
        f"?symbol={sym}&period={interval}&limit={cap}"
    )
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=12)) as resp:
            if resp.status != 200:
                return {}
            data = await resp.json()
    except Exception as exc:
        logger.debug("OI hist 拉取失败 %s %s: %s", sym, interval, exc)
        return {}
    if not isinstance(data, list):
        return {}
    out: dict[int, float] = {}
    for row in data:
        if not isinstance(row, dict):
            continue
        try:
            ts = int(row.get("timestamp") or 0)
            oi = float(row.get("sumOpenInterest") or 0)
        except (TypeError, ValueError):
            continue
        if ts <= 0 or oi <= 0:
            continue
        out[ts // 1000] = oi
    return out


async def fetch_pattern_klines_batch(
    session: aiohttp.ClientSession,
    *,
    base_url: str,
    symbols: list[str],
    interval: str | None = None,
    limit: int | None = None,
) -> dict[str, list[list[Any]]]:
    interval = interval or PATTERN_KLINE_INTERVAL
    limit = limit if limit is not None else PATTERN_KLINE_LIMIT
    if not symbols:
        return {}

    sem = asyncio.Semaphore(OI_OI_BATCH_CONCURRENCY)
    out: dict[str, list[list[Any]]] = {}
    # 任一次币安失败后，后续批量请求跳过币安，避免 418 连打
    skip_binance = False

    async def _one(sym: str) -> None:
        nonlocal skip_binance
        async with sem:
            rows, src = await fetch_klines_with_fallback(
                session,
                symbol=sym,
                interval=interval,
                limit=limit,
                binance_base_url=base_url,
                skip_binance=skip_binance,
            )
            if src and src != "binance":
                skip_binance = True
            out[sym] = rows

    await asyncio.gather(*[_one(s) for s in symbols])
    return out


def heavyweight_symbols(pool_rows: list[dict[str, Any]]) -> list[str]:
    """从雷达池提取大象级（heavyweight）币种。不按 warming 过滤——量级在首轮扫描即可确定。"""
    return [
        str(r["symbol"])
        for r in pool_rows
        if r.get("oi_tier") == TIER_HEAVY
    ]


def resolve_heavyweight_candidates(
    pool_rows: list[dict[str, Any]],
    *,
    fallback_symbols: list[str] | None = None,
) -> list[str]:
    candidates = heavyweight_symbols(pool_rows)
    if candidates:
        return candidates
    return list(fallback_symbols or [])


def pick_random_heavyweight(
    pool_rows: list[dict[str, Any]],
    *,
    count: int = PATTERN_AUTO_PICK_COUNT,
    exclude: set[str] | None = None,
    fallback_symbols: list[str] | None = None,
) -> list[str]:
    candidates = resolve_heavyweight_candidates(pool_rows, fallback_symbols=fallback_symbols)
    if exclude:
        candidates = [s for s in candidates if s not in exclude]
    if not candidates:
        return []
    if len(candidates) <= count:
        return candidates
    return random.sample(candidates, count)


def _rank_metric(row: dict[str, Any], tf: str, domain: str) -> dict[str, float]:
    return (row.get("rank_by_tf") or {}).get(tf, {}).get(domain) or {}


def _positive_magnitude(row: dict[str, Any], tf: str, domain: str) -> float:
    m = _rank_metric(row, tf, domain)
    rate = float(m.get("change_rate") or 0.0)
    mag = float(m.get("magnitude_usd") or 0.0)
    if rate <= 0 or mag <= 0:
        return 0.0
    return abs(mag)


def pick_hot_flow_and_oi(
    pool_rows: list[dict[str, Any]],
    *,
    count: int = PATTERN_AUTO_PICK_COUNT,
    tf: str = PATTERN_WATCHLIST_REFRESH_TF,
    exclude: set[str] | None = None,
    fallback_symbols: list[str] | None = None,
) -> list[str]:
    """从合约流入榜 + OI 爆发榜合并挑币；不足时回退大象池。"""
    exclude = {s.upper() for s in (exclude or set())}
    eligible = [
        r
        for r in pool_rows
        if r.get("status") != "warming"
        and str(r.get("symbol") or "").upper() not in exclude
    ]

    contract_ranked = sorted(
        eligible,
        key=lambda r: _positive_magnitude(r, tf, "contract_flow"),
        reverse=True,
    )
    oi_ranked = sorted(
        eligible,
        key=lambda r: _positive_magnitude(r, tf, "oi"),
        reverse=True,
    )

    out: list[str] = []
    seen: set[str] = set()
    half = max(1, (count + 1) // 2)

    def _take(rows: list[dict[str, Any]], domain: str, limit: int) -> None:
        for row in rows:
            if len(out) >= limit or len(out) >= count:
                return
            if _positive_magnitude(row, tf, domain) <= 0:
                continue
            sym = str(row.get("symbol") or "").upper()
            if not sym or sym in seen:
                continue
            seen.add(sym)
            out.append(sym)

    _take(contract_ranked, "contract_flow", half)
    _take(oi_ranked, "oi", count)
    if len(out) < count:
        _take(contract_ranked, "contract_flow", count)
    if len(out) < count:
        for sym in pick_random_heavyweight(
            pool_rows,
            count=count - len(out),
            exclude=seen | exclude,
            fallback_symbols=fallback_symbols,
        ):
            if sym not in seen:
                seen.add(sym)
                out.append(sym)

    return out[:count]


def _rank_score(row: dict[str, Any], tf: str, domain: str, *, mode: str) -> float:
    m = _rank_metric(row, tf, domain)
    rate = float(m.get("change_rate") or 0.0)
    if rate <= 0:
        return 0.0
    if mode == "intensity":
        return float(m.get("intensity_score") or 0.0)
    # 与前端 deriveLists 对齐：price 用量级=|rate|，oi 用 |magnitude_usd|
    if domain == "price":
        return abs(rate)
    return abs(float(m.get("magnitude_usd") or 0.0))


def _top_board_symbols(
    rows: list[dict[str, Any]],
    tf: str,
    domain: str,
    *,
    mode: str,
    top_n: int,
) -> list[str]:
    ranked = sorted(
        rows,
        key=lambda r: _rank_score(r, tf, domain, mode=mode),
        reverse=True,
    )
    out: list[str] = []
    for row in ranked:
        if _rank_score(row, tf, domain, mode=mode) <= 0:
            continue
        sym = str(row.get("symbol") or "").upper()
        if not sym:
            continue
        out.append(sym)
        if len(out) >= top_n:
            break
    return out


def find_gainers_oi_intersection(
    pool_rows: list[dict[str, Any]],
    *,
    top_n: int = MATRIX_TOP_N,
    timeframes: tuple[str, ...] = TF_LABELS,
) -> list[str]:
    """
    雷达涨幅榜 ∩ 持仓正榜（量级或强度任一上榜即计入）。
    任一周期命中即纳入；返回去重后的 symbol 列表。
    """
    eligible = [r for r in pool_rows if r.get("status") != "warming"]
    hits: list[str] = []
    seen: set[str] = set()
    for tf in timeframes:
        gainers = set(_top_board_symbols(eligible, tf, "price", mode="mag", top_n=top_n)) | set(
            _top_board_symbols(eligible, tf, "price", mode="intensity", top_n=top_n)
        )
        oi_pos = set(_top_board_symbols(eligible, tf, "oi", mode="mag", top_n=top_n)) | set(
            _top_board_symbols(eligible, tf, "oi", mode="intensity", top_n=top_n)
        )
        for sym in gainers & oi_pos:
            if sym not in seen:
                seen.add(sym)
                hits.append(sym)
    return hits


_OI_BOARD_CATS = frozenset(
    {"oi_pumps", "oi_dumps", "oi_pump_strength", "oi_dump_strength"}
)


def find_oi_amplified_symbols(
    pool_rows: list[dict[str, Any]],
    *,
    hot_tickers: list[dict[str, Any]] | None = None,
    min_pct: float = PATTERN_OI_AMPLIFY_PCT,
) -> list[str]:
    """
    雷达 OI 放大币：is_alert / is_hot，或 |pct_5m|/|pct_15m| ≥ 阈值。
    用于及时补进形态监听（不要求多榜）。
    """
    out: list[str] = []
    seen: set[str] = set()
    threshold = abs(float(min_pct))

    def _push(sym: str) -> None:
        s = str(sym or "").upper()
        if not s or s in seen:
            return
        seen.add(s)
        out.append(s)

    for r in hot_tickers or []:
        _push(str(r.get("symbol") or ""))

    for r in pool_rows:
        if r.get("status") == "warming":
            continue
        sym = str(r.get("symbol") or "").upper()
        if not sym:
            continue
        if r.get("is_alert") or r.get("is_hot"):
            _push(sym)
            continue
        try:
            p5 = abs(float(r.get("pct_5m") or 0.0))
            p15 = abs(float(r.get("pct_15m") or 0.0))
        except (TypeError, ValueError):
            continue
        if p5 >= threshold or p15 >= threshold:
            _push(sym)
    return out


def find_oi_anomaly_multiboard(
    pool_rows: list[dict[str, Any]],
    *,
    hot_tickers: list[dict[str, Any]] | None = None,
    min_boards: int = PATTERN_MULTI_BOARD_MIN,
    top_n: int = MATRIX_TOP_N,
) -> list[str]:
    """
    OI 异动 ∩ 多榜共振 → 应及时进入形态监听。

    OI 异动：雷达告警 / is_hot，或当前矩阵任一持仓榜上榜。
    多榜：同时出现在 ≥ min_boards 个矩阵榜单。
    """
    hot: set[str] = set()
    for r in hot_tickers or []:
        sym = str(r.get("symbol") or "").upper()
        if sym:
            hot.add(sym)
    eligible = [r for r in pool_rows if r.get("status") != "warming"]
    for r in eligible:
        sym = str(r.get("symbol") or "").upper()
        if not sym:
            continue
        if r.get("is_alert") or r.get("is_hot"):
            hot.add(sym)
    for tf in TF_LABELS:
        hot.update(_top_board_symbols(eligible, tf, "oi", mode="mag", top_n=top_n))
        hot.update(_top_board_symbols(eligible, tf, "oi", mode="intensity", top_n=top_n))

    if not hot:
        return []

    leaderboard = collect_matrix_leaderboard(
        eligible, tf=BREAKOUT_MATRIX_TF, top_n=top_n
    )
    multi = symbols_on_n_boards(leaderboard, min_boards=max(2, int(min_boards)))
    out: list[str] = []
    for c in multi:
        sym = str(c["symbol"]).upper()
        if sym not in hot:
            continue
        cats = list(c.get("categories") or [])
        # 至少沾一条持仓榜，或已在 OI 异动集合（告警 / hot / 持仓榜）
        has_oi_board = any(str(x) in _OI_BOARD_CATS for x in cats)
        if has_oi_board or sym in hot:
            out.append(sym)
    return out


class PatternMonitorEngine:
    def __init__(self) -> None:
        self.tracker = PatternStateTracker()
        self._last_alerts: list[dict[str, Any]] = []
        self._last_states: list[dict[str, Any]] = []
        self._last_scan_ts: float = 0.0
        self._last_pool_rows: list[dict[str, Any]] = []
        self._last_watchlist_refresh_ts: float = 0.0
        # symbol:close_ts → 已推过的形态+OI 短线推荐
        self._combo_seen: set[str] = set()

    @property
    def last_alerts(self) -> list[dict[str, Any]]:
        return list(self._last_alerts)

    @property
    def last_states(self) -> list[dict[str, Any]]:
        return list(self._last_states)

    @property
    def last_scan_ts(self) -> float:
        return self._last_scan_ts

    def add_symbol(self, symbol: str) -> bool:
        return self.tracker.add_watch(symbol)

    def remove_symbol(self, symbol: str) -> bool:
        return self.tracker.remove_watch(symbol)

    def pin_symbol_to_top(self, symbol: str) -> bool:
        """手动置顶至少一天（兼容旧 API 名）。"""
        return self.tracker.pin_watch(symbol)

    def pin_symbol(self, symbol: str, *, ttl_sec: float | None = None) -> bool:
        return self.tracker.pin_watch(symbol, ttl_sec=ttl_sec)

    def ensure_card_symbol(self, symbol: str, *, ttl_sec: float | None = None) -> bool:
        """卡片接入：加入形态池并长置顶，占用卡片预留槽。"""
        sym = (symbol or "").strip().upper()
        if not sym:
            return False
        watch = {w.symbol.upper() for w in self.tracker.list_watchlist()}
        if sym not in watch:
            while len(self.tracker.list_watchlist()) >= MAX_WATCH_SYMBOLS:
                evicted = self._evict_one_replaceable()
                if not evicted:
                    break
            if not self.tracker.add_watch(sym):
                return False
        from oi_mornitor.config import PATTERN_CARD_PIN_TTL_SEC

        return self.tracker.pin_watch(
            sym, ttl_sec=float(ttl_sec if ttl_sec is not None else PATTERN_CARD_PIN_TTL_SEC)
        )

    def unpin_symbol(self, symbol: str) -> bool:
        return self.tracker.unpin_watch(symbol)

    def ensure_auto_watchlist(
        self,
        pool_rows: list[dict[str, Any]],
        *,
        fallback_symbols: list[str] | None = None,
    ) -> list[str]:
        """监听列表为空时，优先合约流入 + OI 爆发，不足再补大象池。"""
        if self.tracker.list_watchlist():
            return []
        picked = pick_hot_flow_and_oi(pool_rows, fallback_symbols=fallback_symbols)
        if not picked:
            return []
        self.tracker.replace_watchlist(picked)
        self._last_watchlist_refresh_ts = time.time()
        logger.info(
            "🎲 形态池自动初始化：流入/OI %d 个 → %s",
            len(picked),
            ", ".join(picked[:8]) + ("…" if len(picked) > 8 else ""),
        )
        return picked

    def fill_watchlist_to_capacity(
        self,
        pool_rows: list[dict[str, Any]],
        *,
        fallback_symbols: list[str] | None = None,
    ) -> list[str]:
        """列表未满时立即用热钱补到 MAX_WATCH_SYMBOLS（升级上限后无需等 2h 刷新）。"""
        current = {w.symbol.upper() for w in self.tracker.list_watchlist()}
        if len(current) >= MAX_WATCH_SYMBOLS:
            return []
        need = MAX_WATCH_SYMBOLS - len(current)
        picked = pick_hot_flow_and_oi(
            pool_rows,
            count=max(need * 2, need),
            fallback_symbols=fallback_symbols,
        )
        added: list[str] = []
        for sym in picked:
            if len(current) >= MAX_WATCH_SYMBOLS:
                break
            sym_u = str(sym).upper()
            if not sym_u or sym_u in current:
                continue
            if self.tracker.add_watch(sym_u):
                current.add(sym_u)
                added.append(sym_u)
        if added:
            logger.info(
                "📈 形态池补齐到 %d：+%d → %s",
                MAX_WATCH_SYMBOLS,
                len(added),
                ", ".join(added[:8]) + ("…" if len(added) > 8 else ""),
            )
        return added

    def random_pick_heavyweight(
        self,
        pool_rows: list[dict[str, Any]],
        *,
        fallback_symbols: list[str] | None = None,
    ) -> list[str]:
        """清空并重新从合约流入 + OI 爆发挑币（不足补大象）。"""
        picked = pick_hot_flow_and_oi(pool_rows, fallback_symbols=fallback_symbols)
        if not picked:
            return []
        self.tracker.replace_watchlist(picked)
        self._last_watchlist_refresh_ts = time.time()
        logger.info(
            "🎲 形态池热钱重选：流入/OI %d 个 → %s",
            len(picked),
            ", ".join(picked[:8]) + ("…" if len(picked) > 8 else ""),
        )
        return picked

    def _protected_symbols(self, protect_extra: set[str] | None = None) -> set[str]:
        protected = {s.upper() for s in (protect_extra or set())}
        for st in self.tracker.list_states():
            if st.status in _PROTECTED_PATTERN_STATUSES:
                protected.add(st.symbol.upper())
        for w in self.tracker.list_watchlist():
            if w.is_pinned:
                protected.add(w.symbol.upper())
        return protected

    def refresh_watchlist_from_hot(
        self,
        pool_rows: list[dict[str, Any]],
        *,
        fallback_symbols: list[str] | None = None,
        protect_extra: set[str] | None = None,
        force: bool = False,
    ) -> list[str]:
        """
        每隔 PATTERN_WATCHLIST_REFRESH_SEC，用合约流入榜 + OI 爆发榜更新形态列表。
        已进入 LH/等待 HL/扳机 的币，以及 protect_extra（如沙盒持仓）保留；其余可被替换。
        """
        now = time.time()
        if not force and self._last_watchlist_refresh_ts > 0:
            if now - self._last_watchlist_refresh_ts < PATTERN_WATCHLIST_REFRESH_SEC:
                return []

        current = [w.symbol.upper() for w in self.tracker.list_watchlist()]
        protected = self._protected_symbols(protect_extra)
        # 只保护仍在 watchlist 内的
        protected &= set(current)

        # 热榜最多占用「总槽 - 卡片预留」；卡片置顶币始终保留
        hot_cap = max(0, MAX_WATCH_SYMBOLS - PATTERN_CARD_RESERVED)
        hot_pick_n = min(PATTERN_AUTO_PICK_COUNT, hot_cap) if hot_cap else 0

        hot = pick_hot_flow_and_oi(
            pool_rows,
            count=max(hot_pick_n, 1) if hot_pick_n else 0,
            fallback_symbols=fallback_symbols,
        ) if hot_pick_n else []
        if not hot and not protected:
            self._last_watchlist_refresh_ts = now
            return []

        target: list[str] = []
        seen: set[str] = set()
        for sym in protected:
            if sym not in seen and len(target) < MAX_WATCH_SYMBOLS:
                seen.add(sym)
                target.append(sym)

        hot_added = 0
        for sym in hot:
            if hot_added >= hot_cap:
                break
            if len(target) >= MAX_WATCH_SYMBOLS:
                break
            if sym in seen:
                continue
            seen.add(sym)
            target.append(sym)
            hot_added += 1

        # 槽位未满且未占满热榜额度时，短暂保留未进场旧币（不挤占卡片预留空位）
        soft_cap = min(MAX_WATCH_SYMBOLS, len(protected) + hot_cap)
        if len(target) < soft_cap:
            for sym in current:
                if len(target) >= soft_cap:
                    break
                if sym in seen:
                    continue
                seen.add(sym)
                target.append(sym)

        target = target[:MAX_WATCH_SYMBOLS]
        current_set = set(current)
        target_set = set(target)
        to_remove = current_set - target_set - protected
        to_add = [s for s in target if s not in current_set]

        if not to_remove and not to_add:
            self._last_watchlist_refresh_ts = now
            return []

        for sym in to_remove:
            self.tracker.remove_watch(sym)
        for sym in to_add:
            self.tracker.add_watch(sym)

        self._last_watchlist_refresh_ts = now
        logger.info(
            "🔄 形态池热钱刷新：卡片预留 %d · 热榜额度 %d · 保留已进场/置顶 %d · 移除 %d · 新增 %d → %s",
            PATTERN_CARD_RESERVED,
            hot_cap,
            len(protected),
            len(to_remove),
            len(to_add),
            ", ".join(target[:8]) + ("…" if len(target) > 8 else ""),
        )
        return target

    def _evict_one_replaceable(self, protect_extra: set[str] | None = None) -> str | None:
        """腾出一个未进场槽位；优先 EXPIRED，再 SEARCHING（按 added_at 最旧）。"""
        protected = self._protected_symbols(protect_extra)
        watch = self.tracker.list_watchlist()
        states = {s.symbol.upper(): s for s in self.tracker.list_states()}
        candidates: list[tuple[int, float, str]] = []
        for w in watch:
            sym = w.symbol.upper()
            if sym in protected:
                continue
            st = states.get(sym)
            status = st.status if st else STATUS_SEARCHING
            if status not in _EVICTABLE_PATTERN_STATUSES:
                continue
            # EXPIRED 优先踢出
            prio = 0 if status == STATUS_EXPIRED else 1
            candidates.append((prio, w.added_at, sym))
        if not candidates:
            return None
        candidates.sort(key=lambda x: (x[0], x[1]))
        victim = candidates[0][2]
        self.tracker.remove_watch(victim)
        return victim

    def ingest_gainers_oi_intersection(
        self,
        pool_rows: list[dict[str, Any]],
        *,
        protect_extra: set[str] | None = None,
    ) -> list[str]:
        """
        雷达涨幅榜 ∩ 持仓正榜 → 自动加入形态追踪。
        列表已满时踢掉未进场币腾位；新币置顶便于看到。
        """
        hits = find_gainers_oi_intersection(pool_rows)
        return self._ingest_symbols_to_watch(
            hits, protect_extra=protect_extra, log_tag="涨幅∩持仓"
        )

    def ingest_oi_anomaly_multiboard(
        self,
        pool_rows: list[dict[str, Any]],
        *,
        hot_tickers: list[dict[str, Any]] | None = None,
        protect_extra: set[str] | None = None,
        min_boards: int | None = None,
    ) -> list[str]:
        """OI 异动且多榜共振 → 立即加入 / 顶到形态监听列表。"""
        hits = find_oi_anomaly_multiboard(
            pool_rows,
            hot_tickers=hot_tickers,
            min_boards=min_boards if min_boards is not None else PATTERN_MULTI_BOARD_MIN,
        )
        return self._ingest_symbols_to_watch(
            hits,
            protect_extra=protect_extra,
            log_tag=f"OI异动∩≥{min_boards if min_boards is not None else PATTERN_MULTI_BOARD_MIN}榜",
            bump_existing=True,
        )

    def ingest_oi_amplified(
        self,
        pool_rows: list[dict[str, Any]],
        *,
        hot_tickers: list[dict[str, Any]] | None = None,
        protect_extra: set[str] | None = None,
    ) -> list[str]:
        """雷达 OI 放大（告警 / 高变动率）→ 立即加入形态监听。"""
        hits = find_oi_amplified_symbols(
            pool_rows,
            hot_tickers=hot_tickers,
            min_pct=PATTERN_OI_AMPLIFY_PCT,
        )
        return self._ingest_symbols_to_watch(
            hits,
            protect_extra=protect_extra,
            log_tag=f"OI放大(≥{PATTERN_OI_AMPLIFY_PCT:g}%)",
            bump_existing=True,
        )

    def prune_inactive_watch(
        self,
        *,
        protect_extra: set[str] | None = None,
        expired_age_sec: float | None = None,
        searching_age_sec: float | None = None,
    ) -> list[str]:
        """
        移除历史不活跃币：EXPIRED 超过 expired_age_sec，
        或长期 SEARCHING 无进展超过 searching_age_sec。
        置顶 / LH / WAITING / TRIGGER / 沙盒持仓保留。
        """
        now = time.time()
        expired_age = float(
            expired_age_sec if expired_age_sec is not None else PATTERN_INACTIVE_PURGE_SEC
        )
        searching_age = float(
            searching_age_sec
            if searching_age_sec is not None
            else PATTERN_SEARCHING_STALE_SEC
        )
        protected = self._protected_symbols(protect_extra)
        states = {s.symbol.upper(): s for s in self.tracker.list_states()}
        removed: list[str] = []
        for w in self.tracker.list_watchlist():
            sym = w.symbol.upper()
            if sym in protected:
                continue
            st = states.get(sym)
            status = st.status if st else STATUS_SEARCHING
            updated = float(st.updated_at if st else w.added_at)
            age = now - updated
            drop = False
            if status == STATUS_EXPIRED and age >= expired_age:
                drop = True
            elif status == STATUS_SEARCHING and age >= searching_age:
                drop = True
            if drop and self.tracker.remove_watch(sym):
                removed.append(sym)
        if removed:
            logger.info(
                "🧹 形态池清理不活跃 %d：%s",
                len(removed),
                ", ".join(removed[:10]) + ("…" if len(removed) > 10 else ""),
            )
        return removed

    def _ingest_symbols_to_watch(
        self,
        hits: list[str],
        *,
        protect_extra: set[str] | None = None,
        log_tag: str = "雷达",
        bump_existing: bool = False,
    ) -> list[str]:
        if not hits:
            return []

        current = {w.symbol.upper() for w in self.tracker.list_watchlist()}
        added: list[str] = []
        bumped: list[str] = []
        for sym in hits:
            sym_u = str(sym).upper()
            if not sym_u:
                continue
            if sym_u in current:
                if bump_existing:
                    self.tracker.bump_watch_to_top(sym_u)
                    bumped.append(sym_u)
                continue
            while len(current) >= MAX_WATCH_SYMBOLS:
                victim = self._evict_one_replaceable(protect_extra)
                if not victim:
                    break
                current.discard(victim)
            if len(current) >= MAX_WATCH_SYMBOLS:
                logger.info(
                    "%s %s 未能入池：形态列表已满(%d)且无可替换币",
                    log_tag,
                    sym_u,
                    MAX_WATCH_SYMBOLS,
                )
                break
            if self.tracker.add_watch(sym_u):
                current.add(sym_u)
                self.tracker.bump_watch_to_top(sym_u)
                added.append(sym_u)

        if added:
            logger.info(
                "📈 %s → 形态追踪 +%d：%s",
                log_tag,
                len(added),
                ", ".join(added),
            )
        elif bumped:
            logger.debug(
                "%s 已在池内置顶 %d：%s",
                log_tag,
                len(bumped),
                ", ".join(bumped[:8]),
            )
        return added

    def get_watchlist(self) -> list[dict[str, Any]]:
        now = time.time()
        return [
            {
                "symbol": w.symbol,
                "interval": w.interval,
                "added_at": w.added_at,
                "pinned": w.is_pinned,
                "pinned_until": w.pinned_until if w.is_pinned else 0,
                "pin_remaining_sec": max(0, int(w.pinned_until - now)) if w.is_pinned else 0,
            }
            for w in self.tracker.list_watchlist()
        ]

    def get_payload(
        self,
        *,
        pool_meta: dict[str, Any] | None = None,
        fallback_symbols: list[str] | None = None,
    ) -> dict[str, Any]:
        candidates = resolve_heavyweight_candidates(
            self._last_pool_rows,
            fallback_symbols=fallback_symbols,
        )
        heavy_count = len(candidates)
        if heavy_count == 0 and pool_meta:
            heavy_count = int(pool_meta.get("heavyweight_count") or 0)
        return {
            "scan_ts": self._last_scan_ts,
            "watchlist": self.get_watchlist(),
            "states": self._last_states,
            "pattern_alerts": self._last_alerts,
            "heavyweight_pool_size": heavy_count,
            "auto_pick_count": PATTERN_AUTO_PICK_COUNT,
            "card_reserved_slots": PATTERN_CARD_RESERVED,
            "max_watch_symbols": MAX_WATCH_SYMBOLS,
            "multi_board_min": PATTERN_MULTI_BOARD_MIN,
            "watchlist_refresh_sec": PATTERN_WATCHLIST_REFRESH_SEC,
            "watchlist_refresh_tf": PATTERN_WATCHLIST_REFRESH_TF,
            "last_watchlist_refresh_ts": self._last_watchlist_refresh_ts,
            # 供 collect:ui 守护进程识别是否为本仓库实例（避免占用同端口的旧/旁路进程）
            "package_root": str(Path(__file__).resolve().parent),
        }

    async def scan(
        self,
        session: aiohttp.ClientSession,
        *,
        base_url: str = FAPI_BASE_URL,
        scan_ts: float | None = None,
        pool_rows: list[dict[str, Any]] | None = None,
        fallback_symbols: list[str] | None = None,
        protect_symbols: set[str] | None = None,
        hot_tickers: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        if pool_rows:
            self._last_pool_rows = pool_rows
            self.tracker.expire_pins()
            self.tracker.expire_stale()
            # 先清不活跃，再热钱/OI 入池
            self.prune_inactive_watch(protect_extra=protect_symbols)
            self.ensure_auto_watchlist(pool_rows, fallback_symbols=fallback_symbols)
            self.refresh_watchlist_from_hot(
                pool_rows,
                fallback_symbols=fallback_symbols,
                protect_extra=protect_symbols,
            )
            # 上限调大后：未满则每轮补齐（不依赖 2h 热钱刷新）
            self.fill_watchlist_to_capacity(
                pool_rows, fallback_symbols=fallback_symbols
            )
            # 每轮扫描：涨幅榜 ∩ 持仓正榜 → 立即加入形态追踪
            self.ingest_gainers_oi_intersection(
                pool_rows,
                protect_extra=protect_symbols,
            )
            # 每轮扫描：OI 异动 ∩ 多榜共振 → 及时更新形态监听
            self.ingest_oi_anomaly_multiboard(
                pool_rows,
                hot_tickers=hot_tickers,
                protect_extra=protect_symbols,
            )
            # 雷达 OI 放大（告警 / 高变动率）→ 及时入池
            self.ingest_oi_amplified(
                pool_rows,
                hot_tickers=hot_tickers,
                protect_extra=protect_symbols,
            )

        watchlist = self.tracker.list_watchlist()
        if not watchlist:
            self._last_alerts = []
            self._last_states = []
            self._last_scan_ts = scan_ts or time.time()
            return []

        self.tracker.expire_stale()
        # 扫描后再次清理刚标为 EXPIRED 的币（下一轮也会清；此处加速腾位给 OI 放大）
        self.prune_inactive_watch(protect_extra=protect_symbols)
        watchlist = self.tracker.list_watchlist()
        symbols = [w.symbol for w in watchlist]
        klines_map = await fetch_pattern_klines_batch(
            session, base_url=base_url, symbols=symbols
        )

        alerts: list[dict[str, Any]] = []
        states: list[dict[str, Any]] = []

        for item in watchlist:
            sym = item.symbol
            klines = klines_map.get(sym) or []
            if not klines:
                states.append(self._state_dict(sym, item.interval, None))
                continue

            kline_close_time = int(klines[-1][6])
            row = self.tracker.get_state(sym)
            current_status = row.status if row else STATUS_SEARCHING
            state_data = {
                "h_max": row.h_max if row else 0.0,
                "lh_price": row.lh_price if row else 0.0,
                "l1": row.l1 if row else 0.0,
                "hl": row.hl if row else 0.0,
                "trigger_price": row.trigger_price if row else 0.0,
            }

            if row and row.trigger_emitted:
                states.append(self._state_dict(sym, item.interval, row))
                continue

            if row and kline_close_time <= row.last_kline_close_time:
                states.append(self._state_dict(sym, item.interval, row))
                continue

            snap, fire = evaluate_pattern(
                klines,
                current_status=current_status,
                state=state_data,
            )

            if snap.status == STATUS_LH and current_status in (STATUS_SEARCHING, ""):
                mtf = await self._fetch_mtf_context(session, base_url=base_url, symbol=sym)
                if not mtf.get("allow_short", True):
                    logger.info(
                        "MTF 过滤阶段1 %s: %s",
                        sym,
                        mtf.get("block_reason") or mtf.get("summary"),
                    )
                    states.append(self._state_dict(sym, item.interval, row))
                    continue
                self.tracker.save_state(
                    sym,
                    status=snap.status,
                    h_max=snap.h_max,
                    lh_price=snap.lh_price,
                    kline_close_time=kline_close_time,
                    message=snap.message,
                )
                logger.info("📐 形态阶段1 %s LH=%.6f Hmax=%.6f", sym, snap.lh_price, snap.h_max)

            elif snap.status == STATUS_WAITING:
                self.tracker.save_state(
                    sym,
                    status=snap.status,
                    lh_price=snap.lh_price,
                    l1=snap.l1,
                    hl=snap.hl,
                    trigger_price=snap.trigger_price,
                    kline_close_time=kline_close_time,
                    message=snap.message,
                )

            elif snap.status == STATUS_TRIGGER and fire:
                self.tracker.mark_triggered(sym, kline_close_time)
                alert = {
                    "symbol": sym,
                    "type": "pattern_bull_continuation",
                    "interval": item.interval,
                    "status": STATUS_TRIGGER,
                    "status_label": STATUS_LABELS[STATUS_TRIGGER],
                    "lh_price": snap.lh_price,
                    "hl": snap.hl,
                    "trigger_price": snap.trigger_price,
                    "hh_price": snap.hh_price,
                    "last_price": float(klines[-1][4]),
                    "message": snap.message,
                    "scan_ts": scan_ts or time.time(),
                    "kline_close_time": kline_close_time,
                }
                alerts.append(alert)
                logger.info("🚀 形态扳机 %s 突破 %.6f", sym, snap.trigger_price)

            elif current_status not in (STATUS_SEARCHING,):
                self.tracker.save_state(
                    sym,
                    status=snap.status,
                    h_max=snap.h_max or state_data.get("h_max", 0.0),
                    lh_price=snap.lh_price or state_data.get("lh_price", 0.0),
                    l1=snap.l1 or state_data.get("l1", 0.0),
                    hl=snap.hl or state_data.get("hl", 0.0),
                    trigger_price=snap.trigger_price or state_data.get("trigger_price", 0.0),
                    hh_price=snap.hh_price,
                    kline_close_time=kline_close_time,
                    message=snap.message,
                )

            updated = self.tracker.get_state(sym)
            states.append(self._state_dict(sym, item.interval, updated))

        self._last_alerts = alerts
        self._last_states = states
        self._last_scan_ts = scan_ts or time.time()

        try:
            combo_alerts = await asyncio.wait_for(
                self._scan_candle_oi_combos(
                    session,
                    base_url=base_url,
                    klines_map=klines_map,
                    watchlist=watchlist,
                    scan_ts=self._last_scan_ts,
                ),
                timeout=45,
            )
            if combo_alerts:
                self._last_alerts = combo_alerts + self._last_alerts
                alerts = self._last_alerts
        except asyncio.TimeoutError:
            logger.warning("形态+OI 短线扫描超时（45s），跳过")
        except Exception as exc:  # noqa: BLE001
            logger.warning("形态+OI 短线扫描失败: %s", exc)

        return alerts

    async def _scan_candle_oi_combos(
        self,
        session: aiohttp.ClientSession,
        *,
        base_url: str,
        klines_map: dict[str, list],
        watchlist: list[Any],
        scan_ts: float,
    ) -> list[dict[str, Any]]:
        """最近收盘柱：K 线形态 ∩ 柱级 OI 异动 → Toast + Telegram 推荐短线。"""
        now_ms = int(time.time() * 1000)
        iv_by_sym = {w.symbol: w.interval for w in watchlist}
        candidates: list[str] = []

        for sym, klines in klines_map.items():
            if not klines or len(klines) < 30:
                continue
            try:
                df = enrich_indicators(klines_to_df(klines))
                if df.empty or "bb_basis" not in df.columns:
                    continue
                # 无 OI 先看是否有形态；有再拉 OI 确认交集
                markers = collect_candle_signal_markers(df)
                closed_idx = len(df) - 1
                if "close_time" in df.columns:
                    try:
                        ct = int(df.iloc[closed_idx]["close_time"])
                        if ct > now_ms and closed_idx > 0:
                            closed_idx -= 1
                    except (TypeError, ValueError):
                        pass
                closed_ts = int(df.iloc[closed_idx]["open_time"] // 1000)
                has_pat = any(
                    int(m.get("time") or 0) == closed_ts
                    and str(m.get("kind") or "") in PATTERN_MARKER_KINDS
                    for m in markers
                )
                if has_pat:
                    candidates.append(sym)
            except Exception:  # noqa: BLE001
                continue

        if not candidates:
            return []

        sem = asyncio.Semaphore(max(4, min(OI_OI_BATCH_CONCURRENCY, 12)))

        async def _oi_one(sym: str) -> tuple[str, dict[int, float]]:
            async with sem:
                oi = await fetch_open_interest_hist(
                    session,
                    base_url=base_url,
                    symbol=sym,
                    interval=iv_by_sym.get(sym) or PATTERN_KLINE_INTERVAL,
                    limit=min(120, PATTERN_KLINE_LIMIT),
                )
                return sym, oi

        oi_pairs = await asyncio.gather(
            *[_oi_one(s) for s in candidates],
            return_exceptions=True,
        )
        oi_by_sym: dict[str, dict[int, float]] = {}
        for item in oi_pairs:
            if isinstance(item, Exception):
                continue
            sym, oi = item
            if oi:
                oi_by_sym[sym] = oi

        out: list[dict[str, Any]] = []
        for sym in candidates:
            oi_map = oi_by_sym.get(sym) or {}
            if not oi_map:
                continue
            klines = klines_map.get(sym) or []
            try:
                df = enrich_indicators(klines_to_df(klines))
                df["oi"] = [
                    oi_map.get(int(ot // 1000), float("nan"))
                    for ot in df["open_time"].tolist()
                ]
                combos = find_last_closed_pattern_oi_combos(df, now_ms=now_ms)
            except Exception:  # noqa: BLE001
                continue
            if not combos:
                continue
            hit = combos[0]
            close_ts = int(hit["time"])
            dedupe = f"{sym}:{close_ts}:{hit.get('kind')}"
            if dedupe in self._combo_seen:
                continue
            self._combo_seen.add(dedupe)
            if len(self._combo_seen) > 800:
                self._combo_seen = set(list(self._combo_seen)[-400:])

            kind = str(hit.get("kind") or "")
            text = str(hit.get("text") or kind)
            side_hint = _combo_side_hint(kind)
            last_price = float(klines[-1][4]) if klines else float(hit.get("price") or 0)
            iv = iv_by_sym.get(sym) or PATTERN_KLINE_INTERVAL
            alert = {
                "symbol": sym,
                "type": "candle_pattern_oi",
                "interval": iv,
                "status": "CANDLE_OI_COMBO",
                "status_label": "形态+OI · 推荐短线",
                "signal_kind": kind,
                "signal_text": text,
                "side_hint": side_hint,
                "last_price": last_price,
                "message": f"{text} · 推荐{side_hint}",
                "scan_ts": scan_ts,
                "kline_close_time": close_ts * 1000,
            }
            out.append(alert)
            logger.info("⚡ 形态+OI短线 %s %s %s", sym, text, side_hint)
            try:
                await send_pattern_oi_telegram_async(alert)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Telegram 短线推荐失败 %s: %s", sym, exc)

        return out

    async def _fetch_mtf_context(
        self,
        session: aiohttp.ClientSession,
        *,
        base_url: str,
        symbol: str,
    ) -> dict[str, Any]:
        """拉 4h / 1d K 线并计算多周期共振过滤。"""
        sym = symbol.strip().upper()
        k4, k1d = await asyncio.gather(
            fetch_pattern_klines(
                session,
                base_url=base_url,
                symbol=sym,
                interval="4h",
                limit=200,
            ),
            fetch_pattern_klines(
                session,
                base_url=base_url,
                symbol=sym,
                interval="1d",
                limit=120,
            ),
        )
        return build_mtf_context({"4h": k4, "1d": k1d})

    async def get_chart_data(
        self,
        session: aiohttp.ClientSession,
        symbol: str,
        *,
        base_url: str = FAPI_BASE_URL,
        pool_rows: list[dict[str, Any]] | None = None,
        interval: str | None = None,
        limit: int | None = None,
        end_time: int | None = None,
    ) -> dict[str, Any]:
        sym = symbol.strip().upper()
        tf = interval or PATTERN_KLINE_INTERVAL
        req_limit = limit if limit is not None else PATTERN_CHART_DEFAULT_LIMIT
        if end_time is None:
            req_limit = max(req_limit, PATTERN_CHART_DEFAULT_LIMIT)
        req_limit = min(req_limit, PATTERN_CHART_MAX_LIMIT)

        klines = await fetch_pattern_klines(
            session,
            base_url=base_url,
            symbol=sym,
            interval=tf,
            limit=req_limit,
            end_time=end_time,
        )

        partial = end_time is not None
        row = self.tracker.get_state(sym)
        state_dict: dict[str, Any] = {}
        if row and not partial:
            state_dict = {
                "status": row.status,
                "status_label": STATUS_LABELS.get(row.status, row.status),
                "h_max": row.h_max,
                "lh_price": row.lh_price,
                "l1": row.l1,
                "hl": row.hl,
                "trigger_price": row.trigger_price,
                "hh_price": row.hh_price,
                "message": row.message,
            }

        oi_by_time: dict[int, float] = {}
        funding: dict[str, Any] = {}
        mtf: dict[str, Any] = {}
        if not partial:
            oi_by_time = await fetch_open_interest_hist(
                session,
                base_url=base_url,
                symbol=sym,
                interval=tf,
                limit=req_limit,
            )
            funding, mtf = await asyncio.gather(
                fetch_premium_index(session, base_url=base_url, symbol=sym),
                self._fetch_mtf_context(session, base_url=base_url, symbol=sym),
            )

        derivatives_ctx = None
        if not partial and klines:
            derivatives_ctx = build_derivatives_context(
                klines=klines,
                oi_by_time=oi_by_time or None,
                funding=funding,
                mtf=mtf,
                structure=state_dict,
            )

        chart = build_pattern_chart_payload(
            klines,
            state=state_dict,
            oi_by_time=oi_by_time or None,
            derivatives_ctx=derivatives_ctx,
        )

        if partial:
            return {
                "symbol": sym,
                "interval": tf,
                "partial": True,
                "candles": chart["candles"],
                "bb": chart["bb"],
                "vegas": chart.get("vegas") or {},
                "macd": chart.get("macd") or {"line": [], "signal": [], "hist": []},
                "has_more": len(klines) >= req_limit,
            }

        ticker: dict[str, Any] = {}
        if pool_rows:
            for r in pool_rows:
                if r.get("symbol") == sym:
                    ticker = {
                        "last_price": r.get("last_price"),
                        "price_change_pct_24h": r.get("price_change_pct_24h"),
                        "current_oi_usd": r.get("current_oi_usd"),
                        "quote_volume": r.get("quote_volume"),
                        "oi_tier": r.get("oi_tier"),
                    }
                    break

        if not ticker and chart["candles"]:
            last = chart["candles"][-1]
            ticker["last_price"] = last["close"]

        return {
            "symbol": sym,
            "interval": tf,
            "partial": False,
            "has_more": len(klines) >= req_limit,
            "ticker": ticker,
            "state": state_dict,
            **chart,
        }

    def _state_dict(
        self,
        symbol: str,
        interval: str,
        row: Any,
    ) -> dict[str, Any]:
        if row is None:
            return {
                "symbol": symbol,
                "interval": interval,
                "status": STATUS_SEARCHING,
                "status_label": STATUS_LABELS[STATUS_SEARCHING],
                "message": "等待 K 线",
            }
        return {
            "symbol": row.symbol,
            "interval": interval,
            "status": row.status,
            "status_label": STATUS_LABELS.get(row.status, row.status),
            "h_max": row.h_max,
            "lh_price": row.lh_price,
            "l1": row.l1,
            "hl": row.hl,
            "trigger_price": row.trigger_price,
            "hh_price": row.hh_price,
            "message": row.message,
            "updated_at": row.updated_at,
            "trigger_emitted": row.trigger_emitted,
        }
