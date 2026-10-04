"""形态监控引擎 — 自选 N 币 × 15m K 线 × 两步状态机。"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

import aiohttp

from oi_mornitor.config import (
    BREAKOUT_MATRIX_TF,
    CANDLE_CARD_ALT_INTERVALS,
    CANDLE_CARD_ALT_RANK_TF,
    CANDLE_CARD_ALT_TOP_N,
    CANDLE_CARD_MAJOR_INTERVALS,
    CANDLE_CARD_MAJOR_SYMBOLS,
    CANDLE_CARD_REFRESH_SEC,
    CARD_PUSH_COOLDOWN_BARS,
    FAPI_BASE_URL,
    HTTP_TIMEOUT_SEC,
    MATRIX_TOP_N,
    OI_OI_BATCH_CONCURRENCY,
    PATTERN_AUTO_PICK_COUNT,
    PATTERN_CARD_RESERVED,
    PATTERN_CHART_DEFAULT_LIMIT,
    PATTERN_CHART_MAX_LIMIT,
    PATTERN_INACTIVE_PURGE_SEC,
    PATTERN_KLINE_INTERVAL,
    PATTERN_KLINE_LIMIT,
    PATTERN_MANUAL_RESERVED,
    PATTERN_MULTI_BOARD_MIN,
    PATTERN_OI_AMPLIFY_PCT,
    PATTERN_SEARCHING_STALE_SEC,
    PATTERN_WATCHLIST_REFRESH_SEC,
    PATTERN_WATCHLIST_REFRESH_TF,
    STRUCTURE_KLINE_LIMIT,
)
from oi_mornitor.exchange_sources import fetch_klines_with_fallback, klines_page_has_more
from oi_mornitor.market_snapshot import TIER_HEAVY
from oi_mornitor.matrix_breakout import collect_matrix_leaderboard
from oi_mornitor.pattern_detector import (
    STATUS_EXPIRED,
    STATUS_LABELS,
    STATUS_SEARCHING,
    build_pattern_chart_payload,
    enrich_indicators,
)
from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.derivatives_metrics import (
    build_derivatives_context,
    build_mtf_context,
    fetch_premium_index,
)
from oi_mornitor.pattern_state_tracker import MAX_WATCH_SYMBOLS, PatternStateTracker, SLOT_MANUAL
from oi_mornitor.rank_metrics import TF_LABELS
from oi_mornitor.strategy.candle_signals import (
    PATTERN_MARKER_KINDS,
    closed_bar_index,
    collect_candle_signal_markers,
    find_last_closed_candle_card_hits,
    find_last_closed_pattern_oi_combos,
)
from oi_mornitor.strategy.structure_signals import (
    STRUCTURE_CARD_INTERVALS,
    STRUCTURE_PUSH_COOLDOWN_BARS,
    filter_structure_card_hits,
    find_last_closed_structure_hits,
)
from oi_mornitor.signal_policy import is_disabled_pattern_interval
from oi_mornitor.symbol_aliases import is_stablecoin_symbol
from oi_mornitor.telegram_push_toggles import (
    is_candle_push_enabled,
    is_structure_push_enabled,
)
from oi_mornitor.notify_telegram import (
    send_candle_card_telegram_async,
    send_pattern_oi_telegram_async,
    send_structure_card_telegram_async,
)
from oi_mornitor.signal_log import insert_signal
from oi_mornitor.signal_policy import evaluate_marker_text
from oi_mornitor.strategy.params import PARAMS_VERSION
from oi_mornitor.tv_alert_sync import symbols_on_n_boards

logger = logging.getLogger("OI_Radar")

# 涨幅∩持仓自动入池时，可被腾出的状态（旧 LH/扳机状态机已移除）
_EVICTABLE_PATTERN_STATUSES = frozenset({STATUS_SEARCHING, STATUS_EXPIRED})
_SHORT_PATTERN_KINDS = frozenset({
    "shooting_star",
    "continuous_upper_wick",
    "continuous_non_upper_wick",
})
_LONG_PATTERN_KINDS = frozenset({
    "hammer",
    "inverted_hammer",
    "inv_hammer",
    "continuous_lower_wick",
    "continuous_non_lower_wick",
})
_CARD_SEEN_HIGH_WATER = 1200
_CARD_SEEN_KEEP = 600


def remember_card_seen(
    seen: OrderedDict[str, bool],
    key: str,
    *,
    high_water: int = _CARD_SEEN_HIGH_WATER,
    keep: int = _CARD_SEEN_KEEP,
) -> None:
    """发送成功后写入去重键；按插入顺序裁剪，避免 set 无序丢掉新键。"""
    seen[key] = True
    seen.move_to_end(key)
    if len(seen) > high_water:
        while len(seen) > keep:
            seen.popitem(last=False)
_INTERVAL_SECONDS = {"5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}


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
    rows, _src = await fetch_pattern_klines_with_source(
        session,
        base_url=base_url,
        symbol=symbol,
        interval=interval,
        limit=limit,
        end_time=end_time,
    )
    return rows


async def fetch_pattern_klines_with_source(
    session: aiohttp.ClientSession,
    *,
    base_url: str,
    symbol: str,
    interval: str = PATTERN_KLINE_INTERVAL,
    limit: int = PATTERN_KLINE_LIMIT,
    end_time: int | None = None,
) -> tuple[list[list[Any]], str]:
    """同 fetch_pattern_klines，额外返回来源 id（binance/okx/…）。"""
    sym = symbol.strip().upper()
    cap = min(max(limit, 1), PATTERN_CHART_MAX_LIMIT)
    return await fetch_klines_with_fallback(
        session,
        symbol=sym,
        interval=interval,
        limit=cap,
        end_time=end_time,
        binance_base_url=base_url,
    )


async def fetch_open_interest_hist(
    session: aiohttp.ClientSession,
    *,
    base_url: str,
    symbol: str,
    interval: str,
    limit: int = 500,
) -> dict[int, float]:
    """币安 openInterestHist → {open_time秒: sumOpenInterest}。失败返回空。"""
    from oi_mornitor import http_backoff
    from oi_mornitor.symbol_aliases import normalize_usdt_symbol

    sym = normalize_usdt_symbol(symbol)
    if not sym:
        return {}
    cap = min(max(limit, 1), 500)
    period = (interval or "15m").strip().lower()
    url = (
        f"{base_url.rstrip('/')}/futures/data/openInterestHist"
        f"?symbol={sym}&period={period}&limit={cap}"
    )
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT_SEC)
    status, data = await http_backoff.get_json(
        session,
        url,
        timeout=timeout,
        max_attempts=3,
        label=f"oi-hist:{sym}",
    )
    if status != 200 or not isinstance(data, list):
        if status and status != 200:
            logger.warning("OI hist 拉取失败 %s %s HTTP %s", sym, period, status)
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
            from oi_mornitor import http_backoff

            if http_backoff.is_cooling():
                skip_binance = True
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
            if http_backoff.is_cooling():
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
        and not is_stablecoin_symbol(str(r.get("symbol") or ""))
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
        and not is_stablecoin_symbol(str(r.get("symbol") or ""))
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


def _abs_amplitude_score(row: dict[str, Any], tf: str, domain: str) -> float:
    """幅度分：价格用 |涨跌幅|；流动性(合约流入)/OI 用 |magnitude_usd|。"""
    m = _rank_metric(row, tf, domain)
    if domain == "price":
        return abs(float(m.get("change_rate") or 0.0))
    return abs(float(m.get("magnitude_usd") or 0.0))


def _signed_price_change(row: dict[str, Any], tf: str) -> float:
    m = _rank_metric(row, tf, "price")
    try:
        return float(m.get("change_rate") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _top_amplitude_symbols(
    rows: list[dict[str, Any]],
    tf: str,
    domain: str,
    *,
    top_n: int,
    exclude: set[str] | None = None,
) -> list[str]:
    exclude = {s.upper() for s in (exclude or set())}
    ranked = sorted(
        rows,
        key=lambda r: _abs_amplitude_score(r, tf, domain),
        reverse=True,
    )
    out: list[str] = []
    for row in ranked:
        if _abs_amplitude_score(row, tf, domain) <= 0:
            continue
        sym = str(row.get("symbol") or "").upper()
        if not sym or sym in exclude:
            continue
        out.append(sym)
        if len(out) >= top_n:
            break
    return out


def _eligible_alt_pool_rows(
    pool_rows: list[dict[str, Any]],
    *,
    majors: set[str],
) -> list[dict[str, Any]]:
    return [
        r
        for r in pool_rows
        if r.get("status") != "warming"
        and str(r.get("symbol") or "").upper() not in majors
        and not is_stablecoin_symbol(str(r.get("symbol") or ""))
    ]


def pick_candle_card_alt_flow_symbols(
    pool_rows: list[dict[str, Any]],
    *,
    majors: set[str] | None = None,
    top_n: int = CANDLE_CARD_ALT_TOP_N,
    tf: str = CANDLE_CARD_ALT_RANK_TF,
) -> list[str]:
    """山寨卡片 · 合约流入 TopN（射击之星 / 顶部结构主池）。"""
    majors = {s.upper() for s in (majors or CANDLE_CARD_MAJOR_SYMBOLS)}
    eligible = _eligible_alt_pool_rows(pool_rows, majors=majors)
    return _top_amplitude_symbols(
        eligible, tf, "contract_flow", top_n=top_n, exclude=majors
    )


def _top_signed_price_symbols(
    rows: list[dict[str, Any]],
    tf: str,
    *,
    top_n: int,
    direction: str,
    exclude: set[str] | None = None,
) -> list[str]:
    """真涨幅（change_rate>0）或真跌幅（change_rate<0）榜。"""
    exclude = {s.upper() for s in (exclude or set())}
    scored: list[tuple[str, float]] = []
    for row in rows:
        rate = _signed_price_change(row, tf)
        if direction == "gain" and rate <= 0:
            continue
        if direction == "lose" and rate >= 0:
            continue
        sym = str(row.get("symbol") or "").upper()
        if not sym or sym in exclude:
            continue
        scored.append((sym, rate))
    reverse = direction == "gain"
    scored.sort(key=lambda x: x[1], reverse=reverse)
    return [sym for sym, _ in scored[:top_n]]


def pick_candle_card_alt_gainer_symbols(
    pool_rows: list[dict[str, Any]],
    *,
    majors: set[str] | None = None,
    top_n: int = CANDLE_CARD_ALT_TOP_N,
    tf: str = CANDLE_CARD_ALT_RANK_TF,
) -> list[str]:
    """山寨卡片 · 真涨幅榜（change_rate > 0）。"""
    majors = {s.upper() for s in (majors or CANDLE_CARD_MAJOR_SYMBOLS)}
    eligible = _eligible_alt_pool_rows(pool_rows, majors=majors)
    return _top_signed_price_symbols(
        eligible, tf, top_n=top_n, direction="gain", exclude=majors
    )


def pick_candle_card_alt_loser_symbols(
    pool_rows: list[dict[str, Any]],
    *,
    majors: set[str] | None = None,
    top_n: int = CANDLE_CARD_ALT_TOP_N,
    tf: str = CANDLE_CARD_ALT_RANK_TF,
) -> list[str]:
    """山寨卡片 · 真跌幅榜（change_rate < 0）。"""
    majors = {s.upper() for s in (majors or CANDLE_CARD_MAJOR_SYMBOLS)}
    eligible = _eligible_alt_pool_rows(pool_rows, majors=majors)
    return _top_signed_price_symbols(
        eligible, tf, top_n=top_n, direction="lose", exclude=majors
    )


def pick_candle_card_alt_symbols(
    pool_rows: list[dict[str, Any]],
    *,
    majors: set[str] | None = None,
    top_n: int = CANDLE_CARD_ALT_TOP_N,
    tf: str = CANDLE_CARD_ALT_RANK_TF,
) -> list[str]:
    """山寨推送池并集（兼容旧调用）。"""
    flow = pick_candle_card_alt_flow_symbols(
        pool_rows, majors=majors, top_n=top_n, tf=tf
    )
    gainers = pick_candle_card_alt_gainer_symbols(
        pool_rows, majors=majors, top_n=top_n, tf=tf
    )
    losers = pick_candle_card_alt_loser_symbols(
        pool_rows, majors=majors, top_n=top_n, tf=tf
    )
    out: list[str] = []
    seen: set[str] = set()
    for sym in flow + gainers + losers:
        if sym in seen:
            continue
        seen.add(sym)
        out.append(sym)
    return out


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
        try:
            n_state = self.tracker.purge_breakout_states()
            from oi_mornitor.pattern_alert_stats import purge_retired_pattern_stats
            from oi_mornitor.pattern_alert_ticker import purge_retired_pattern_ticker_items

            n_ticker = purge_retired_pattern_ticker_items()
            n_stats = purge_retired_pattern_stats()
            if n_state or n_ticker or n_stats:
                logger.info(
                    "已清理停推/legacy 数据：状态 %d · ticker %d · 胜率 %d",
                    n_state,
                    n_ticker,
                    n_stats,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("清理停推/legacy 数据失败: %s", exc)
        self._last_alerts: list[dict[str, Any]] = []
        self._last_states: list[dict[str, Any]] = []
        self._last_scan_ts: float = 0.0
        self._last_pool_rows: list[dict[str, Any]] = []
        self._last_watchlist_refresh_ts: float = 0.0
        # symbol:close_ts → 已推过的形态+OI 短线推荐
        self._combo_seen: set[str] = set()
        # symbol:interval:kind:close_ts → 已推过的蜡烛卡片
        self._card_seen: OrderedDict[str, bool] = OrderedDict()
        # symbol:interval:side → 最近一次实际推送的收盘时间戳（秒），用于同向节流
        self._card_last_emit: dict[str, int] = {}
        # (symbol, interval) → (fetched_at, klines)
        self._card_kline_cache: dict[tuple[str, str], tuple[float, list]] = {}
        # 可选：潜力暴涨漏斗引擎（由 RadarService 注入）
        self.moonshot_engine = None
        self._last_moonshot_payload: dict[str, Any] = {}

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
        sym = (symbol or "").strip().upper()
        if not sym or is_stablecoin_symbol(sym):
            return False
        return self.tracker.add_watch(sym)

    def add_manual_symbol(self, symbol: str) -> dict[str, Any]:
        """
        手动输入专用槽：全局最多 1 个。
        新币替换旧手动币；列表满时仍优先腾位加入（预留 PATTERN_MANUAL_RESERVED）。
        """
        sym = (symbol or "").strip().upper()
        if not sym:
            return {"ok": False, "error": "symbol required"}
        if is_stablecoin_symbol(sym):
            return {"ok": False, "error": "stablecoin excluded", "symbol": sym}
        if PATTERN_MANUAL_RESERVED <= 0:
            ok = self.tracker.add_watch(sym)
            return {
                "ok": ok,
                "symbol": sym,
                "replaced": None,
                "error": None if ok else "add failed or watchlist full",
            }

        prev = self.tracker.get_manual_slot_symbol()
        replaced: str | None = None
        if prev and prev != sym:
            # 旧手动币若仍是「仅手动槽」占用，直接踢出；已转正式监听则只清 slot 标记
            self.tracker.remove_watch(prev)
            replaced = prev

        # 清掉残留 manual 标记（防御）
        for other in self.tracker.clear_manual_slots_except(sym):
            if other != replaced:
                replaced = replaced or other

        watch = {w.symbol.upper() for w in self.tracker.list_watchlist()}
        if sym in watch:
            self.tracker.set_watch_slot(sym, SLOT_MANUAL)
            self.tracker.bump_watch_to_top(sym)
            return {"ok": True, "symbol": sym, "replaced": replaced, "already": True}

        # 列表满：先腾可替换位，再允许手动预留溢出 1 格
        while len(self.tracker.list_watchlist()) >= MAX_WATCH_SYMBOLS:
            evicted = self._evict_one_replaceable()
            if not evicted:
                break

        ok = self.tracker.add_watch(sym, slot=SLOT_MANUAL, allow_over_max=True)
        if not ok:
            return {
                "ok": False,
                "symbol": sym,
                "replaced": replaced,
                "error": "add failed or watchlist full (no free slot)",
            }
        self.tracker.bump_watch_to_top(sym)
        logger.info(
            "⌨️ 手动槽加入 %s%s",
            sym,
            f"（替换 {replaced}）" if replaced else "",
        )
        return {"ok": True, "symbol": sym, "replaced": replaced, "already": False}

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
        fill_cap = max(0, MAX_WATCH_SYMBOLS - self._manual_reserve_free())
        if len(current) >= fill_cap:
            return []
        need = fill_cap - len(current)
        picked = pick_hot_flow_and_oi(
            pool_rows,
            count=max(need * 2, need),
            fallback_symbols=fallback_symbols,
        )
        added: list[str] = []
        for sym in picked:
            if len(current) >= fill_cap:
                break
            sym_u = str(sym).upper()
            if not sym_u or sym_u in current:
                continue
            if self.tracker.add_watch(sym_u):
                current.add(sym_u)
                added.append(sym_u)
        if added:
            logger.info(
                "📈 形态池补齐到 %d（手动预留 %d）：+%d → %s",
                fill_cap,
                self._manual_reserve_free(),
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
        for w in self.tracker.list_watchlist():
            if w.is_pinned:
                protected.add(w.symbol.upper())
            if w.is_manual_slot:
                protected.add(w.symbol.upper())
        return protected

    def _manual_reserve_free(self) -> int:
        """热榜/补齐应预留的空位数（已有手动币则不再额外占空位）。"""
        if PATTERN_MANUAL_RESERVED <= 0:
            return 0
        return 0 if self.tracker.get_manual_slot_symbol() else int(PATTERN_MANUAL_RESERVED)

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
        置顶 / 手动槽 / protect_extra（如沙盒持仓）保留；其余可被替换。
        """
        now = time.time()
        if not force and self._last_watchlist_refresh_ts > 0:
            if now - self._last_watchlist_refresh_ts < PATTERN_WATCHLIST_REFRESH_SEC:
                return []

        current = [w.symbol.upper() for w in self.tracker.list_watchlist()]
        protected = self._protected_symbols(protect_extra)
        # 只保护仍在 watchlist 内的
        protected &= set(current)

        # 热榜最多占用「总槽 - 卡片预留 - 手动预留空位」；手动/卡片置顶币始终保留
        manual_free = self._manual_reserve_free()
        hot_cap = max(0, MAX_WATCH_SYMBOLS - PATTERN_CARD_RESERVED - manual_free)
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

    def ingest_moonshot_candidates(
        self,
        *,
        protect_extra: set[str] | None = None,
    ) -> list[str]:
        """潜力暴涨高分币 → 占形态监听槽（宁缺毋滥，按分排序）。"""
        eng = self.moonshot_engine
        if eng is None or not getattr(eng, "enabled", False):
            return []
        try:
            hits = eng.top_for_watchlist(limit=MAX_WATCH_SYMBOLS)
        except Exception as exc:  # noqa: BLE001
            logger.warning("moonshot 候选读取失败: %s", exc)
            return []
        return self._ingest_symbols_to_watch(
            hits,
            protect_extra=protect_extra,
            log_tag="潜力暴涨",
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
                "slot": w.slot or "",
                "manual": w.is_manual_slot,
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
        ms_payload: dict[str, Any] = dict(self._last_moonshot_payload or {})
        if self.moonshot_engine is not None and not ms_payload:
            try:
                ms_payload = self.moonshot_engine.get_payload()
            except Exception:
                ms_payload = {}
        return {
            "scan_ts": self._last_scan_ts,
            "watchlist": self.get_watchlist(),
            "states": self._last_states,
            "pattern_alerts": self._last_alerts,
            "heavyweight_pool_size": heavy_count,
            "auto_pick_count": PATTERN_AUTO_PICK_COUNT,
            "card_reserved_slots": PATTERN_CARD_RESERVED,
            "manual_reserved_slots": PATTERN_MANUAL_RESERVED,
            "manual_slot_symbol": self.tracker.get_manual_slot_symbol(),
            "max_watch_symbols": MAX_WATCH_SYMBOLS,
            "multi_board_min": PATTERN_MULTI_BOARD_MIN,
            "watchlist_refresh_sec": PATTERN_WATCHLIST_REFRESH_SEC,
            "watchlist_refresh_tf": PATTERN_WATCHLIST_REFRESH_TF,
            "last_watchlist_refresh_ts": self._last_watchlist_refresh_ts,
            # 供 collect:ui 守护进程识别是否为本仓库实例（避免占用同端口的旧/旁路进程）
            "package_root": str(Path(__file__).resolve().parent),
            **ms_payload,
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
            # 潜力暴涨 A/B 高分 → 占监听槽（不超 50）
            self.ingest_moonshot_candidates(protect_extra=protect_symbols)

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
        # 踢掉稳定币（历史 watchlist / 误入）
        stale = [w.symbol for w in watchlist if is_stablecoin_symbol(w.symbol)]
        for sym in stale:
            try:
                self.tracker.remove_watch(str(sym).upper())
            except Exception:
                pass
        watchlist = [w for w in watchlist if not is_stablecoin_symbol(w.symbol)]
        symbols = [w.symbol for w in watchlist]
        klines_map = await fetch_pattern_klines_batch(
            session, base_url=base_url, symbols=symbols
        )

        alerts: list[dict[str, Any]] = []
        states: list[dict[str, Any]] = [
            self._state_dict(item.symbol, item.interval, None) for item in watchlist
        ]

        # 潜力暴涨：复用本轮 15m K 更新 B/C，合并警报（不叠一堆形态箭头）
        if self.moonshot_engine is not None:
            try:
                ms_alerts = self.moonshot_engine.update_from_15m(
                    klines_map, pool_rows=self._last_pool_rows
                )
                self._last_moonshot_payload = self.moonshot_engine.get_payload()
                for a in ms_alerts:
                    a.setdefault("type", "moonshot_coil")
                    alerts.append(a)
            except Exception as exc:  # noqa: BLE001
                logger.warning("moonshot 15m 更新失败: %s", exc)

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

        if is_candle_push_enabled() or is_structure_push_enabled():
            try:
                card_alerts = await asyncio.wait_for(
                    self._scan_candle_pattern_cards(
                        session,
                        base_url=base_url,
                        klines_map=klines_map,
                        watchlist=watchlist,
                        pool_rows=self._last_pool_rows,
                        scan_ts=self._last_scan_ts,
                    ),
                    timeout=120,
                )
                if card_alerts:
                    self._last_alerts = card_alerts + self._last_alerts
                    alerts = self._last_alerts
            except asyncio.TimeoutError:
                logger.warning("形态/结构卡片扫描超时（120s），跳过")
            except Exception as exc:  # noqa: BLE001
                logger.warning("形态/结构卡片扫描失败: %s", exc)

        try:
            from oi_mornitor.config import MAIN_CARD_INTERVALS
            from oi_mornitor.notify_telegram import send_main_volume_price_telegram_async
            from oi_mornitor.pattern_alert_ticker import record_ticker_from_alerts
            from oi_mornitor.volume_price.ticker_bridge import scan_volume_price_ticker_alerts

            vp_alerts: list[dict[str, Any]] = []
            try:
                vp_tfs = tuple(
                    x for x in ("15m", "1h", "4h") if x in MAIN_CARD_INTERVALS
                ) or ("15m",)
                # Vegas 过滤需 ≥680 根 1h；原先 cap 120 会导致「量价确认·空」永远被滤掉
                vp_1h_limit = min(
                    max(PATTERN_KLINE_LIMIT, 680),
                    PATTERN_CHART_MAX_LIMIT,
                )
                klines_1h_map = await asyncio.wait_for(
                    fetch_pattern_klines_batch(
                        session,
                        base_url=base_url,
                        symbols=symbols,
                        interval="1h",
                        limit=vp_1h_limit,
                    ),
                    timeout=90,
                )
                klines_4h_map: dict[str, list] = {}
                if "4h" in vp_tfs:
                    klines_4h_map = await asyncio.wait_for(
                        fetch_pattern_klines_batch(
                            session,
                            base_url=base_url,
                            symbols=symbols,
                            interval="4h",
                            limit=min(120, PATTERN_KLINE_LIMIT),
                        ),
                        timeout=45,
                    )
                vp_alerts = scan_volume_price_ticker_alerts(
                    klines_map,
                    klines_map_1h=klines_1h_map,
                    klines_map_4h=klines_4h_map or None,
                    signal_tfs=vp_tfs,
                    scan_ts=self._last_scan_ts,
                )
            except asyncio.TimeoutError:
                logger.warning("量价 ticker HTF K 线拉取超时，跳过")
            except Exception as exc:  # noqa: BLE001
                logger.warning("量价 ticker 扫描失败: %s", exc)

            if vp_alerts:
                pushed_main = getattr(self, "_main_vp_pushed_keys", None)
                if not isinstance(pushed_main, set):
                    pushed_main = set()
                    self._main_vp_pushed_keys = pushed_main
                n_main_vp = 0
                for va in vp_alerts:
                    vk = (
                        f"{va.get('type')}:{va.get('symbol')}:"
                        f"{va.get('kline_close_time')}:{va.get('type_label')}"
                    )
                    if vk in pushed_main:
                        continue
                    try:
                        if await send_main_volume_price_telegram_async(va):
                            pushed_main.add(vk)
                            n_main_vp += 1
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("MAIN 量价推送失败: %s", exc)
                if len(pushed_main) > 5000:
                    self._main_vp_pushed_keys = set(list(pushed_main)[-2000:])
                if n_main_vp:
                    logger.info("MAIN 群量价推送 %d 条", n_main_vp)

            n_vp = record_ticker_from_alerts(vp_alerts)
            n_vp_stats = 0
            if vp_alerts:
                try:
                    from oi_mornitor.pattern_alert_stats import record_alert_from_push

                    for va in vp_alerts:
                        if record_alert_from_push(va):
                            n_vp_stats += 1
                except Exception as exc:  # noqa: BLE001
                    logger.warning("量价信号胜率入库失败: %s", exc)
            n = record_ticker_from_alerts(self._last_alerts)
            if n_vp or n or n_vp_stats:
                logger.info(
                    "形态 ticker 落盘 %d 条（量价 %d）；量价胜率入库 %d 条",
                    n + n_vp,
                    n_vp,
                    n_vp_stats,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("形态 ticker 落盘失败: %s", exc)

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
        """形态∩柱级 OI 短线已停推（假反转灌水）；保留接口兼容。"""
        del session, base_url, klines_map, watchlist, scan_ts
        return []

    def _card_emit_throttled(self, sym: str, iv: str, side: str, close_ts: int) -> bool:
        """同币同周期同方向在 CARD_PUSH_COOLDOWN_BARS 根 K 内只推一次。"""
        if CARD_PUSH_COOLDOWN_BARS <= 0:
            return False
        key = f"{sym}:{iv}:{side}"
        last = self._card_last_emit.get(key)
        if last is None:
            return False
        bar_sec = _INTERVAL_SECONDS.get(iv)
        if not bar_sec:
            return False
        return (int(close_ts) - int(last)) <= CARD_PUSH_COOLDOWN_BARS * bar_sec

    def _structure_emit_throttled(self, sym: str, iv: str, side: str, close_ts: int) -> bool:
        """结构卡片：同币同周期同方向 STRUCTURE_PUSH_COOLDOWN_BARS 根 K 内只推一次。"""
        if STRUCTURE_PUSH_COOLDOWN_BARS <= 0:
            return False
        key = f"struct:{sym}:{iv}:{side}"
        last = self._card_last_emit.get(key)
        if last is None:
            return False
        bar_sec = _INTERVAL_SECONDS.get(iv)
        if not bar_sec:
            return False
        return (int(close_ts) - int(last)) <= STRUCTURE_PUSH_COOLDOWN_BARS * bar_sec

    async def _scan_candle_pattern_cards(
        self,
        session: aiohttp.ClientSession,
        *,
        base_url: str,
        klines_map: dict[str, list],
        watchlist: list[Any],
        pool_rows: list[dict[str, Any]] | None = None,
        scan_ts: float,
    ) -> list[dict[str, Any]]:
        """多周期蜡烛形态 + 顶部/底部结构 → Telegram 卡片。

        主流 BTC/ETH/SOL：15m/1h/4h。
        山寨：流入 Top7 + 真涨幅榜 + 真跌幅榜 → 15m/1h。
        """
        if not is_candle_push_enabled() and not is_structure_push_enabled():
            return []

        majors = {s.upper() for s in CANDLE_CARD_MAJOR_SYMBOLS}
        rows = pool_rows if pool_rows is not None else self._last_pool_rows
        alt_flow = pick_candle_card_alt_flow_symbols(rows or [], majors=majors)
        alt_gainers = pick_candle_card_alt_gainer_symbols(rows or [], majors=majors)
        alt_losers = pick_candle_card_alt_loser_symbols(rows or [], majors=majors)
        # 池子尚未暖好时，短暂回退形态 watchlist（排除主流）→ 仅流入池
        if not alt_flow and watchlist:
            alt_flow = [
                str(w.symbol).upper()
                for w in watchlist
                if str(w.symbol).upper() not in majors
            ][: CANDLE_CARD_ALT_TOP_N * 2]

        # (symbol, interval, is_major, pool_role: all|flow|gain|dip)
        jobs: list[tuple[str, str, bool, str]] = []
        for sym in sorted(majors):
            for iv in CANDLE_CARD_MAJOR_INTERVALS:
                jobs.append((sym, iv, True, "all"))
        for sym in sorted(set(alt_flow)):
            for iv in CANDLE_CARD_ALT_INTERVALS:
                jobs.append((sym, iv, False, "flow"))
        for sym in sorted(set(alt_gainers) - set(alt_flow)):
            for iv in CANDLE_CARD_ALT_INTERVALS:
                jobs.append((sym, iv, False, "gain"))
        for sym in sorted(set(alt_losers) - set(alt_flow) - set(alt_gainers)):
            for iv in CANDLE_CARD_ALT_INTERVALS:
                jobs.append((sym, iv, False, "dip"))

        logger.debug(
            "形态卡片任务 majors=%s flow=%s gain=%s dip=%s jobs=%d",
            sorted(majors),
            alt_flow,
            alt_gainers,
            alt_losers,
            len(jobs),
        )
        now = time.time()
        now_ms = int(now * 1000)
        sem = asyncio.Semaphore(max(4, min(OI_OI_BATCH_CONCURRENCY, 10)))
        from oi_mornitor.strategy.params import ema_warmup_bars

        fetch_limit = min(
            max(
                STRUCTURE_KLINE_LIMIT if is_structure_push_enabled() else 120,
                PATTERN_KLINE_LIMIT,
                ema_warmup_bars(144),
            ),
            PATTERN_CHART_MAX_LIMIT,
        )

        async def _klines_for(sym: str, iv: str) -> list:
            key = (sym, iv)
            cached = self._card_kline_cache.get(key)
            refresh = CANDLE_CARD_REFRESH_SEC.get(iv, 180)
            if (
                cached
                and (now - cached[0]) < refresh
                and cached[1]
                and (not is_structure_push_enabled() or len(cached[1]) >= min(180, fetch_limit - 20))
            ):
                return cached[1]
            # 主扫描 15m 可复用（结构关闭或条数够用时）
            if (
                not is_structure_push_enabled()
                and iv == PATTERN_KLINE_INTERVAL
                and sym in klines_map
                and klines_map[sym]
            ):
                return klines_map[sym]
            async with sem:
                from oi_mornitor.kline_cache import fetch_klines_cached

                rows, src = await fetch_klines_cached(
                    session,
                    symbol=sym,
                    interval=iv,
                    min_bars=fetch_limit,
                    base_url=base_url,
                )
                logger.info("K线数据源 %s %s %s n=%d", src or "unknown", sym, iv, len(rows or []))
            if rows:
                self._card_kline_cache[key] = (now, rows)
                if len(self._card_kline_cache) > 400:
                    items = sorted(self._card_kline_cache.items(), key=lambda x: x[1][0])
                    for k, _ in items[: len(items) // 2]:
                        self._card_kline_cache.pop(k, None)
            return rows or []

        async def _emit_candle(
            sym: str,
            iv: str,
            is_major: bool,
            pool_role: str,
            df: Any,
            closed_ts: int,
        ) -> list[dict[str, Any]]:
            if not is_candle_push_enabled():
                return []
            if is_disabled_pattern_interval(iv):
                return []
            allow_shoot = pool_role in ("all", "flow", "gain")
            allow_hammer = pool_role in ("all", "flow", "dip")
            try:
                preview = collect_candle_signal_markers(df)
            except Exception:  # noqa: BLE001
                return []
            kinds_on_bar = {
                str(m.get("kind") or "")
                for m in preview
                if int(m.get("time") or 0) == closed_ts
            }
            close_ms = closed_ts * 1000
            if "close_time" in df.columns and "open_time" in df.columns:
                try:
                    cidx = closed_bar_index(df, now_ms=int(time.time() * 1000))
                    if cidx >= 0:
                        close_ms = int(df.iloc[cidx]["close_time"])
                except (TypeError, ValueError, KeyError):
                    pass
            for m in preview:
                if int(m.get("time") or 0) != closed_ts:
                    continue
                blocked, reason = evaluate_marker_text(str(m.get("text") or ""))
                kind = str(m.get("kind") or "")
                side = "bull" if kind in _LONG_PATTERN_KINDS else "bear"
                try:
                    insert_signal(
                        {
                            "symbol": sym,
                            "exchange": "binance_um",
                            "tf": iv,
                            "bar_open_ts": closed_ts * 1000,
                            "bar_close_ts": close_ms,
                            "side": side,
                            "family": "pattern",
                            "kind": kind,
                            "price_close": float(m.get("price") or 0),
                            "reject_reason": reason if blocked else None,
                            "tags": {
                                "near_vegas": str(m.get("text") or "").startswith("V"),
                                "oi_anomaly": bool(m.get("oi_anomaly")),
                                "pool_role": pool_role,
                            },
                            "params_version": PARAMS_VERSION,
                        }
                    )
                except Exception:  # noqa: BLE001
                    logger.debug("signal_log 写入失败 %s %s %s", sym, iv, kind)
            need_shoot = allow_shoot and "shooting_star" in kinds_on_bar
            need_hammer = allow_hammer and bool(kinds_on_bar & {"hammer", "inverted_hammer"})
            need_inv = allow_hammer and "inv_hammer" in kinds_on_bar
            if not need_shoot and not need_hammer and not need_inv:
                return []

            try:
                hits = find_last_closed_candle_card_hits(
                    df,
                    now_ms=now_ms,
                    allow_shooting_star=need_shoot,
                    allow_consecutive_shoot=False,
                    allow_hammer=need_hammer,
                    allow_inv_hammer=need_inv,
                )
            except Exception:  # noqa: BLE001
                return []

            out: list[dict[str, Any]] = []
            for hit in hits:
                close_ts = int(hit["time"])
                kind = str(hit.get("kind") or "")
                dedupe = f"{sym}:{iv}:{kind}:{close_ts}"
                if dedupe in self._card_seen:
                    continue
                side = "bull" if kind in ("hammer", "inv_hammer", "inverted_hammer") else "bear"
                if self._card_emit_throttled(sym, iv, side, close_ts):
                    continue
                type_label = str(hit.get("type_label") or kind)
                alert = {
                    "symbol": sym,
                    "type": "candle_pattern_card",
                    "interval": iv,
                    "status": "CANDLE_CARD",
                    "status_label": f"形态卡片 · {type_label}",
                    "signal_kind": str(hit.get("signal_kind") or kind),
                    "kind": kind,
                    "side": side,
                    "type_label": type_label,
                    "signal_text": str(hit.get("text") or type_label),
                    "oi_anomaly": bool(hit.get("oi_anomaly")),
                    "bb_mid": hit.get("bb_mid"),
                    "prior_high": hit.get("prior_high"),
                    "prior_low": hit.get("prior_low"),
                    "near_vegas": bool(hit.get("near_vegas")),
                    "trend_pct": hit.get("trend_pct"),
                    "price": float(hit.get("close") or hit.get("price") or 0),
                    "close": float(hit.get("close") or 0),
                    "high": float(hit.get("high") or 0),
                    "low": float(hit.get("low") or 0),
                    "open": float(hit.get("open") or 0),
                    "kline_open_time": close_ts,
                    "time": close_ts,
                    "message": f"{type_label} · {iv}",
                    "scan_ts": scan_ts,
                    "kline_close_time": close_ts * 1000,
                }
                out.append(alert)
                logger.info("📩 形态卡片 %s %s %s @%s", sym, type_label, iv, close_ts)
                try:
                    ok = await send_candle_card_telegram_async(alert)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Telegram 形态卡片失败 %s: %s", sym, exc)
                    ok = False
                if ok:
                    remember_card_seen(self._card_seen, dedupe)
                    self._card_last_emit[f"{sym}:{iv}:{side}"] = close_ts
            return out

        async def _emit_structure(
            sym: str, iv: str, df: Any
        ) -> list[dict[str, Any]]:
            if not is_structure_push_enabled():
                return []
            if iv not in STRUCTURE_CARD_INTERVALS:
                return []
            work = df
            async with sem:
                oi_map = await fetch_open_interest_hist(
                    session,
                    base_url=base_url,
                    symbol=sym,
                    interval=iv,
                    limit=min(fetch_limit, 500),
                )
            if oi_map:
                work = df.copy()
                work["oi"] = [
                    oi_map.get(int(ot // 1000), float("nan"))
                    for ot in work["open_time"].tolist()
                ]
            try:
                hits = find_last_closed_structure_hits(work, now_ms=now_ms)
            except Exception:  # noqa: BLE001
                return []
            hits = filter_structure_card_hits(hits, interval=iv, now_ms=now_ms)
            hits = [h for h in hits if str(h.get("kind") or "") != "spring_2b"]

            out: list[dict[str, Any]] = []
            for hit in hits:
                close_ts = int(hit["time"])
                kind = str(hit.get("kind") or "")
                dedupe = f"{sym}:{iv}:struct:{kind}:{close_ts}"
                if dedupe in self._card_seen:
                    continue
                side = str(hit.get("side") or "")
                if side in ("bull", "bear") and self._structure_emit_throttled(sym, iv, side, close_ts):
                    continue
                type_label = str(hit.get("type_label") or kind)
                alert = {
                    "symbol": sym,
                    "type": "structure_pattern_card",
                    "interval": iv,
                    "status": "STRUCTURE_CARD",
                    "status_label": f"结构卡片 · {type_label}",
                    "signal_kind": kind,
                    "kind": kind,
                    "side": side,
                    "type_label": type_label,
                    "pattern_label": str(hit.get("pattern_label") or type_label),
                    "signal_text": str(hit.get("pattern_label") or type_label),
                    "price": float(hit.get("close") or hit.get("price") or 0),
                    "close": float(hit.get("close") or 0),
                    "high": float(hit.get("high") or 0),
                    "low": float(hit.get("low") or 0),
                    "open": float(hit.get("open") or 0),
                    "head_high": hit.get("head_high"),
                    "left_shoulder": hit.get("left_shoulder"),
                    "right_shoulder": hit.get("right_shoulder"),
                    "neckline": hit.get("neckline"),
                    "vegas_mid": hit.get("vegas_mid"),
                    "vol_ratio": hit.get("vol_ratio"),
                    "defense": hit.get("defense"),
                    "support_ref": hit.get("support_ref"),
                    "resistance_ref": hit.get("resistance_ref"),
                    "l1": hit.get("l1"),
                    "l2": hit.get("l2"),
                    "climax_vol_ratio": hit.get("climax_vol_ratio"),
                    "close_pct": hit.get("close_pct"),
                    "kline_open_time": close_ts,
                    "time": close_ts,
                    "message": f"{type_label} · {iv}",
                    "scan_ts": scan_ts,
                    "kline_close_time": close_ts * 1000,
                }
                out.append(alert)
                logger.info("📩 结构卡片 %s %s %s @%s", sym, type_label, iv, close_ts)
                try:
                    ok = await send_structure_card_telegram_async(alert)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Telegram 结构卡片失败 %s: %s", sym, exc)
                    ok = False
                if ok:
                    remember_card_seen(self._card_seen, dedupe)
                    if side in ("bull", "bear"):
                        self._card_last_emit[f"struct:{sym}:{iv}:{side}"] = close_ts
            return out

        async def _one(
            sym: str, iv: str, is_major: bool, pool_role: str = "all"
        ) -> list[dict[str, Any]]:
            if is_disabled_pattern_interval(iv):
                return []
            klines = await _klines_for(sym, iv)
            min_bars = 80 if is_structure_push_enabled() else 30
            if not klines or len(klines) < min_bars:
                return []
            try:
                df = enrich_indicators(klines_to_df(klines))
            except Exception:  # noqa: BLE001
                return []
            if df.empty or "bb_basis" not in df.columns:
                return []

            closed_ts = None
            try:
                cidx = closed_bar_index(df, now_ms=now_ms)
                if cidx >= 0:
                    closed_ts = int(df.iloc[cidx]["open_time"] // 1000)
            except Exception:  # noqa: BLE001
                closed_ts = None
            if closed_ts is None:
                return []

            out: list[dict[str, Any]] = []
            if is_candle_push_enabled():
                out.extend(
                    await _emit_candle(sym, iv, is_major, pool_role, df, closed_ts)
                )
            if is_structure_push_enabled():
                out.extend(await _emit_structure(sym, iv, df))
            try:
                from oi_mornitor.strategy.scan_all import collect_all_events, events_on_bar
                from oi_mornitor.strategy.scoring import score_side

                cidx = closed_bar_index(df, now_ms=now_ms)
                if cidx >= 0:
                    evs = events_on_bar(collect_all_events(df.iloc[: cidx + 1]), cidx)
                    row = df.iloc[cidx]
                    board = {"gain": "gainer", "dip": "loser"}.get(pool_role, "none")
                    scores = {
                        iv: {
                            "long": score_side(evs, side="long", tf=iv, row=row, board=board, asof_idx=cidx)["score"],
                            "short": score_side(evs, side="short", tf=iv, row=row, board=board, asof_idx=cidx)["score"],
                        }
                    }
                    # 单周期先落库；共振等其他周期分数齐了再算。这里只记本周期新模块。
                    close_ms = int(row["close_time"]) if "close_time" in df.columns else int(row["open_time"])
                    for ev in evs:
                        if ev.get("family") in ("pattern",) and ev.get("kind") in (
                            "shooting_star",
                            "hammer",
                            "inverted_hammer",
                            "inv_hammer",
                            "hs_vegas_break",
                            "m_top_vegas_break",
                            "bottom_secondary_test",
                            "liquidity_sweep",
                        ):
                            continue
                        insert_signal(
                            {
                                "symbol": sym,
                                "exchange": "binance_um",
                                "tf": iv,
                                "bar_open_ts": int(row.get("open_time") or 0),
                                "bar_close_ts": close_ms,
                                "side": ev.get("side"),
                                "family": ev.get("family"),
                                "kind": ev.get("kind"),
                                "strength": ev.get("strength"),
                                "price_close": ev.get("price_close"),
                                "features": ev.get("features"),
                                "tags": {**(ev.get("tags") or {}), "pool_role": pool_role},
                                "score_tf": scores[iv].get(ev.get("side") or "long"),
                                "params_version": PARAMS_VERSION,
                            }
                        )
            except Exception:
                logger.debug("新信号仅记日志失败 %s %s", sym, iv, exc_info=True)
            return out

        results = await asyncio.gather(
            *[_one(s, iv, maj, role) for s, iv, maj, role in jobs],
            return_exceptions=True,
        )
        alerts: list[dict[str, Any]] = []
        for item in results:
            if isinstance(item, Exception):
                logger.debug("形态/结构卡片单任务异常: %s", item)
                continue
            if item:
                alerts.extend(item)
        return alerts

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

    async def get_chart_candles(
        self,
        session: aiohttp.ClientSession,
        symbol: str,
        *,
        base_url: str = FAPI_BASE_URL,
        interval: str | None = None,
        limit: int | None = None,
        end_time: int | None = None,
    ) -> dict[str, Any]:
        """轻量接口：只拉 K 线 + 算 BB/MACD/Vegas，不做 OI 历史/资金费率/多周期。

        用于图表优先渲染——K 线到了立刻返回，侧边栏形态分析走 /chart 独立补。
        """
        sym = symbol.strip().upper()
        tf = interval or PATTERN_KLINE_INTERVAL
        req_limit = limit if limit is not None else PATTERN_CHART_DEFAULT_LIMIT
        if end_time is None:
            req_limit = max(req_limit, PATTERN_CHART_DEFAULT_LIMIT)
        req_limit = min(req_limit, PATTERN_CHART_MAX_LIMIT)

        klines, kline_src = await fetch_pattern_klines_with_source(
            session,
            base_url=base_url,
            symbol=sym,
            interval=tf,
            limit=req_limit,
            end_time=end_time,
        )
        page_has_more = klines_page_has_more(len(klines), req_limit, kline_src)
        partial = end_time is not None

        chart = build_pattern_chart_payload(klines, state={}, oi_by_time=None, derivatives_ctx=None)

        return {
            "symbol": sym,
            "interval": tf,
            "partial": partial,
            "has_more": page_has_more,
            "kline_source": kline_src,
            "candles": chart["candles"],
            "bb": chart["bb"],
            "vegas": chart.get("vegas") or {},
            "macd": chart.get("macd") or {"line": [], "signal": [], "hist": []},
            "markers": chart.get("markers") or [],
            "price_lines": chart.get("price_lines") or [],
            "analysis": {},
            "state": {},
        }

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

        klines, kline_src = await fetch_pattern_klines_with_source(
            session,
            base_url=base_url,
            symbol=sym,
            interval=tf,
            limit=req_limit,
            end_time=end_time,
        )
        page_has_more = klines_page_has_more(len(klines), req_limit, kline_src)

        partial = end_time is not None
        state_dict: dict[str, Any] = {}
        if not partial:
            state_dict = {
                "status": STATUS_SEARCHING,
                "status_label": STATUS_LABELS[STATUS_SEARCHING],
                "message": "",
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
                "has_more": page_has_more,
                "kline_source": kline_src,
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
            "has_more": page_has_more,
            "kline_source": kline_src,
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
        del row
        return {
            "symbol": symbol,
            "interval": interval,
            "status": STATUS_SEARCHING,
            "status_label": STATUS_LABELS[STATUS_SEARCHING],
            "message": "",
        }
