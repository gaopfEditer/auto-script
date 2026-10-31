"""短线 DCA 回测流水线（TD9 / Vegas·形态 / NLV）。

Modes
-----
- A ``nlv_flip``：NLV 买开多/卖开空（翻转）；腿内插针极值 SL + 可选 exit_plan（复用 NLV）
- B ``td9_long``：TD -9 开多，TD +9 平多（对齐 Pine enable_strategy）；默认无插针 SL
- C ``confluence``：只统计模块标签/分数，不产生成交

口径：仅已收盘 K 出信号；下一根开盘入场/出场。落盘 data/dca_backtest/。
源脚本：docs/strategies/aicoin-dca-td9-vegas-nlv.pine
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

import pandas as pd

from oi_mornitor.backtest.nlv_pipeline import (
    NLV_BT_LEVERAGE,
    NLV_BT_MARGIN_CNY,
    NLV_DEFAULT_EXIT_PLAN,
    NLV_EXIT_PLANS,
    NLV_MAX_RISK_PCT,
    NLV_MIN_RISK_PCT,
    NLV_SL_MODE,
    _pin_extreme_plan,
    default_symbols_for_universe,
    resolve_exit_plan,
    summarize_nlv_report,
)
from oi_mornitor.backtest.regime_tips import tip_for, tips_payload
from oi_mornitor.backtest.sequoia_pipeline import (
    _align_signal_at_ms,
    leverage_report,
    resolve_klines_root,
)
from oi_mornitor.backtest_kline_store import BacktestKlineStore
from oi_mornitor.backtest_trade_config import OI_BT_FEE_PCT, OI_BT_SLIPPAGE_PCT
from oi_mornitor.env_parse import env_float, env_int
from oi_mornitor.mcap_tier import (
    MCAP_TIER_ORDER,
    mcap_tier_label,
    resolve_mcap_tier,
    tier_catalog_for_api,
)
from oi_mornitor.pattern_entry import resolve_backtest_entry_price
from oi_mornitor.pattern_settle import settle_signal_by_5m_bars
from oi_mornitor.pattern_settle_profile import resolve_verify_delay_ms
from oi_mornitor.strategy.dca_short_signals import (
    compute_dca_signal_frame,
    min_warmup_bars,
)

logger = logging.getLogger(__name__)

_PKG = Path(__file__).resolve().parents[1]
_DATA = _PKG / "data"
_OUT_DIR = _DATA / "dca_backtest"
_PINE_DOC = _PKG / "docs" / "strategies" / "aicoin-dca-td9-vegas-nlv.pine"

DCA_BT_LEVERAGE = env_float("OI_DCA_BT_LEVERAGE", NLV_BT_LEVERAGE, min_val=1.0)
DCA_BT_MARGIN_CNY = env_float("OI_DCA_BT_MARGIN_CNY", NLV_BT_MARGIN_CNY, min_val=0.0)
DCA_INTERVALS = ("15m", "1h", "4h")
DEFAULT_INTERVAL = "1h"
DEFAULT_MODE = "nlv_flip"

DCA_MODES: dict[str, dict[str, Any]] = {
    "nlv_flip": {
        "id": "nlv_flip",
        "label": "A · NLV 翻转 DCA",
        "tipKey": "dca_nlv_flip",
        "tradeable": True,
        "desc": "nlv_buy 开多 / nlv_sell 开空（翻转）；腿内插针 SL + exit_plan",
    },
    "td9_long": {
        "id": "td9_long",
        "label": "B · TD9 只做多",
        "tipKey": "dca_td9_long",
        "tradeable": True,
        "desc": "TD-9 开多，TD+9 下一根开盘平；默认无硬 SL（对齐 Pine）",
    },
    "confluence": {
        "id": "confluence",
        "label": "C · 共振计分（无成交）",
        "tipKey": "dca_confluence",
        "tradeable": False,
        "desc": "统计 TD9/Vegas 形态/NLV 标签与分数，不模拟下单",
    },
}

_jobs: dict[str, "DcaBacktestJob"] = {}
_jobs_lock = asyncio.Lock()
_MAX_JOBS = 8
_MAX_LIST = 40


def resolve_mode(raw: str | None) -> str:
    key = str(raw or DEFAULT_MODE).strip().lower()
    aliases = {
        "a": "nlv_flip",
        "mode_a": "nlv_flip",
        "mode-a": "nlv_flip",
        "nlv": "nlv_flip",
        "flip": "nlv_flip",
        "b": "td9_long",
        "mode_b": "td9_long",
        "mode-b": "td9_long",
        "td9": "td9_long",
        "td": "td9_long",
        "c": "confluence",
        "mode_c": "confluence",
        "mode-c": "confluence",
        "score": "confluence",
        "alerts": "confluence",
    }
    key = aliases.get(key, key)
    if key not in DCA_MODES:
        return DEFAULT_MODE
    return key


def _ensure_out(out: Path | None = None) -> Path:
    root = Path(out) if out else _OUT_DIR
    root.mkdir(parents=True, exist_ok=True)
    return root


def _load_signal_df(store: BacktestKlineStore, symbol: str, interval: str) -> pd.DataFrame:
    path = store.parquet_root / symbol.upper() / f"{interval}.parquet"
    if not path.is_file():
        return pd.DataFrame()
    return pd.read_parquet(path)


def _signal_close_ms(df: pd.DataFrame, bi: int) -> int:
    row = df.iloc[bi]
    close_ms = int(row.get("close_time") or 0)
    if close_ms and close_ms < 1e12:
        close_ms *= 1000
    if close_ms:
        return close_ms
    if bi + 1 < len(df):
        return int(df.iloc[bi + 1]["open_time"])
    return int(row["open_time"])


def _apply_costs(raw_pct: float) -> float:
    # 往返手续费+滑点（与其它 OI 回测一致量级）
    roundtrip = 2.0 * (float(OI_BT_FEE_PCT) + float(OI_BT_SLIPPAGE_PCT))
    return float(raw_pct) - roundtrip


@dataclass
class DcaPipelineResult:
    interval: str
    mode: str
    symbols: list[str]
    universe: str = "majors"
    exit_plan: str = NLV_DEFAULT_EXIT_PLAN
    items: list[dict[str, Any]] = field(default_factory=list)
    by_kind: dict[str, Any] = field(default_factory=dict)
    by_mcap_tier: dict[str, Any] = field(default_factory=dict)
    summary: dict[str, Any] = field(default_factory=dict)
    leverage: dict[str, Any] = field(default_factory=dict)
    out_dir: str = ""
    klines_root: str = ""
    elapsed_sec: float = 0.0
    category: str = "dca"
    category_label: str = "短线DCA · TD9/维加斯/形态/NLV"
    confluence_stats: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "categoryLabel": self.category_label,
            "mode": self.mode,
            "modeLabel": DCA_MODES.get(self.mode, {}).get("label"),
            "universe": self.universe,
            "exit_plan": self.exit_plan,
            "interval": self.interval,
            "symbols": self.symbols,
            "item_count": len(self.items),
            "by_kind": self.by_kind,
            "by_mcap_tier": self.by_mcap_tier,
            "summary": self.summary,
            "leverage": self.leverage,
            "confluenceStats": self.confluence_stats,
            "out_dir": self.out_dir,
            "klines_root": self.klines_root,
            "elapsed_sec": self.elapsed_sec,
            "items": self.items,
            "pineSource": str(_PINE_DOC) if _PINE_DOC.is_file() else None,
        }


def _settle_nlv_leg(
    *,
    store: BacktestKlineStore,
    sym: str,
    iv: str,
    df: pd.DataFrame,
    bi: int,
    side: str,
    kind: str,
    type_label: str,
    plan_id: str,
    plan_meta: dict[str, Any],
    lev: float,
    risk_lo: float,
    risk_hi: float,
) -> dict[str, Any] | None:
    row = df.iloc[bi]
    signal_close = float(row["close"])
    next_open = float(df.iloc[bi + 1]["open"])
    entry = resolve_backtest_entry_price(
        side=side,
        signal_bar_close=signal_close,
        next_bar_open=next_open,
    )
    signal_at_ms = _align_signal_at_ms(_signal_close_ms(df, bi))
    settle_stub: dict[str, Any] = {
        "symbol": sym,
        "tradeSymbol": sym,
        "side": side,
        "entry": entry,
        "signalAt": signal_at_ms,
        "interval": iv,
        "typeLabel": type_label,
        "kind": kind,
        "mcapTier": resolve_mcap_tier(sym),
        "source": "dca_pipeline",
    }
    verify_ms = resolve_verify_delay_ms(settle_stub)
    settle_end = signal_at_ms + verify_ms + 5 * 60_000
    bars_5m = store.load_5m_bars(sym, signal_at_ms, settle_end)
    signal_high = float(row["high"])
    signal_low = float(row["low"])
    plan = _pin_extreme_plan(
        entry=entry,
        side=side,
        signal_high=signal_high,
        signal_low=signal_low,
        verify_delay_ms=verify_ms,
        exit_plan=plan_id,
        min_risk_pct=risk_lo,
        max_risk_pct=risk_hi,
    )
    if plan is None:
        return None
    sl_dist_pct = abs(entry - plan.sl_price) / entry * 100.0 if entry else 0.0
    settled = settle_signal_by_5m_bars(
        side=side,
        entry=entry,
        symbol=sym,
        signal_at_ms=signal_at_ms,
        bars_5m=bars_5m,
        now_ms=settle_end,
        plan=plan,
        breakeven_after_tp1=bool(plan_meta.get("breakeven_after_tp1")),
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
    pnl20 = round(price_move * float(lev), 4) if price_move is not None else None
    return {
        "symbol": sym,
        "interval": iv,
        "kind": kind,
        "typeLabel": type_label,
        "side": side,
        "emit": "dca_nlv_flip",
        "mode": "nlv_flip",
        "signalAt": signal_at_ms,
        "entry": entry,
        "mcapTier": settle_stub.get("mcapTier"),
        "outcome": settled.get("outcome"),
        "movePct": settled.get("movePct"),
        "netMovePct": settled.get("netMovePct"),
        "priceMovePct": price_move,
        "pnlPct": pnl20 if pnl20 is not None else settled.get("pnlPct"),
        "pnlPct20x": pnl20,
        "exitPrice": settled.get("exitPrice"),
        "slPrice": plan.sl_price,
        "initialSlPrice": plan.sl_price,
        "exitSlPrice": settled.get("slPrice"),
        "tp1Price": settled.get("tp1Price") or plan.tp1_price,
        "riskR": plan.risk_r,
        "error": settled.get("error"),
        "slMode": NLV_SL_MODE,
        "exitPlan": plan_id,
        "exitPlanLabel": plan_meta.get("label"),
        "slPct": round(sl_dist_pct, 4),
        "invalidLevel": signal_low if side == "long" else signal_high,
        "signalBarHigh": signal_high,
        "signalBarLow": signal_low,
        "profileId": plan.profile_id,
        "reportLeverage": lev,
        "assetClass": "crypto",
        "category": "dca",
        "categoryLabel": "短线DCA · TD9/维加斯/形态/NLV",
    }


def _run_mode_nlv_flip(
    *,
    store: BacktestKlineStore,
    sym: str,
    iv: str,
    df: pd.DataFrame,
    sig: pd.DataFrame,
    warm: int,
    plan_id: str,
    plan_meta: dict[str, Any],
    lev: float,
    risk_lo: float,
    risk_hi: float,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    n = len(df)
    last_i = n - 2
    for bi in range(warm, max(warm, last_i + 1)):
        if bi > last_i:
            break
        nlv = int(sig.iloc[bi]["nlv"]) if bi < len(sig) else 0
        if nlv == 0:
            continue
        side = "long" if nlv == 1 else "short"
        kind = "dca_nlv_buy" if nlv == 1 else "dca_nlv_sell"
        type_label = "DCA·NLV买" if nlv == 1 else "DCA·NLV卖"
        it = _settle_nlv_leg(
            store=store,
            sym=sym,
            iv=iv,
            df=df,
            bi=bi,
            side=side,
            kind=kind,
            type_label=type_label,
            plan_id=plan_id,
            plan_meta=plan_meta,
            lev=lev,
            risk_lo=risk_lo,
            risk_hi=risk_hi,
        )
        if it:
            items.append(it)
    return items


def _run_mode_td9_long(
    *,
    sym: str,
    iv: str,
    df: pd.DataFrame,
    sig: pd.DataFrame,
    warm: int,
    lev: float,
) -> list[dict[str, Any]]:
    """顺序持仓：-9 开多（下一根开盘），持有至 +9（下一根开盘平）。无硬 SL。"""
    items: list[dict[str, Any]] = []
    n = len(df)
    last_i = n - 2
    pos_entry_bi: int | None = None
    pos_entry_price: float | None = None
    pos_signal_at: int | None = None
    pos_signal_low: float | None = None
    pos_signal_high: float | None = None

    for bi in range(warm, max(warm, last_i + 1)):
        if bi > last_i:
            break
        row_sig = sig.iloc[bi]
        td_os = bool(row_sig["td_os"])
        td_ob = bool(row_sig["td_ob"])

        if pos_entry_bi is None:
            if not td_os:
                continue
            # 信号在 bi 收盘确认，入场 bi+1 open
            entry = resolve_backtest_entry_price(
                side="long",
                signal_bar_close=float(df.iloc[bi]["close"]),
                next_bar_open=float(df.iloc[bi + 1]["open"]),
            )
            pos_entry_bi = bi + 1
            pos_entry_price = float(entry)
            pos_signal_at = _align_signal_at_ms(_signal_close_ms(df, bi))
            pos_signal_low = float(df.iloc[bi]["low"])
            pos_signal_high = float(df.iloc[bi]["high"])
            continue

        # 已持仓：对手 TD9 出场
        if not td_ob:
            continue
        exit_bi = bi + 1
        if exit_bi >= n:
            break
        exit_px = float(df.iloc[exit_bi]["open"])
        entry_px = float(pos_entry_price or 0)
        if entry_px <= 0:
            pos_entry_bi = None
            continue
        raw_pct = (exit_px - entry_px) / entry_px * 100.0
        net = _apply_costs(raw_pct)
        outcome = "take_profit" if net > 0 else "stop_loss" if net < 0 else "flat"
        # 语义：对手 TD 出场，不是插针；用 price 结果映射胜负
        if abs(net) < 1e-9:
            outcome = "flat"
        pnl20 = round(net * float(lev), 4)
        items.append(
            {
                "symbol": sym,
                "interval": iv,
                "kind": "dca_td9_long",
                "typeLabel": "DCA·TD9多",
                "side": "long",
                "emit": "dca_td9_long",
                "mode": "td9_long",
                "signalAt": pos_signal_at,
                "exitSignalAt": _align_signal_at_ms(_signal_close_ms(df, bi)),
                "entry": entry_px,
                "exitPrice": exit_px,
                "entryBar": pos_entry_bi,
                "exitBar": exit_bi,
                "mcapTier": resolve_mcap_tier(sym),
                "outcome": outcome,
                "movePct": round(raw_pct, 6),
                "netMovePct": round(net, 6),
                "priceMovePct": round(net, 6),
                "pnlPct": pnl20,
                "pnlPct20x": pnl20,
                "slMode": "opposite_td9",
                "slRule": "exit on TD+9 next_bar_open；无插针硬 SL（对齐 Pine enable_strategy）",
                "exitPlan": "opposite_td9",
                "exitPlanLabel": "对手TD9平仓",
                "slPrice": None,
                "initialSlPrice": None,
                "slPct": None,
                "invalidLevel": pos_signal_low,
                "signalBarHigh": pos_signal_high,
                "signalBarLow": pos_signal_low,
                "reportLeverage": lev,
                "assetClass": "crypto",
                "category": "dca",
                "categoryLabel": "短线DCA · TD9/维加斯/形态/NLV",
            }
        )
        pos_entry_bi = None
        pos_entry_price = None
        pos_signal_at = None
        pos_signal_low = None
        pos_signal_high = None
    return items


def _run_mode_confluence(
    *,
    sym: str,
    iv: str,
    df: pd.DataFrame,
    sig: pd.DataFrame,
    warm: int,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    items: list[dict[str, Any]] = []
    counts = {
        "td_os": 0,
        "td_ob": 0,
        "shoot": 0,
        "ss2": 0,
        "inv_s": 0,
        "near_v": 0,
        "nlv_buy": 0,
        "nlv_sell": 0,
        "scored": 0,
    }
    n = len(df)
    last_i = n - 1  # 计分可用最后已写入柱；无下一根要求
    for bi in range(warm, min(len(sig), last_i + 1)):
        row = sig.iloc[bi]
        score = int(row.get("score") or 0)
        if score <= 0:
            continue
        counts["scored"] += 1
        if row.get("td_os"):
            counts["td_os"] += 1
        if row.get("td_ob"):
            counts["td_ob"] += 1
        if row.get("shoot"):
            counts["shoot"] += 1
        if row.get("ss2"):
            counts["ss2"] += 1
        if row.get("inv_s"):
            counts["inv_s"] += 1
        if row.get("near_v"):
            counts["near_v"] += 1
        nlv = int(row.get("nlv") or 0)
        if nlv == 1:
            counts["nlv_buy"] += 1
        elif nlv == -1:
            counts["nlv_sell"] += 1
        items.append(
            {
                "symbol": sym,
                "interval": iv,
                "kind": "dca_confluence",
                "typeLabel": str(row.get("label") or "共振"),
                "side": "alert",
                "emit": "dca_confluence",
                "mode": "confluence",
                "signalAt": _align_signal_at_ms(_signal_close_ms(df, bi)),
                "score": score,
                "td": int(row.get("td") or 0),
                "near_v": bool(row.get("near_v")),
                "shoot": bool(row.get("shoot")),
                "ss2": bool(row.get("ss2")),
                "inv_s": bool(row.get("inv_s")),
                "nlv": nlv,
                "mcapTier": resolve_mcap_tier(sym),
                "outcome": "alert",
                "category": "dca",
                "categoryLabel": "短线DCA · TD9/维加斯/形态/NLV",
            }
        )
    return items, counts


def run_dca_pipeline(
    *,
    symbols: Sequence[str] | None = None,
    interval: str = DEFAULT_INTERVAL,
    universe: str = "majors",
    mode: str | None = None,
    leverage: float | None = None,
    margin_cny: float | None = None,
    warmup: int | None = None,
    klines_root: Path | str | None = None,
    out_dir: Path | str | None = None,
    limit_bars: int = 0,
    exit_plan: str | None = None,
    min_risk_pct: float | None = None,
    max_risk_pct: float | None = None,
) -> DcaPipelineResult:
    t0 = time.time()
    mode_id = resolve_mode(mode)
    lev = float(DCA_BT_LEVERAGE if leverage is None else leverage)
    margin = float(DCA_BT_MARGIN_CNY if margin_cny is None else margin_cny)
    warm_default = min_warmup_bars(mode=mode_id)
    warm = int(warm_default if warmup is None else warmup)
    iv = str(interval or DEFAULT_INTERVAL).strip() or DEFAULT_INTERVAL
    univ = str(universe or "majors").strip().lower() or "majors"
    plan_id = resolve_exit_plan(exit_plan)
    plan_meta = NLV_EXIT_PLANS[plan_id]
    risk_lo = float(NLV_MIN_RISK_PCT if min_risk_pct is None else min_risk_pct)
    risk_hi = float(NLV_MAX_RISK_PCT if max_risk_pct is None else max_risk_pct)

    root = resolve_klines_root(klines_root)
    store = BacktestKlineStore(root=root)
    syms = [
        s.strip().upper()
        for s in (symbols or default_symbols_for_universe(univ, root=root, interval=iv))
        if s.strip()
    ]
    out = _ensure_out(Path(out_dir) if out_dir else _OUT_DIR)

    items: list[dict[str, Any]] = []
    used_syms: list[str] = []
    conf_totals: dict[str, int] = {}

    for sym in syms:
        df = _load_signal_df(store, sym, iv)
        if df.empty:
            logger.warning("DCA 缺 K 线 %s %s", sym, iv)
            continue
        if limit_bars and len(df) > limit_bars:
            df = df.iloc[-limit_bars:].reset_index(drop=True)
        if len(df) < warm + 5:
            logger.warning("DCA 暖机不足跳过 %s %s bars=%s warm=%s", sym, iv, len(df), warm)
            continue
        used_syms.append(sym)
        sig = compute_dca_signal_frame(df)
        if mode_id == "nlv_flip":
            items.extend(
                _run_mode_nlv_flip(
                    store=store,
                    sym=sym,
                    iv=iv,
                    df=df,
                    sig=sig,
                    warm=warm,
                    plan_id=plan_id,
                    plan_meta=plan_meta,
                    lev=lev,
                    risk_lo=risk_lo,
                    risk_hi=risk_hi,
                )
            )
        elif mode_id == "td9_long":
            items.extend(
                _run_mode_td9_long(
                    sym=sym, iv=iv, df=df, sig=sig, warm=warm, lev=lev
                )
            )
        else:
            conf_items, counts = _run_mode_confluence(
                sym=sym, iv=iv, df=df, sig=sig, warm=warm
            )
            items.extend(conf_items)
            for k, v in counts.items():
                conf_totals[k] = conf_totals.get(k, 0) + int(v)

    items.sort(key=lambda x: int(x.get("signalAt") or 0))

    if mode_id == "confluence":
        summary = {
            "total": len(items),
            "wins": 0,
            "losses": 0,
            "winRate": None,
            "totalPnlPct": None,
            "profitFactor": None,
            "expectancyR": None,
            "leverageHint": "Mode C 仅共振计分，无成交/无杠杆合计",
            "confluence": True,
        }
        by_kind = {
            "dca_confluence": {
                "type_label": "共振事件",
                "count": len(items),
                "summary": summary,
            }
        }
        lev_rep = {}
    else:
        trade_items = [
            it
            for it in items
            if str(it.get("outcome") or "") not in ("alert",)
        ]
        summary = summarize_nlv_report(trade_items, leverage=lev) if trade_items else {}
        if summary:
            summary["leverageHint"] = (
                (summary.get("leverageHint") or "")
                + f" · DCA mode={mode_id}"
            )
        by_kind = {}
        kind_labels = {
            "dca_nlv_buy": "DCA·NLV买",
            "dca_nlv_sell": "DCA·NLV卖",
            "dca_td9_long": "DCA·TD9多",
        }
        for kid, lab in kind_labels.items():
            bucket = [it for it in trade_items if it.get("kind") == kid]
            if not bucket and mode_id == "td9_long" and kid != "dca_td9_long":
                continue
            if not bucket and mode_id == "nlv_flip" and kid == "dca_td9_long":
                continue
            by_kind[kid] = {
                "type_label": lab,
                "count": len(bucket),
                "summary": summarize_nlv_report(bucket, leverage=lev) if bucket else {},
                "leverage": leverage_report(bucket, leverage=lev, margin_cny=margin) if bucket else {},
            }
        lev_rep = leverage_report(trade_items, leverage=lev, margin_cny=margin)

    by_tier: dict[str, Any] = {}
    for tid in MCAP_TIER_ORDER:
        bucket = [it for it in items if str(it.get("mcapTier") or "") == tid]
        by_tier[tid] = {
            "label": mcap_tier_label(tid),
            "count": len(bucket),
            "summary": (
                {}
                if mode_id == "confluence"
                else (summarize_nlv_report(bucket, leverage=lev) if bucket else {})
            ),
        }

    result = DcaPipelineResult(
        interval=iv,
        mode=mode_id,
        symbols=used_syms,
        universe=univ,
        exit_plan=plan_id if mode_id == "nlv_flip" else ("opposite_td9" if mode_id == "td9_long" else "none"),
        items=items,
        by_kind=by_kind,
        by_mcap_tier=by_tier,
        summary=summary,
        leverage=lev_rep if isinstance(lev_rep, dict) else {},
        out_dir=str(out),
        klines_root=str(root),
        elapsed_sec=round(time.time() - t0, 2),
        confluence_stats=conf_totals,
    )
    payload = result.to_dict()
    payload["params"] = {
        "category": "dca",
        "categoryLabel": result.category_label,
        "mode": mode_id,
        "modeLabel": DCA_MODES[mode_id]["label"],
        "universe": univ,
        "interval": iv,
        "warmup": warm,
        "exit_plan": result.exit_plan,
        "exit_plan_label": plan_meta.get("label") if mode_id == "nlv_flip" else DCA_MODES[mode_id]["desc"],
        "min_risk_pct": risk_lo if mode_id == "nlv_flip" else None,
        "max_risk_pct": risk_hi if mode_id == "nlv_flip" else None,
        "sl_mode": NLV_SL_MODE if mode_id == "nlv_flip" else ("opposite_td9" if mode_id == "td9_long" else None),
        "sl_note": (
            "NLV 腿：插针极值 + exit_plan"
            if mode_id == "nlv_flip"
            else (
                "TD9：对手 TD9 下一根开盘出场；未加插针/ATR 硬 SL（Pine 市价无 SL）"
                if mode_id == "td9_long"
                else "无成交"
            )
        ),
        "leverage": lev,
        "margin_cny": margin,
        "fee_pct": OI_BT_FEE_PCT,
        "slippage_pct": OI_BT_SLIPPAGE_PCT,
        "closed_bar_only": True,
        "entry": "next_bar_open",
        "telegram": False,
        "pineSource": str(_PINE_DOC) if _PINE_DOC.is_file() else None,
        "regimeTip": tip_for(DCA_MODES[mode_id]["tipKey"]),
    }
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    job_path = out / f"dca_{mode_id}_{univ}_{iv}_{stamp}.json"
    latest = out / "latest_summary.json"
    disk = dict(payload)
    if len(disk.get("items") or []) > 500:
        disk["items"] = disk["items"][:500]
        disk["itemsTruncated"] = True
    payload["jobId"] = job_path.stem
    payload["jobPath"] = str(job_path)
    disk["jobId"] = payload["jobId"]
    disk["jobPath"] = payload["jobPath"]
    disk["params"] = payload["params"]
    job_path.write_text(json.dumps(disk, ensure_ascii=False, indent=2), encoding="utf-8")
    latest.write_text(json.dumps(disk, ensure_ascii=False, indent=2), encoding="utf-8")
    index_path = out / "index.json"
    row = {
        "id": job_path.stem,
        "path": str(job_path),
        "status": "done",
        "startedAt": t0,
        "finishedAt": time.time(),
        "universe": univ,
        "interval": iv,
        "mode": mode_id,
        "total": len(items),
        "winRate": summary.get("winRate"),
        "totalPnlPct": summary.get("totalPnlPct"),
        "profitFactor": summary.get("profitFactor"),
        "category": "dca",
        "categoryLabel": result.category_label,
    }
    rows: list[dict[str, Any]] = []
    if index_path.is_file():
        try:
            raw = json.loads(index_path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                rows = [r for r in raw if isinstance(r, dict)]
        except Exception:  # noqa: BLE001
            rows = []
    rows = [row] + [r for r in rows if str(r.get("id")) != row["id"]]
    index_path.write_text(
        json.dumps(rows[:_MAX_LIST], ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return result


@dataclass
class DcaBacktestJob:
    id: str
    status: str = "pending"
    error: str | None = None
    params: dict[str, Any] = field(default_factory=dict)
    progress: dict[str, Any] = field(default_factory=dict)
    result: dict[str, Any] | None = None
    summary: dict[str, Any] | None = None
    leverage: dict[str, Any] | None = None
    by_kind: dict[str, Any] = field(default_factory=dict)
    by_mcap_tier: dict[str, Any] = field(default_factory=dict)
    items: list[dict[str, Any]] = field(default_factory=list)
    started_at: float = 0.0
    finished_at: float = 0.0
    category: str = "dca"
    category_label: str = "短线DCA · TD9/维加斯/形态/NLV"


def dca_options() -> dict[str, Any]:
    root = resolve_klines_root()
    return {
        "category": "dca",
        "categoryLabel": "短线DCA · TD9/维加斯/形态/NLV",
        "modes": [
            {
                "id": m["id"],
                "label": m["label"],
                "desc": m["desc"],
                "tradeable": m["tradeable"],
                "tipKey": m["tipKey"],
                "regimeTip": tip_for(m["tipKey"]),
            }
            for m in DCA_MODES.values()
        ],
        "defaultMode": DEFAULT_MODE,
        "intervals": list(DCA_INTERVALS),
        "defaultInterval": DEFAULT_INTERVAL,
        "universes": [
            {"id": "majors", "label": "主流 BTC/ETH/SOL"},
            {"id": "t1", "label": "第一梯队"},
            {"id": "t2", "label": "第二梯队"},
            {"id": "t3", "label": "第三梯队"},
            {"id": "all_tiers", "label": "一+二+三梯队名单"},
        ],
        "defaultUniverse": "majors",
        "exitPlans": [
            {
                "id": p["id"],
                "label": p["label"],
                "desc": p["desc"],
            }
            for p in NLV_EXIT_PLANS.values()
        ],
        "defaultExitPlan": NLV_DEFAULT_EXIT_PLAN,
        "settleRules": (
            "已收盘→下一根开盘 · ModeA=NLV腿插针SL+exit_plan · "
            "ModeB=TD9对手信号平仓（无硬SL）· ModeC=只计分 · 报告 20x"
        ),
        "leverage": DCA_BT_LEVERAGE,
        "regimeTip": tip_for("dca"),
        "regimeTips": tips_payload(
            "dca", "dca_nlv_flip", "dca_td9_long", "dca_confluence", "td9", "vegas_candle", "nlv"
        ),
        "pineSource": str(_PINE_DOC) if _PINE_DOC.is_file() else None,
        "mcapTiers": tier_catalog_for_api(),
        "klinesRoot": str(root),
        "outDir": str(_OUT_DIR),
    }


def job_to_dict(job: DcaBacktestJob, *, include_items: bool = True) -> dict[str, Any]:
    out: dict[str, Any] = {
        "ok": True,
        "id": job.id,
        "status": job.status,
        "error": job.error,
        "params": job.params,
        "progress": job.progress,
        "summary": job.summary,
        "leverage": job.leverage,
        "byKind": job.by_kind,
        "byMcapTier": job.by_mcap_tier,
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
        "category": job.category,
        "categoryLabel": job.category_label,
        "itemCount": len(job.items),
    }
    if include_items:
        out["items"] = job.items[:200]
        if len(job.items) > 200:
            out["itemsTruncated"] = True
    if job.result:
        out["result"] = {
            k: job.result.get(k)
            for k in (
                "universe",
                "interval",
                "mode",
                "modeLabel",
                "symbols",
                "item_count",
                "elapsed_sec",
                "out_dir",
                "klines_root",
                "jobId",
                "jobPath",
                "confluenceStats",
                "exit_plan",
            )
            if isinstance(job.result, dict) and k in job.result
        }
    return out


def get_dca_job(job_id: str) -> DcaBacktestJob | None:
    jid = str(job_id or "").strip()
    if not jid:
        return None
    job = _jobs.get(jid)
    if job:
        return job
    path = _OUT_DIR / f"{jid}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict):
        return None
    return DcaBacktestJob(
        id=jid,
        status="done",
        params=data.get("params") if isinstance(data.get("params"), dict) else {},
        summary=data.get("summary") if isinstance(data.get("summary"), dict) else None,
        leverage=data.get("leverage") if isinstance(data.get("leverage"), dict) else None,
        by_kind=data.get("by_kind") if isinstance(data.get("by_kind"), dict) else {},
        by_mcap_tier=data.get("by_mcap_tier") if isinstance(data.get("by_mcap_tier"), dict) else {},
        items=list(data.get("items") or []) if isinstance(data.get("items"), list) else [],
        result=data,
    )


def get_latest_dca_job() -> DcaBacktestJob | None:
    mem = list(_jobs.values())
    if mem:
        mem.sort(key=lambda j: j.started_at or 0, reverse=True)
        return mem[0]
    latest = _OUT_DIR / "latest_summary.json"
    if not latest.is_file():
        return None
    try:
        data = json.loads(latest.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict):
        return None
    jid = str(data.get("jobId") or "latest")
    return DcaBacktestJob(
        id=jid,
        status="done",
        params=data.get("params") if isinstance(data.get("params"), dict) else {},
        summary=data.get("summary") if isinstance(data.get("summary"), dict) else None,
        leverage=data.get("leverage") if isinstance(data.get("leverage"), dict) else None,
        by_kind=data.get("by_kind") if isinstance(data.get("by_kind"), dict) else {},
        by_mcap_tier=data.get("by_mcap_tier") if isinstance(data.get("by_mcap_tier"), dict) else {},
        items=list(data.get("items") or []) if isinstance(data.get("items"), list) else [],
        result=data,
    )


def list_dca_jobs(limit: int = 40) -> list[dict[str, Any]]:
    index_path = _OUT_DIR / "index.json"
    rows: list[dict[str, Any]] = []
    if index_path.is_file():
        try:
            raw = json.loads(index_path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                rows = [r for r in raw if isinstance(r, dict)]
        except Exception:  # noqa: BLE001
            rows = []
    for j in _jobs.values():
        if j.status in ("running", "pending"):
            rows = [
                {
                    "id": j.id,
                    "status": j.status,
                    "startedAt": j.started_at,
                    "finishedAt": j.finished_at,
                    "universe": (j.params or {}).get("universe"),
                    "interval": (j.params or {}).get("interval"),
                    "mode": (j.params or {}).get("mode"),
                    "total": len(j.items),
                    "category": "dca",
                    "categoryLabel": j.category_label,
                }
            ] + [r for r in rows if str(r.get("id")) != j.id]
    return rows[: max(1, min(int(limit or 40), _MAX_LIST))]


async def _run_dca_job(job: DcaBacktestJob) -> None:
    job.status = "running"
    job.started_at = time.time()
    job.progress = {"current": "扫描 DCA 信号…"}
    try:
        p = job.params or {}
        loop = asyncio.get_running_loop()

        def _call() -> DcaPipelineResult:
            return run_dca_pipeline(
                symbols=p.get("symbols") or None,
                interval=str(p.get("interval") or DEFAULT_INTERVAL),
                universe=str(p.get("universe") or "majors"),
                mode=str(p.get("mode") or DEFAULT_MODE),
                leverage=float(p["leverage"]) if p.get("leverage") is not None else None,
                margin_cny=float(p["marginCny"]) if p.get("marginCny") is not None else None,
                warmup=int(p["warmup"]) if p.get("warmup") is not None else None,
                limit_bars=int(p.get("limitBars") or 0),
                exit_plan=str(p.get("exitPlan") or NLV_DEFAULT_EXIT_PLAN),
                min_risk_pct=float(p["minRiskPct"]) if p.get("minRiskPct") is not None else None,
                max_risk_pct=float(p["maxRiskPct"]) if p.get("maxRiskPct") is not None else None,
            )

        result = await loop.run_in_executor(None, _call)
        payload = result.to_dict()
        latest = _OUT_DIR / "latest_summary.json"
        if latest.is_file():
            try:
                disk = json.loads(latest.read_text(encoding="utf-8"))
                if isinstance(disk, dict) and disk.get("jobId"):
                    payload["jobId"] = disk["jobId"]
                    payload["jobPath"] = disk.get("jobPath")
                    payload["params"] = disk.get("params") or payload.get("params")
            except Exception:  # noqa: BLE001
                pass
        job.result = payload
        job.summary = result.summary
        job.leverage = result.leverage
        job.by_kind = result.by_kind
        job.by_mcap_tier = result.by_mcap_tier
        job.items = result.items
        job.status = "done"
        job.progress = {"current": "完成", "total": len(result.items)}
    except Exception as exc:  # noqa: BLE001
        logger.exception("DCA 回测失败")
        job.status = "failed"
        job.error = str(exc)
        job.progress = {"current": "失败"}
    finally:
        job.finished_at = time.time()


async def start_dca_backtest(params: dict[str, Any] | None = None) -> DcaBacktestJob:
    body = params if isinstance(params, dict) else {}
    symbols_raw = body.get("symbols")
    symbols: list[str] | None = None
    if isinstance(symbols_raw, str) and symbols_raw.strip():
        symbols = [s.strip().upper() for s in symbols_raw.split(",") if s.strip()]
    elif isinstance(symbols_raw, list):
        symbols = [str(s).strip().upper() for s in symbols_raw if str(s).strip()]

    mode_id = resolve_mode(body.get("mode") or body.get("dcaMode"))
    job = DcaBacktestJob(
        id=uuid.uuid4().hex[:12],
        params={
            "universe": str(body.get("universe") or "majors"),
            "interval": str(body.get("interval") or DEFAULT_INTERVAL),
            "mode": mode_id,
            "symbols": symbols,
            "exitPlan": resolve_exit_plan(
                body.get("exitPlan") or body.get("exit_plan") or body.get("plan")
            ),
            "minRiskPct": body.get("minRiskPct", body.get("min_risk_pct")),
            "maxRiskPct": body.get("maxRiskPct", body.get("max_risk_pct")),
            "leverage": body.get("leverage"),
            "marginCny": body.get("marginCny", body.get("margin_cny")),
            "warmup": body.get("warmup"),
            "limitBars": body.get("limitBars", body.get("limit_bars")),
            "category": "dca",
            "categoryLabel": "短线DCA · TD9/维加斯/形态/NLV",
            "regimeTip": tip_for(DCA_MODES[mode_id]["tipKey"]),
        },
    )
    async with _jobs_lock:
        _jobs[job.id] = job
        if len(_jobs) > _MAX_JOBS:
            oldest = sorted(_jobs.values(), key=lambda j: j.started_at or 0)
            for j in oldest:
                if j.status in ("done", "failed") and len(_jobs) > _MAX_JOBS:
                    _jobs.pop(j.id, None)
    asyncio.create_task(_run_dca_job(job))
    return job
