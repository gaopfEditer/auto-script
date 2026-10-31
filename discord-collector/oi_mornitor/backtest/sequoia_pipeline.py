"""Sequoia 持久化回测流水线：本地 parquet → 信号 → 5% 固定 SL 结算 → 胜率库形状 / job JSON。

与 structure_backtest / three_way 对齐：
- 入场：next_bar_open + OI_BT 滑点/手续费
- 结算：settle_signal_by_5m_bars + 显式 5% SL SettlePlan（币圈用户口径）
- 汇总：summarize_backtest_extended
- 落盘：data/sequoia_backtest/（latest_summary.json + 分策略 job）

双轨道：crypto（默认 5% SL / 20x）与 us_equity（5% SL / 10x，币所美股合约）。
不启用 Telegram 推送。RamDisk backtest_klines 为空时自动回退 ssd-bak。
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import pandas as pd

from oi_mornitor.backtest.strategies import CostDefenseTrailingManager, RiskConfig
from oi_mornitor.backtest_kline_store import BacktestKlineStore
from oi_mornitor.backtest_metrics import summarize_backtest_extended, summarize_by_dimensions
from oi_mornitor.backtest_trade_config import OI_BT_FEE_PCT, OI_BT_SLIPPAGE_PCT
from oi_mornitor.config import BACKTEST_KLINES_DIR
from oi_mornitor.env_parse import env_float, env_int
from oi_mornitor.mcap_tier import resolve_mcap_tier
from oi_mornitor.pattern_entry import resolve_backtest_entry_price
from oi_mornitor.pattern_settle import BATCH_WEIGHTS, RUNNER_TRAIL_PCT, settle_signal_by_5m_bars
from oi_mornitor.pattern_settle_profile import SettlePlan, resolve_verify_delay_ms
from oi_mornitor.strategy_sequoia.bridge import hit_to_alert, record_sequoia_alert
from oi_mornitor.strategy_sequoia.registry import ALL_STRATEGY_IDS, STRATEGY_META, resolve_strategy_ids
from oi_mornitor.strategy_sequoia.strategies import detect_all

logger = logging.getLogger(__name__)

_PKG = Path(__file__).resolve().parents[1]
_DATA = _PKG / "data"
_OUT_DIR = _DATA / "sequoia_backtest"

# 币圈 Sequoia 回测默认：5% 固定止损；报告用 20x 保证金示意
SEQUOIA_BT_SL_PCT = env_float("OI_SEQUOIA_BT_SL_PCT", 5.0, min_val=0.0)
SEQUOIA_BT_LEVERAGE = env_float("OI_SEQUOIA_BT_LEVERAGE", 20.0, min_val=1.0)
SEQUOIA_BT_MARGIN_CNY = env_float("OI_SEQUOIA_BT_MARGIN_CNY", 100.0, min_val=0.0)
SEQUOIA_BT_HOLD_BARS = env_int("OI_SEQUOIA_BT_HOLD_BARS", 5, min_val=1)
SEQUOIA_BT_WARMUP = env_int("OI_SEQUOIA_BT_WARMUP", 80, min_val=10)

# 美股合约轨道（与币圈配置分离）
SEQUOIA_BT_US_SL_PCT = env_float("OI_SEQUOIA_BT_US_SL_PCT", 5.0, min_val=0.0)
SEQUOIA_BT_US_LEVERAGE = env_float("OI_SEQUOIA_BT_US_LEVERAGE", 10.0, min_val=1.0)
SEQUOIA_BT_US_MARGIN_CNY = env_float("OI_SEQUOIA_BT_US_MARGIN_CNY", 100.0, min_val=0.0)
SEQUOIA_BT_US_HOLD_BARS = env_int("OI_SEQUOIA_BT_US_HOLD_BARS", 5, min_val=1)


def resolve_klines_root(explicit: Path | str | None = None) -> Path:
    """优先显式路径；否则 BACKTEST_KLINES_DIR；再回退 ssd-bak（RamDisk 空时）。"""
    if explicit:
        root = Path(explicit)
        if (root / "parquet").is_dir():
            return root
        if root.is_dir() and any(root.glob("*/1h.parquet")):
            return root.parent if root.name == "parquet" else root
        return root
    primary = Path(BACKTEST_KLINES_DIR)
    if (primary / "parquet").is_dir() and any((primary / "parquet").glob("*/*.parquet")):
        return primary
    bak = _DATA / "backtest_klines.ssd-bak"
    if (bak / "parquet").is_dir():
        logger.info("BACKTEST_KLINES_DIR 无 parquet，回退 %s", bak)
        return bak
    return primary


def normalize_track(track: str | None) -> str:
    t = (track or "crypto").strip().lower()
    if t in ("us", "us_equity", "equity", "stock", "stocks"):
        return "us_equity"
    if t in ("crypto", "coin", "cex"):
        return "crypto"
    return "crypto"


def track_defaults(track: str | None) -> dict[str, float | int | str]:
    """返回该轨道的 sl/leverage/margin/hold/asset_class。"""
    tr = normalize_track(track)
    if tr == "us_equity":
        return {
            "track": tr,
            "asset_class": "equity",
            "sl_pct": float(SEQUOIA_BT_US_SL_PCT),
            "leverage": float(SEQUOIA_BT_US_LEVERAGE),
            "margin_cny": float(SEQUOIA_BT_US_MARGIN_CNY),
            "hold_bars": int(SEQUOIA_BT_US_HOLD_BARS),
        }
    return {
        "track": "crypto",
        "asset_class": "crypto",
        "sl_pct": float(SEQUOIA_BT_SL_PCT),
        "leverage": float(SEQUOIA_BT_LEVERAGE),
        "margin_cny": float(SEQUOIA_BT_MARGIN_CNY),
        "hold_bars": int(SEQUOIA_BT_HOLD_BARS),
    }


def default_major_symbols(
    root: Path | None = None,
    *,
    track: str = "crypto",
    interval: str = "1h",
    universe: str = "majors",
) -> list[str]:
    from oi_mornitor.strategy_sequoia.universe import (
        default_crypto_leader_symbols,
        default_symbols_for_track,
    )

    r = resolve_klines_root(root)
    tr = normalize_track(track)
    if tr == "crypto" and str(universe or "").lower() in ("leaders", "leader", "btc_eth", "btceth"):
        return default_crypto_leader_symbols(r, interval=interval)
    return default_symbols_for_track(tr, r, interval=interval)


def _load_signal_df(store: BacktestKlineStore, symbol: str, interval: str) -> pd.DataFrame:
    path = store.parquet_root / symbol.upper() / f"{interval}.parquet"
    if not path.is_file():
        return pd.DataFrame()
    return pd.read_parquet(path)


def _fixed_5pct_plan(
    *,
    entry: float,
    side: str,
    sl_pct: float,
    verify_delay_ms: int,
) -> SettlePlan:
    """胜率结算用的固定止损计划（默认 5%）。"""
    is_short = str(side).lower() in ("short", "bear")
    step = max(float(sl_pct), 0.01) / 100.0
    if is_short:
        sl = entry * (1.0 + step)
        risk = sl - entry
        tp1 = entry - risk * 1.0
        tp2 = entry - risk * 2.0
    else:
        sl = entry * (1.0 - step)
        risk = entry - sl
        tp1 = entry + risk * 1.0
        tp2 = entry + risk * 2.0
    return SettlePlan(
        profile_id=f"sequoia_fixed_sl{sl_pct:g}",
        sl_price=sl,
        tp1_price=tp1,
        tp2_price=tp2,
        batch_weights=BATCH_WEIGHTS,
        runner_trail_pct=RUNNER_TRAIL_PCT,
        verify_delay_ms=verify_delay_ms,
        risk_r=risk,
        tp1_r=1.0,
        tp2_r=2.0,
    )


def _align_signal_at_ms(close_ms: int) -> int:
    return int(close_ms)


def _price_pnl_pct(it: dict[str, Any]) -> float | None:
    """优先价格涨跌%（netMovePct/movePct/priceMovePct）；兼容固定止损矩阵的 pnl_pct。"""
    for k in ("priceMovePct", "netMovePct", "movePct", "pnl_pct"):
        if it.get(k) is None:
            continue
        try:
            return float(it[k])
        except (TypeError, ValueError):
            continue
    # 勿直接用胜率库 pnlPct：其中已乘 100x/20x
    return None


def leverage_report(
    items: Sequence[dict[str, Any]],
    *,
    leverage: float = SEQUOIA_BT_LEVERAGE,
    margin_cny: float = SEQUOIA_BT_MARGIN_CNY,
) -> dict[str, Any]:
    """价格涨跌 % → 统一按 leverage（默认20x）保证金示意；标注 DD×杠杆爆仓风险。"""
    settled = [
        it
        for it in items
        if str(it.get("outcome") or "")
        in ("take_profit", "stop_loss", "timeout", "window_end", "runner_stop")
        or _price_pnl_pct(it) is not None
    ]
    pnls: list[float] = []
    for it in settled:
        px = _price_pnl_pct(it)
        if px is None:
            continue
        pnls.append(px)
    if not pnls:
        return {
            "leverage": leverage,
            "margin_cny": margin_cny,
            "trades": 0,
            "avg_price_pct": 0.0,
            "avg_margin_pnl_cny": 0.0,
            "sum_margin_pnl_naive_cny": 0.0,
            "max_dd_price_pct": 0.0,
            "dd_x_leverage_pct": 0.0,
            "blowup_risk": False,
            "note": "无已结算交易",
        }
    wins = sum(1 for p in pnls if p > 0)
    avg = sum(pnls) / len(pnls)
    total = sum(pnls)
    equity = 100.0
    peak = equity
    max_dd = 0.0
    for p in pnls:
        equity *= 1.0 + p / 100.0
        peak = max(peak, equity)
        dd = (peak - equity) / peak * 100.0 if peak > 0 else 0.0
        max_dd = max(max_dd, dd)
    dd_lev = max_dd * leverage
    return {
        "leverage": leverage,
        "margin_cny": margin_cny,
        "trades": len(pnls),
        "win_rate": round(wins / len(pnls) * 100.0, 2),
        "avg_price_pct": round(avg, 4),
        "sum_price_pct": round(total, 3),
        "avg_margin_pnl_cny": round(avg / 100.0 * leverage * margin_cny, 2),
        "sum_margin_pnl_naive_cny": round(total / 100.0 * leverage * margin_cny, 2),
        "max_dd_price_pct": round(max_dd, 3),
        "dd_x_leverage_pct": round(dd_lev, 1),
        "blowup_risk": dd_lev >= 100.0,
        "note": (
            "保证金盈亏=价格涨跌%×杠杆×保证金（未计强平/资金费）；"
            "sum 为简单加总非复利；DD×杠杆≥100% 示意保证金易打穿。"
        ),
    }


@dataclass
class SequoiaPipelineResult:
    interval: str
    sl_pct: float
    symbols: list[str]
    track: str = "crypto"
    asset_class: str = "crypto"
    items: list[dict[str, Any]] = field(default_factory=list)
    by_strategy: dict[str, Any] = field(default_factory=dict)
    summary: dict[str, Any] = field(default_factory=dict)
    leverage: dict[str, Any] = field(default_factory=dict)
    out_dir: str = ""
    klines_root: str = ""
    elapsed_sec: float = 0.0
    fixed_stop_matrix: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "track": self.track,
            "asset_class": self.asset_class,
            "interval": self.interval,
            "sl_pct": self.sl_pct,
            "symbols": self.symbols,
            "item_count": len(self.items),
            "by_strategy": self.by_strategy,
            "summary": self.summary,
            "leverage": self.leverage,
            "fixed_stop_matrix": self.fixed_stop_matrix,
            "out_dir": self.out_dir,
            "klines_root": self.klines_root,
            "elapsed_sec": self.elapsed_sec,
            "items": self.items,
        }


def _run_fixed_stop_quick(
    dfs: dict[str, pd.DataFrame],
    *,
    interval: str,
    strategy_ids: tuple[str, ...],
    sl_pct: float,
    hold_bars: int,
    warmup: int,
    leverage: float = SEQUOIA_BT_LEVERAGE,
    margin_cny: float = SEQUOIA_BT_MARGIN_CNY,
    filter_profile: Any = None,
    htf_dfs: dict[str, pd.DataFrame] | None = None,
) -> list[dict[str, Any]]:
    """快速档：固定止损 + 超时（不做 BE/trail），按策略分仓统计。"""
    rows: list[dict[str, Any]] = []
    for sid in strategy_ids:
        all_trades: list[dict[str, Any]] = []
        for sym, df in dfs.items():
            if df is None or df.empty:
                continue
            risk = RiskConfig(
                initial_stop_pct=float(sl_pct),
                max_bars=max(1, int(hold_bars)),
                fixed_stop_only=True,
                breakeven_trigger_pct=999.0,
                trail_start_pct=999.0,
                fee_pct=OI_BT_FEE_PCT,
                slippage_pct=OI_BT_SLIPPAGE_PCT,
            )
            from oi_mornitor.strategy_sequoia.backtest import run_sequoia_backtest

            res = run_sequoia_backtest(
                df,
                symbol=sym,
                interval=interval,
                strategy_ids=(sid,),
                risk=risk,
                warmup=warmup,
                collect_alerts=False,
                filter_profile=filter_profile,
                htf_df=(htf_dfs or {}).get(sym),
            )
            for t in res.trades:
                all_trades.append({**t, "symbol": sym, "priceMovePct": t["pnl_pct"], "pnl_pct": t["pnl_pct"]})
        lev = leverage_report(all_trades, leverage=leverage, margin_cny=margin_cny)
        meta = STRATEGY_META.get(sid) or {}
        rows.append(
            {
                "strategy_id": sid,
                "strategy_cn": meta.get("type_label", sid),
                "stop": f"{sl_pct:g}%",
                "trades": lev.get("trades", 0),
                "winrate": lev.get("win_rate", 0),
                "avg_trade_pct": lev.get("avg_price_pct", 0),
                "sum_pnl_pct": lev.get("sum_price_pct", 0),
                "max_dd_pct": lev.get("max_dd_price_pct", 0),
                "avg_margin_pnl_cny": lev.get("avg_margin_pnl_cny", 0),
                "dd_x_leverage_pct": lev.get("dd_x_leverage_pct", 0),
                "blowup_risk_20x": lev.get("blowup_risk", False),  # 历史字段名；实为 DD×报告杠杆
                "blowup_risk": lev.get("blowup_risk", False),
                "leverage": leverage,
            }
        )
    return rows


def run_sequoia_pipeline(
    *,
    symbols: Sequence[str] | None = None,
    interval: str = "1h",
    strategy_ids: Sequence[str] | None = None,
    track: str = "crypto",
    sl_pct: float | None = None,
    hold_bars: int | None = None,
    warmup: int = SEQUOIA_BT_WARMUP,
    klines_root: Path | str | None = None,
    out_dir: Path | str | None = None,
    record_stats: bool = False,
    limit_bars: int = 0,
    include_fixed_matrix: bool = True,
    leverage: float | None = None,
    margin_cny: float | None = None,
    profile: str | None = None,
    filter_profile: Any = None,
) -> SequoiaPipelineResult:
    """
    全流水线：detect_all → next_bar 入场 → 5m 结算（固定 sl_pct）→ 汇总落盘。

    track=crypto|us_equity：默认止损/杠杆分离（币 5%/20x，美股合约 5%/10x）。
    profile=filtered|leaders_htf：币圈龙头+4h确认+冷却+缩量过滤，报告杠杆默认 5x。
    record_stats=True 时写入 pattern_alert_stats（仍不推 TG）。
    """
    from oi_mornitor.strategy_sequoia.filters import (
        apply_signal_filters,
        build_htf_trend_ok,
        profile_params_dict,
        resolve_filter_profile,
    )

    t0 = time.time()
    td = track_defaults(track)
    tr = str(td["track"])
    asset_class = str(td["asset_class"])
    fp = filter_profile or resolve_filter_profile(profile)
    # filtered 仅对 crypto 有意义；us_equity 忽略档案杠杆/宇宙
    use_filter = tr == "crypto" and getattr(fp, "name", "baseline") == "filtered"
    if not use_filter:
        fp = resolve_filter_profile("baseline")
    if sl_pct is None:
        sl_pct = float(fp.sl_pct) if use_filter else float(td["sl_pct"])
    if hold_bars is None:
        hold_bars = int(fp.hold_bars) if use_filter else int(td["hold_bars"])
    if leverage is None:
        leverage = float(fp.leverage) if use_filter else float(td["leverage"])
    if margin_cny is None:
        margin_cny = float(td["margin_cny"])
    root = resolve_klines_root(klines_root)
    store = BacktestKlineStore(root=root)
    ids = resolve_strategy_ids(tuple(strategy_ids) if strategy_ids else None)
    univ = fp.universe if use_filter else "majors"
    syms = [
        s.strip().upper()
        for s in (
            symbols
            or default_major_symbols(root, track=tr, interval=interval, universe=univ)
        )
        if s.strip()
    ]
    out_key = fp.out_subdir if use_filter else tr
    out = Path(out_dir) if out_dir else (_OUT_DIR / out_key)
    out.mkdir(parents=True, exist_ok=True)

    dfs: dict[str, pd.DataFrame] = {}
    htf_dfs: dict[str, pd.DataFrame] = {}
    htf_trends: dict[str, pd.DataFrame] = {}
    htf_iv = str(getattr(fp, "htf_interval", "4h") or "4h")
    for sym in syms:
        df = _load_signal_df(store, sym, interval)
        if df.empty:
            logger.warning("缺 K 线 %s %s", sym, interval)
            continue
        if limit_bars and len(df) > limit_bars:
            df = df.iloc[-limit_bars:].reset_index(drop=True)
        dfs[sym] = df
        if use_filter and fp.htf_confirm:
            hdf = _load_signal_df(store, sym, htf_iv)
            if not hdf.empty:
                htf_dfs[sym] = hdf
                htf_trends[sym] = build_htf_trend_ok(hdf, ma=int(fp.htf_ma))
            else:
                logger.warning("缺 HTF K 线 %s %s（过滤后该币信号将全部丢弃）", sym, htf_iv)

    items: list[dict[str, Any]] = []
    for sym, df in dfs.items():
        n = len(df)
        hits = detect_all(df, strategy_ids=ids)
        if use_filter:
            hits = apply_signal_filters(
                hits,
                df,
                profile=fp,
                htf_trend=htf_trends.get(sym),
                symbol=sym,
            )
        # 同 bar 多策略：各自独立记信号（胜率口径按 typeLabel 拆）
        for h in hits:
            bi = int(h.get("bar_index") or -1)
            if bi < warmup or bi >= n - 1:
                continue
            sid = str(h.get("strategy_id") or "")
            side = "long" if str(h.get("side")) in ("long", "bull") else "short"
            type_label = str(h.get("type_label") or STRATEGY_META.get(sid, {}).get("type_label") or sid)
            row = df.iloc[bi]
            signal_close = float(row["close"])
            next_open = float(df.iloc[bi + 1]["open"])
            entry = resolve_backtest_entry_price(
                side=side,
                signal_bar_close=signal_close,
                next_bar_open=next_open,
            )
            close_ms = int(h.get("close_time") or row.get("close_time") or 0)
            if close_ms and close_ms < 1e12:
                close_ms *= 1000
            if not close_ms:
                open_ms = int(row["open_time"])
                # 粗估：用下一根 open_time 作为收盘
                close_ms = int(df.iloc[bi + 1]["open_time"]) if bi + 1 < n else open_ms
            signal_at_ms = _align_signal_at_ms(close_ms)
            settle_stub: dict[str, Any] = {
                "symbol": sym,
                "tradeSymbol": sym,
                "side": side,
                "entry": entry,
                "signalAt": signal_at_ms,
                "interval": interval,
                "typeLabel": type_label,
                "type_label": type_label,
                "kind": sid,
                "mcapTier": resolve_mcap_tier(sym),
                "source": "sequoia_pipeline",
                "assetClass": asset_class,
                "sequoiaTrack": tr,
            }
            verify_ms = resolve_verify_delay_ms(settle_stub)
            settle_end = signal_at_ms + verify_ms + 5 * 60_000
            bars_5m = store.load_5m_bars(sym, signal_at_ms, settle_end)
            plan = _fixed_5pct_plan(
                entry=entry,
                side=side,
                sl_pct=sl_pct,
                verify_delay_ms=verify_ms,
            )
            settled = settle_signal_by_5m_bars(
                side=side,
                entry=entry,
                symbol=sym,
                signal_at_ms=signal_at_ms,
                bars_5m=bars_5m,
                now_ms=settle_end,
                plan=plan,
                fee_pct_per_side=OI_BT_FEE_PCT,
                slippage_pct_per_side=OI_BT_SLIPPAGE_PCT,
            )
            move = settled.get("netMovePct")
            if move is None:
                move = settled.get("movePct")
            try:
                price_move = float(move) if move is not None else None
            except (TypeError, ValueError):
                price_move = None
            pnl20 = (
                round(price_move * float(leverage), 4) if price_move is not None else None
            )
            item: dict[str, Any] = {
                "symbol": sym,
                "interval": interval,
                "kind": sid,
                "typeLabel": type_label,
                "side": side,
                "emit": "sequoia",
                "signalAt": signal_at_ms,
                "entry": entry,
                "mcapTier": settle_stub.get("mcapTier"),
                "outcome": settled.get("outcome"),
                "movePct": settled.get("movePct"),
                "netMovePct": settled.get("netMovePct"),
                "priceMovePct": price_move,
                # 胜率库原生口径（BTC/ETH/SOL=100x，山寨=20x）
                "pnlPctLive": settled.get("pnlPct"),
                # 用户币圈示意：统一 leverage（默认 20x）
                "pnlPct": pnl20 if pnl20 is not None else settled.get("pnlPct"),
                "pnlPct20x": pnl20,
                "exitPrice": settled.get("exitPrice"),
                "slPrice": settled.get("slPrice") or plan.sl_price,
                "tp1Price": settled.get("tp1Price") or plan.tp1_price,
                "error": settled.get("error"),
                "slPct": sl_pct,
                "profileId": plan.profile_id,
                "reportLeverage": leverage,
                "assetClass": asset_class,
                "sequoiaTrack": tr,
            }
            items.append(item)
            if record_stats:
                alert = hit_to_alert(
                    h,
                    symbol=sym,
                    interval=interval,
                    source="sequoia_pipeline",
                )
                record_sequoia_alert(alert)

    items.sort(key=lambda x: int(x.get("signalAt") or 0))
    summary = summarize_backtest_extended(items) if items else {}
    by_dim = summarize_by_dimensions(items, key_fields=("typeLabel", "interval", "mcapTier")) if items else []
    by_strategy: dict[str, Any] = {}
    for sid in ids:
        bucket = [it for it in items if it.get("kind") == sid]
        by_strategy[sid] = {
            "type_label": (STRATEGY_META.get(sid) or {}).get("type_label", sid),
            "count": len(bucket),
            "summary": summarize_backtest_extended(bucket) if bucket else {},
            "leverage": leverage_report(bucket, leverage=leverage, margin_cny=margin_cny),
        }

    lev = leverage_report(items, leverage=leverage, margin_cny=margin_cny)
    fixed_matrix: list[dict[str, Any]] = []
    if include_fixed_matrix and dfs:
        fixed_matrix = _run_fixed_stop_quick(
            dfs,
            interval=interval,
            strategy_ids=ids,
            sl_pct=sl_pct,
            hold_bars=hold_bars,
            warmup=warmup,
            leverage=leverage,
            margin_cny=margin_cny,
            filter_profile=fp if use_filter else None,
            htf_dfs=htf_dfs if use_filter else None,
        )

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    result = SequoiaPipelineResult(
        interval=interval,
        sl_pct=sl_pct,
        track=tr,
        asset_class=asset_class,
        symbols=list(dfs.keys()),
        items=items,
        by_strategy=by_strategy,
        summary={**summary, "by_dimension": by_dim},
        leverage=lev,
        out_dir=str(out),
        klines_root=str(root),
        elapsed_sec=round(time.time() - t0, 2),
        fixed_stop_matrix=fixed_matrix,
    )
    payload = result.to_dict()
    payload["params"] = {
        "track": tr,
        "asset_class": asset_class,
        "sl_pct": sl_pct,
        "hold_bars": hold_bars,
        "warmup": warmup,
        "interval": interval,
        "fee_pct": OI_BT_FEE_PCT,
        "slippage_pct": OI_BT_SLIPPAGE_PCT,
        "leverage": leverage,
        "margin_cny": margin_cny,
        "strategy_ids": list(ids),
        "telegram": False,
        "filter": profile_params_dict(fp),
        "universe_label": fp.universe_label if use_filter else ("majors" if tr == "crypto" else "us_equity"),
    }
    payload["universe_label"] = payload["params"]["universe_label"]
    job_tag = f"{tr}_{fp.name}" if use_filter else tr
    job_path = out / f"sequoia_{job_tag}_{interval}_sl{sl_pct:g}_{stamp}.json"
    latest = out / "latest_summary.json"
    # 落盘时 items 可能很大，summary 文件保留全量以便对接 compare/胜率
    job_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    latest.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(
        "Sequoia pipeline done items=%d out=%s elapsed=%.1fs blowup=%s",
        len(items),
        job_path,
        result.elapsed_sec,
        lev.get("blowup_risk"),
    )
    return result


__all__ = [
    "SEQUOIA_BT_HOLD_BARS",
    "SEQUOIA_BT_LEVERAGE",
    "SEQUOIA_BT_MARGIN_CNY",
    "SEQUOIA_BT_SL_PCT",
    "SEQUOIA_BT_US_HOLD_BARS",
    "SEQUOIA_BT_US_LEVERAGE",
    "SEQUOIA_BT_US_MARGIN_CNY",
    "SEQUOIA_BT_US_SL_PCT",
    "SequoiaPipelineResult",
    "default_major_symbols",
    "leverage_report",
    "normalize_track",
    "resolve_klines_root",
    "run_sequoia_pipeline",
    "track_defaults",
]
