"""新高/新低末端+放量（NLV / revVol）回测流水线。

口径与 sequoia_pipeline / 币圈用户约定对齐：
- 信号：range_extreme_volume（50 根 HHV/LLV 末端 + vol MA120 + degree±0.2 + lookback 冷却）
- 仅已收盘 K 出信号；下一根开盘价入场（OI_BT next_bar_open + 滑点）
- 结算：插针极值止损 + 可选盈亏比（fixed_2r / fixed_3r / scaled 1.5R+3R）；风险过滤 0.2%–2%
- 报告统一 20x 杠杆（summarize_nlv_report）
- 落盘：data/nlv_backtest/（latest_summary.json + job JSON）
- 汇总：summarize_nlv_report（统一 reportLeverage，避免胜率库对 BTC/ETH/SOL 再乘 100x）
- 不推 Telegram；可按市值梯队 t1/t2/t3 选宇宙，便于后续整泡对比
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

from oi_mornitor.backtest.sequoia_pipeline import (
    SEQUOIA_BT_LEVERAGE,
    SEQUOIA_BT_MARGIN_CNY,
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
from oi_mornitor.pattern_settle_profile import SettlePlan, resolve_verify_delay_ms
from oi_mornitor.backtest.regime_tips import tip_for, tips_payload
from oi_mornitor.range_extreme_volume import (
    LOOKBACK,
    MA_VOL,
    ohlcv_from_df,
    range_extreme_signal_series,
    rev_vol_label_zh,
)

logger = logging.getLogger(__name__)

_PKG = Path(__file__).resolve().parents[1]
_DATA = _PKG / "data"
_OUT_DIR = _DATA / "nlv_backtest"

# 旧固定 % SL 已弃用；保留 env 仅作兼容读取，默认不再使用
NLV_BT_SL_PCT = env_float("OI_NLV_BT_SL_PCT", 0.0, min_val=0.0)
NLV_SL_MODE = "pin_extreme"
NLV_BT_LEVERAGE = env_float("OI_NLV_BT_LEVERAGE", SEQUOIA_BT_LEVERAGE, min_val=1.0)
NLV_BT_MARGIN_CNY = env_float("OI_NLV_BT_MARGIN_CNY", SEQUOIA_BT_MARGIN_CNY, min_val=0.0)
# 入场过滤：插针风险占价格比（小止损 thesis）
NLV_MIN_RISK_PCT = env_float("OI_NLV_MIN_RISK_PCT", 0.2, min_val=0.0)
NLV_MAX_RISK_PCT = env_float("OI_NLV_MAX_RISK_PCT", 2.0, min_val=0.01)
NLV_EXIT_PLANS: dict[str, dict[str, Any]] = {
    "fixed_2r": {
        "id": "fixed_2r",
        "label": "全平 2R",
        "tp1_r": 2.0,
        "tp2_r": 2.0,
        "weights": (1.0, 0.0, 0.0),
        "breakeven_after_tp1": False,
        "desc": "止损=插针极值；全仓 +2R 止盈",
    },
    "fixed_3r": {
        "id": "fixed_3r",
        "label": "全平 3R",
        "tp1_r": 3.0,
        "tp2_r": 3.0,
        "weights": (1.0, 0.0, 0.0),
        "breakeven_after_tp1": False,
        "desc": "止损=插针极值；全仓 +3R 止盈",
    },
    "scaled": {
        "id": "scaled",
        "label": "分批 1.5R+3R",
        "tp1_r": 1.5,
        "tp2_r": 3.0,
        "weights": (0.5, 0.5, 0.0),
        "breakeven_after_tp1": True,
        "desc": "50% 在 +1.5R 平仓并将止损移至成本；余 50% 盯 +3R；跌破插针/成本则停",
    },
}
NLV_DEFAULT_EXIT_PLAN = "scaled"
# vol MA120 + lookback → 默认暖机略大于 MA_VOL
NLV_BT_WARMUP = env_int("OI_NLV_BT_WARMUP", max(MA_VOL + LOOKBACK + 2, 130), min_val=40)

NLV_KIND_OPTIONS: list[dict[str, str]] = [
    {"id": "rev_vol_buy", "label": "新低末端放量买", "side": "bull"},
    {"id": "rev_vol_sell", "label": "新高末端放量卖", "side": "bear"},
]
NLV_INTERVALS = ("15m", "1h", "4h")
DEFAULT_INTERVAL = "1h"

_jobs: dict[str, "NlvBacktestJob"] = {}
_jobs_lock = asyncio.Lock()
_MAX_JOBS = 8
_MAX_LIST = 40


def _ensure_out(out: Path | None = None) -> Path:
    root = Path(out) if out else _OUT_DIR
    root.mkdir(parents=True, exist_ok=True)
    return root


def _tier_band_symbols(tier_id: str) -> list[str]:
    """从 symbol_mcap_tiers.json bands 取梯队示例名单（非全市场）。"""
    path = _DATA / "symbol_mcap_tiers.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    bands = raw.get("bands") if isinstance(raw, dict) else None
    if not isinstance(bands, dict):
        return []
    band = bands.get(str(tier_id).strip().lower()) or {}
    syms = band.get("symbols") if isinstance(band, dict) else None
    if not isinstance(syms, list):
        return []
    return [str(s).strip().upper() for s in syms if str(s).strip()]


def default_symbols_for_universe(
    universe: str,
    *,
    root: Path | None = None,
    interval: str = DEFAULT_INTERVAL,
) -> list[str]:
    """majors | t1 | t2 | t3 | all_tiers → 有 parquet 的符号列表。"""
    u = (universe or "majors").strip().lower()
    r = resolve_klines_root(root)
    store = BacktestKlineStore(root=r)
    want: list[str]
    if u in ("majors", "major", "btc_eth_sol"):
        want = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    elif u in ("t1", "tier1", "第一梯队"):
        want = _tier_band_symbols("t1") or ["BTCUSDT", "ETHUSDT"]
    elif u in ("t2", "tier2", "第二梯队"):
        want = _tier_band_symbols("t2") or ["BNBUSDT", "SOLUSDT", "XRPUSDT"]
    elif u in ("t3", "tier3", "第三梯队"):
        want = _tier_band_symbols("t3") or [
            "TRXUSDT",
            "DOGEUSDT",
            "ADAUSDT",
            "AVAXUSDT",
            "NEARUSDT",
            "LINKUSDT",
        ]
    elif u in ("all_tiers", "tiers", "t1_t2_t3"):
        want = []
        for tid in MCAP_TIER_ORDER:
            for s in _tier_band_symbols(tid):
                if s not in want:
                    want.append(s)
        if not want:
            want = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"]
    else:
        want = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

    out: list[str] = []
    for sym in want:
        path = store.parquet_root / sym / f"{interval}.parquet"
        if path.is_file():
            out.append(sym)
        else:
            logger.warning("NLV 缺 K 线跳过 %s %s", sym, interval)
    return out


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



def resolve_exit_plan(raw: str | None) -> str:
    key = str(raw or NLV_DEFAULT_EXIT_PLAN).strip().lower()
    aliases = {
        "2r": "fixed_2r",
        "fixed2": "fixed_2r",
        "full_2r": "fixed_2r",
        "3r": "fixed_3r",
        "fixed3": "fixed_3r",
        "full_3r": "fixed_3r",
        "scale": "scaled",
        "batch": "scaled",
        "1.5r+3r": "scaled",
        "scaled_1_5_3": "scaled",
    }
    key = aliases.get(key, key)
    if key not in NLV_EXIT_PLANS:
        return NLV_DEFAULT_EXIT_PLAN
    return key


def _pin_extreme_plan(
    *,
    entry: float,
    side: str,
    signal_high: float,
    signal_low: float,
    verify_delay_ms: int,
    exit_plan: str = NLV_DEFAULT_EXIT_PLAN,
    min_risk_pct: float | None = None,
    max_risk_pct: float | None = None,
) -> SettlePlan | None:
    """插针极值止损 + 可选盈亏比方案。

    R = |entry − pin|（多=entry−low，空=high−entry）。
    过滤：R/price 须在 [min_risk_pct, max_risk_pct]%（默认 0.2–2.0）。
    入场已穿越插针 → None。
    """
    is_short = str(side).lower() in ("short", "bear")
    entry_f = float(entry)
    if entry_f <= 0:
        return None
    plan_id = resolve_exit_plan(exit_plan)
    meta = NLV_EXIT_PLANS[plan_id]
    lo = float(NLV_MIN_RISK_PCT if min_risk_pct is None else min_risk_pct)
    hi = float(NLV_MAX_RISK_PCT if max_risk_pct is None else max_risk_pct)
    if hi < lo:
        lo, hi = hi, lo

    if is_short:
        sl = float(signal_high)
        if sl <= entry_f:
            return None
        risk = sl - entry_f
    else:
        sl = float(signal_low)
        if sl >= entry_f:
            return None
        risk = entry_f - sl
    if risk <= 0:
        return None
    risk_pct = risk / entry_f * 100.0
    if risk_pct < lo or risk_pct > hi:
        return None

    tp1_r = float(meta["tp1_r"])
    tp2_r = float(meta["tp2_r"])
    weights = tuple(meta["weights"])  # type: ignore[arg-type]
    if is_short:
        tp1 = entry_f - risk * tp1_r
        tp2 = entry_f - risk * tp2_r
    else:
        tp1 = entry_f + risk * tp1_r
        tp2 = entry_f + risk * tp2_r

    return SettlePlan(
        profile_id=f"nlv_pin_{plan_id}",
        sl_price=sl,
        tp1_price=tp1,
        tp2_price=tp2,
        batch_weights=weights,  # type: ignore[arg-type]
        runner_trail_pct=0.0,  # 无 runner；第三档权重应为 0
        verify_delay_ms=int(verify_delay_ms),
        risk_r=risk,
        tp1_r=tp1_r,
        tp2_r=tp2_r,
    )


@dataclass
class NlvPipelineResult:
    interval: str
    sl_pct: float
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
    category: str = "nlv"
    category_label: str = "新高/新低末端+放量"

    def to_dict(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "categoryLabel": self.category_label,
            "universe": self.universe,
            "exit_plan": self.exit_plan,
            "interval": self.interval,
            "sl_pct": self.sl_pct,
            "symbols": self.symbols,
            "item_count": len(self.items),
            "by_kind": self.by_kind,
            "by_mcap_tier": self.by_mcap_tier,
            "summary": self.summary,
            "leverage": self.leverage,
            "out_dir": self.out_dir,
            "klines_root": self.klines_root,
            "elapsed_sec": self.elapsed_sec,
            "items": self.items,
        }



def _price_move(it: dict[str, Any]) -> float | None:
    for k in ("priceMovePct", "netMovePct", "movePct"):
        if it.get(k) is None:
            continue
        try:
            return float(it[k])
        except (TypeError, ValueError):
            continue
    return None


def _initial_risk_pct(it: dict[str, Any]) -> float | None:
    """插针初始风险%（入场→invalid）；不用结算后抬到成本的 slPrice。"""
    try:
        entry = float(it.get("entry") or 0)
    except (TypeError, ValueError):
        return None
    if entry <= 0:
        return None
    inv = it.get("invalidLevel")
    if inv is None:
        inv = it.get("initialSlPrice")
    try:
        inv_f = float(inv) if inv is not None else None
    except (TypeError, ValueError):
        inv_f = None
    if inv_f is None or inv_f <= 0:
        # fallback: 记录的 slPct（开仓时风险距离）
        try:
            sp = float(it.get("slPct") or 0)
        except (TypeError, ValueError):
            sp = 0.0
        return sp if sp > 0 else None
    return abs(entry - inv_f) / entry * 100.0


def summarize_nlv_report(
    items: list[dict[str, Any]],
    *,
    leverage: float = NLV_BT_LEVERAGE,
) -> dict[str, Any]:
    """NLV 专用汇总：禁止走胜率库 _rec_pnl_pct（BTC/ETH/SOL 会再乘 100x）。

    - totalPnlPct = Σ(价格涨跌% × reportLeverage)，与 UI「合计(20x)」一致
    - totalPricePct = Σ 价格涨跌%（未杠杆）
    - expectancyR / sumR 用插针初始风险，不受 TP1 后保本改 SL 污染
    - profitFactor 用价格涨跌绝对值比（与杠杆无关）
    """
    lev = float(leverage) if leverage and leverage > 0 else float(NLV_BT_LEVERAGE)
    headline = [
        it
        for it in items
        if str(it.get("outcome") or "") not in ("flat", "error", "")
    ]
    pending = wins = losses = 0
    errors = sum(1 for it in items if str(it.get("outcome") or "") == "error")
    flats = sum(1 for it in items if str(it.get("outcome") or "") == "flat")

    price_list: list[float] = []
    win_prices: list[float] = []
    loss_prices: list[float] = []
    rs: list[float] = []
    risks: list[float] = []

    for it in headline:
        oc = str(it.get("outcome") or "")
        if oc == "pending":
            pending += 1
            continue
        pm = _price_move(it)
        if oc == "take_profit":
            wins += 1
        elif oc == "stop_loss":
            losses += 1
        if pm is None:
            continue
        price_list.append(pm)
        if pm > 0:
            win_prices.append(pm)
        elif pm < 0:
            loss_prices.append(pm)
        risk_pct = _initial_risk_pct(it)
        if risk_pct is not None and risk_pct > 1e-9:
            risks.append(risk_pct)
            rs.append(pm / risk_pct)

    settled = wins + losses
    gross_win = sum(win_prices)
    gross_loss = abs(sum(loss_prices))
    pf = (gross_win / gross_loss) if gross_loss > 1e-12 else None
    sum_price = sum(price_list) if price_list else 0.0
    sum_20 = sum_price * lev
    exp_r = (sum(rs) / len(rs)) if rs else None
    sum_r = sum(rs) if rs else None

    # max DD on unlevered price equity curve (start 100)
    equity = 100.0
    peak = 100.0
    max_dd = 0.0
    for pm in price_list:
        equity *= 1.0 + pm / 100.0
        peak = max(peak, equity)
        dd = (peak - equity) / peak * 100.0 if peak > 0 else 0.0
        max_dd = max(max_dd, dd)

    return {
        "total": len(headline),
        "pending": pending,
        "wins": wins,
        "losses": losses,
        "flats": flats,
        "errors": errors,
        "winRate": (wins / settled) if settled else None,
        # UI 主字段：统一报告杠杆（默认 20x）简单加总，非复利账户
        "totalPnlPct": round(sum_20, 2) if price_list else None,
        "totalPricePct": round(sum_price, 4) if price_list else None,
        "avgPricePct": round(sum_price / len(price_list), 4) if price_list else None,
        "avgWinPricePct": round(sum(win_prices) / len(win_prices), 4) if win_prices else None,
        "avgLossPricePct": round(sum(loss_prices) / len(loss_prices), 4) if loss_prices else None,
        "medianRiskPct": (
            round(sorted(risks)[len(risks) // 2], 4) if risks else None
        ),
        "avgRiskPct": round(sum(risks) / len(risks), 4) if risks else None,
        "expectancyR": round(exp_r, 3) if exp_r is not None else None,
        "sumR": round(sum_r, 3) if sum_r is not None else None,
        "profitFactor": round(pf, 3) if pf is not None else None,
        "maxDrawdownPct": round(max_dd, 3),
        "reportLeverage": lev,
        "pnlBasis": "sum(priceMovePct × reportLeverage)；非胜率库 100x/20x 混乘",
        "observationExcluded": 0,
        "flatErrorExcluded": errors + flats,
        "leverageHint": (
            f"NLV 报告统一 {lev:g}x · 合计=各笔价格涨跌%×{lev:g} 简单加总（非复利）· "
            "期望R=价格涨跌%/插针初始风险%"
        ),
    }


def run_nlv_pipeline(
    *,
    symbols: Sequence[str] | None = None,
    interval: str = DEFAULT_INTERVAL,
    universe: str = "majors",
    sl_pct: float | None = None,
    leverage: float | None = None,
    margin_cny: float | None = None,
    warmup: int | None = None,
    klines_root: Path | str | None = None,
    out_dir: Path | str | None = None,
    limit_bars: int = 0,
    kinds: Sequence[str] | None = None,
    exit_plan: str | None = None,
    min_risk_pct: float | None = None,
    max_risk_pct: float | None = None,
) -> NlvPipelineResult:
    """本地 parquet → NLV 信号 → next_bar 入场 → 插针极值 SL + 可选盈亏比方案 / 20x 报告。"""
    t0 = time.time()
    # sl_pct 参数保留兼容，但默认不再驱动止损
    sl = float(NLV_BT_SL_PCT if sl_pct is None else sl_pct)
    lev = float(NLV_BT_LEVERAGE if leverage is None else leverage)
    margin = float(NLV_BT_MARGIN_CNY if margin_cny is None else margin_cny)
    warm = int(NLV_BT_WARMUP if warmup is None else warmup)
    iv = str(interval or DEFAULT_INTERVAL).strip() or DEFAULT_INTERVAL
    univ = str(universe or "majors").strip().lower() or "majors"
    plan_id = resolve_exit_plan(exit_plan)
    plan_meta = NLV_EXIT_PLANS[plan_id]
    risk_lo = float(NLV_MIN_RISK_PCT if min_risk_pct is None else min_risk_pct)
    risk_hi = float(NLV_MAX_RISK_PCT if max_risk_pct is None else max_risk_pct)

    kind_allow = {
        str(k).strip().lower()
        for k in (kinds or [o["id"] for o in NLV_KIND_OPTIONS])
        if str(k).strip()
    }
    if not kind_allow:
        kind_allow = {o["id"] for o in NLV_KIND_OPTIONS}

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
    for sym in syms:
        df = _load_signal_df(store, sym, iv)
        if df.empty:
            logger.warning("NLV 缺 K 线 %s %s", sym, iv)
            continue
        if limit_bars and len(df) > limit_bars:
            df = df.iloc[-limit_bars:].reset_index(drop=True)
        used_syms.append(sym)
        n = len(df)
        o, h, l, c, v = ohlcv_from_df(df)
        # range_extreme_signal_series(highs, lows, opens, closes, volumes)
        sigs = range_extreme_signal_series(h, l, o, c, v)
        last_i = n - 2  # 需下一根入场；丢弃可能未收盘末棒
        for bi in range(warm, max(warm, last_i + 1)):
            if bi > last_i:
                break
            sig = int(sigs[bi]) if bi < len(sigs) else 0
            if sig == 0:
                continue
            kind = "rev_vol_buy" if sig == 1 else "rev_vol_sell"
            if kind not in kind_allow:
                continue
            side = "long" if sig == 1 else "short"
            type_label = rev_vol_label_zh(sig)
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
                "type_label": type_label,
                "kind": kind,
                "mcapTier": resolve_mcap_tier(sym),
                "source": "nlv_pipeline",
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
                continue
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
            pnl20 = (
                round(price_move * float(lev), 4) if price_move is not None else None
            )
            items.append(
                {
                    "symbol": sym,
                    "interval": iv,
                    "kind": kind,
                    "typeLabel": type_label,
                    "side": side,
                    "emit": "nlv",
                    "revVolSignal": sig,
                    "signalAt": signal_at_ms,
                    "entry": entry,
                    "mcapTier": settle_stub.get("mcapTier"),
                    "outcome": settled.get("outcome"),
                    "movePct": settled.get("movePct"),
                    "netMovePct": settled.get("netMovePct"),
                    "priceMovePct": price_move,
                    "pnlPctLive": settled.get("pnlPct"),
                    "pnlPct": pnl20 if pnl20 is not None else settled.get("pnlPct"),
                    "pnlPct20x": pnl20,
                    "exitPrice": settled.get("exitPrice"),
                    # 展示/统计用初始插针止损；结算过程可能把 SL 抬到成本
                    "slPrice": plan.sl_price,
                    "initialSlPrice": plan.sl_price,
                    "exitSlPrice": settled.get("slPrice"),
                    "tp1Price": settled.get("tp1Price") or plan.tp1_price,
                    "riskR": plan.risk_r,
                    "error": settled.get("error"),
                    "slMode": NLV_SL_MODE,
                    "exitPlan": plan_id,
                    "exitPlanLabel": plan_meta.get("label"),
                    "slPct": round(sl_dist_pct, 4),  # 开仓时插针风险距离%
                    "invalidLevel": signal_low if side == "long" else signal_high,
                    "signalBarHigh": signal_high,
                    "signalBarLow": signal_low,
                    "profileId": plan.profile_id,
                    "reportLeverage": lev,
                    # 供误用 _rec_pnl_pct 时也不要按 100x：标记 equity 无效；仍以 summarize_nlv_report 为准
                    "assetClass": "crypto",
                    "category": "nlv",
                    "categoryLabel": "新高/新低末端+放量",
                }
            )

    items.sort(key=lambda x: int(x.get("signalAt") or 0))
    summary = summarize_nlv_report(items, leverage=lev) if items else {}
    by_dim: list[dict[str, Any]] = []
    if items:
        groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
        for it in items:
            key = (
                str(it.get("typeLabel") or "—"),
                str(it.get("interval") or "—"),
                str(it.get("mcapTier") or "—"),
            )
            groups.setdefault(key, []).append(it)
        for key, bucket in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            row = {"count": len(bucket), **summarize_nlv_report(bucket, leverage=lev)}
            row["typeLabel"], row["interval"], row["mcapTier"] = key
            by_dim.append(row)
    by_kind: dict[str, Any] = {}
    for opt in NLV_KIND_OPTIONS:
        kid = opt["id"]
        bucket = [it for it in items if it.get("kind") == kid]
        by_kind[kid] = {
            "type_label": opt["label"],
            "count": len(bucket),
            "summary": summarize_nlv_report(bucket, leverage=lev) if bucket else {},
            "leverage": leverage_report(bucket, leverage=lev, margin_cny=margin),
        }
    by_tier: dict[str, Any] = {}
    for tid in MCAP_TIER_ORDER:
        bucket = [it for it in items if str(it.get("mcapTier") or "") == tid]
        by_tier[tid] = {
            "label": mcap_tier_label(tid),
            "count": len(bucket),
            "summary": summarize_nlv_report(bucket, leverage=lev) if bucket else {},
            "leverage": leverage_report(bucket, leverage=lev, margin_cny=margin),
        }

    lev_rep = leverage_report(items, leverage=lev, margin_cny=margin)
    result = NlvPipelineResult(
        interval=iv,
        sl_pct=0.0,  # 非固定%；详见 params.sl_mode
        symbols=used_syms,
        universe=univ,
        exit_plan=plan_id,
        items=items,
        by_kind=by_kind,
        by_mcap_tier=by_tier,
        summary={**summary, "by_dimension": by_dim},
        leverage=lev_rep,
        out_dir=str(out),
        klines_root=str(root),
        elapsed_sec=round(time.time() - t0, 2),
    )
    payload = result.to_dict()
    payload["params"] = {
        "category": "nlv",
        "categoryLabel": "新高/新低末端+放量",
        "universe": univ,
        "sl_mode": NLV_SL_MODE,
        "sl_rule": "long→signal_bar.low / short→signal_bar.high（无额外 buffer）",
        "sl_pct_legacy": sl,  # 兼容字段；不再驱动止损
        "exit_plan": plan_id,
        "exit_plan_label": plan_meta.get("label"),
        "exit_plan_desc": plan_meta.get("desc"),
        "min_risk_pct": risk_lo,
        "max_risk_pct": risk_hi,
        "warmup": warm,
        "interval": iv,
        "fee_pct": OI_BT_FEE_PCT,
        "slippage_pct": OI_BT_SLIPPAGE_PCT,
        "leverage": lev,
        "margin_cny": margin,
        "kinds": sorted(kind_allow),
        "telegram": False,
        "closed_bar_only": True,
        "entry": "next_bar_open",
        "tp": plan_meta.get("desc"),
    }
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    job_path = out / f"nlv_{univ}_{iv}_{plan_id}_{stamp}.json"
    latest = out / "latest_summary.json"
    disk = dict(payload)
    if len(disk.get("items") or []) > 500:
        disk["items"] = disk["items"][:500]
        disk["itemsTruncated"] = True
    payload["jobId"] = job_path.stem
    payload["jobPath"] = str(job_path)
    disk["jobId"] = payload["jobId"]
    disk["jobPath"] = payload["jobPath"]
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
        "total": len(items),
        "winRate": summary.get("winRate"),
        "totalPnlPct": summary.get("totalPnlPct"),
        "totalPricePct": summary.get("totalPricePct"),
        "expectancyR": summary.get("expectancyR"),
        "profitFactor": summary.get("profitFactor"),
        "wins": summary.get("wins"),
        "losses": summary.get("losses"),
        "category": "nlv",
        "categoryLabel": "新高/新低末端+放量",
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
class NlvBacktestJob:
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
    category: str = "nlv"
    category_label: str = "新高/新低末端+放量"


def nlv_options() -> dict[str, Any]:
    root = resolve_klines_root()
    return {
        "category": "nlv",
        "categoryLabel": "新高/新低末端+放量",
        "kindOptions": list(NLV_KIND_OPTIONS),
        "defaultKinds": [o["id"] for o in NLV_KIND_OPTIONS],
        "intervals": list(NLV_INTERVALS),
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
                "tp1R": p["tp1_r"],
                "tp2R": p["tp2_r"],
                "breakevenAfterTp1": p["breakeven_after_tp1"],
            }
            for p in NLV_EXIT_PLANS.values()
        ],
        "defaultExitPlan": NLV_DEFAULT_EXIT_PLAN,
        "minRiskPct": NLV_MIN_RISK_PCT,
        "maxRiskPct": NLV_MAX_RISK_PCT,
        "settleRules": (
            "NLV 已收盘 → 下一根开盘 · 插针极值止损（多=low/空=high）· "
            f"风险过滤 {NLV_MIN_RISK_PCT:g}%–{NLV_MAX_RISK_PCT:g}% · "
            "盈亏比可选：全平2R / 全平3R / 分批1.5R+3R（默认）· 报告统一 20x"
        ),
        "slMode": NLV_SL_MODE,
        "slRule": "long→signal low / short→signal high（at extreme, no buffer）",
        "slPct": None,
        "leverage": NLV_BT_LEVERAGE,
"mcapTiers": tier_catalog_for_api(),
        "klinesRoot": str(root),
        "outDir": str(_OUT_DIR),
        "regimeTip": tip_for("nlv"),
        "regimeTips": tips_payload("nlv"),
    }


def job_to_dict(job: NlvBacktestJob, *, include_items: bool = True) -> dict[str, Any]:
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
                "sl_pct",
                "symbols",
                "item_count",
                "elapsed_sec",
                "out_dir",
                "klines_root",
                "jobId",
                "jobPath",
            )
            if isinstance(job.result, dict) and k in job.result
        }
    return out


def get_nlv_job(job_id: str) -> NlvBacktestJob | None:
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
    return NlvBacktestJob(
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


def get_latest_nlv_job() -> NlvBacktestJob | None:
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
    return NlvBacktestJob(
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


def list_nlv_jobs(limit: int = 40) -> list[dict[str, Any]]:
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
                    "total": len(j.items),
                    "winRate": (j.summary or {}).get("winRate") if j.summary else None,
                    "totalPnlPct": (j.summary or {}).get("totalPnlPct") if j.summary else None,
                    "profitFactor": (j.summary or {}).get("profitFactor") if j.summary else None,
                    "category": "nlv",
                    "categoryLabel": "新高/新低末端+放量",
                }
            ] + [r for r in rows if str(r.get("id")) != j.id]
    return rows[: max(1, min(int(limit or 40), _MAX_LIST))]


async def _run_nlv_job(job: NlvBacktestJob) -> None:
    job.status = "running"
    job.started_at = time.time()
    job.progress = {"current": "扫描 NLV 信号…"}
    try:
        p = job.params or {}
        loop = asyncio.get_running_loop()

        def _call() -> NlvPipelineResult:
            return run_nlv_pipeline(
                symbols=p.get("symbols") or None,
                interval=str(p.get("interval") or DEFAULT_INTERVAL),
                universe=str(p.get("universe") or "majors"),
                sl_pct=float(p["slPct"]) if p.get("slPct") is not None else None,
                leverage=float(p["leverage"]) if p.get("leverage") is not None else None,
                margin_cny=float(p["marginCny"]) if p.get("marginCny") is not None else None,
                warmup=int(p["warmup"]) if p.get("warmup") is not None else None,
                limit_bars=int(p.get("limitBars") or 0),
                kinds=p.get("kinds"),
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
        logger.exception("NLV 回测失败")
        job.status = "failed"
        job.error = str(exc)
        job.progress = {"current": "失败"}
    finally:
        job.finished_at = time.time()


async def start_nlv_backtest(params: dict[str, Any] | None = None) -> NlvBacktestJob:
    body = params if isinstance(params, dict) else {}
    symbols_raw = body.get("symbols")
    symbols: list[str] | None = None
    if isinstance(symbols_raw, str) and symbols_raw.strip():
        symbols = [s.strip().upper() for s in symbols_raw.split(",") if s.strip()]
    elif isinstance(symbols_raw, list):
        symbols = [str(s).strip().upper() for s in symbols_raw if str(s).strip()]

    kinds_raw = body.get("kinds")
    kinds: list[str] | None = None
    if isinstance(kinds_raw, list):
        kinds = [str(k).strip() for k in kinds_raw if str(k).strip()]

    job = NlvBacktestJob(
        id=uuid.uuid4().hex[:12],
        params={
            "universe": str(body.get("universe") or "majors"),
            "interval": str(body.get("interval") or DEFAULT_INTERVAL),
            "symbols": symbols,
            "kinds": kinds,
            "exitPlan": resolve_exit_plan(
                body.get("exitPlan") or body.get("exit_plan") or body.get("plan")
            ),
            "minRiskPct": body.get("minRiskPct", body.get("min_risk_pct")),
            "maxRiskPct": body.get("maxRiskPct", body.get("max_risk_pct")),
            "slPct": body.get("slPct", body.get("sl_pct")),
            "leverage": body.get("leverage"),
            "marginCny": body.get("marginCny", body.get("margin_cny")),
            "warmup": body.get("warmup"),
            "limitBars": body.get("limitBars", body.get("limit_bars")),
            "category": "nlv",
            "categoryLabel": "新高/新低末端+放量",
        },
    )
    async with _jobs_lock:
        _jobs[job.id] = job
        if len(_jobs) > _MAX_JOBS:
            oldest = sorted(_jobs.values(), key=lambda j: j.started_at or 0)
            for j in oldest:
                if j.status in ("done", "failed") and len(_jobs) > _MAX_JOBS:
                    _jobs.pop(j.id, None)
    asyncio.create_task(_run_nlv_job(job))
    return job
