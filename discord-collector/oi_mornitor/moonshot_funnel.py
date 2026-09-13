"""潜力暴涨漏斗：压缩(A) → 蓄势(B) → 触发(C) → 持仓/寻顶/失效。

并行于 LH→HL 形态状态机；结果挂在 pattern.moonshot。
全市场慢扫由 OI_MOONSHOT_FULL_SCAN 控制，默认关。
"""
from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import aiohttp
import pandas as pd

from oi_mornitor.breakout_detector import klines_to_df
from oi_mornitor.config import (
    FAPI_BASE_URL,
    MOONSHOT_A_INTERVAL_SEC,
    MOONSHOT_A_POOL_MAX,
    MOONSHOT_ATR_RATIO,
    MOONSHOT_BB_PCTILE,
    MOONSHOT_BODY_RATIO,
    MOONSHOT_COOLDOWN_DAYS,
    MOONSHOT_COMPRESS_DAYS_MAX,
    MOONSHOT_COMPRESS_DAYS_MIN,
    MOONSHOT_ENABLED,
    MOONSHOT_FULL_SCAN,
    MOONSHOT_HOT_EXCLUDE_TOP,
    MOONSHOT_KLINE_INTERVAL,
    MOONSHOT_KLINE_LIMIT,
    MOONSHOT_QUOTE_VOL_MIN,
    MOONSHOT_RANGE_RATIO,
    MOONSHOT_SCORE_B,
    MOONSHOT_SCORE_C,
    MOONSHOT_STATE_DB,
    MOONSHOT_VOL_BREAK,
    MOONSHOT_VOL_WAKE_HI,
    MOONSHOT_VOL_WAKE_LO,
    OI_TIER_HEAVY_MIN_USD,
    OI_TIER_MID_MIN_USD,
    PATTERN_PIVOT_WINDOW,
    PATTERN_STATE_DB,
)
from oi_mornitor.market_snapshot import TIER_HEAVY, TIER_MID
from oi_mornitor.strategy.indicators import enrich_strategy_indicators
from oi_mornitor.symbol_aliases import is_stablecoin_symbol

logger = logging.getLogger("OI_Radar")

# 状态（每币唯一）
MS_COMPRESS = "COMPRESS"
MS_WAIT_HL = "WAIT_HL"
MS_LH_NEAR = "LH_NEAR"
MS_READY_BREAK = "READY_BREAK"
MS_IN_POSITION = "IN_POSITION"
MS_FIND_TOP = "FIND_TOP"
MS_INVALID = "INVALID"

MS_LABELS: dict[str, str] = {
    MS_COMPRESS: "压缩观察",
    MS_WAIT_HL: "等待更高低点",
    MS_LH_NEAR: "次高点确认",
    MS_READY_BREAK: "待突破",
    MS_IN_POSITION: "持仓",
    MS_FIND_TOP: "寻找顶部",
    MS_INVALID: "失效",
}

# B 池（警报/纸面）；C 才交易
_B_STATES = frozenset({MS_WAIT_HL, MS_LH_NEAR, MS_READY_BREAK})
_ACTIVE_STATES = frozenset(
    {MS_COMPRESS, MS_WAIT_HL, MS_LH_NEAR, MS_READY_BREAK, MS_IN_POSITION, MS_FIND_TOP}
)


def _f(v: Any, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def enrich_moonshot_df(df: pd.DataFrame) -> pd.DataFrame:
    """BB/Vegas + ATR14 + 带宽相对价 + pivot。"""
    if df is None or df.empty:
        return df
    out = enrich_strategy_indicators(df)
    hi = out["high"]
    lo = out["low"]
    prev_c = out["close"].shift(1)
    tr = pd.concat([(hi - lo), (hi - prev_c).abs(), (lo - prev_c).abs()], axis=1).max(axis=1)
    out["atr14"] = tr.rolling(14).mean()
    mid = out["bb_basis"].replace(0, pd.NA)
    out["bb_width_pct"] = (out["bb_width"] / mid).astype(float)
    win = int(PATTERN_PIVOT_WINDOW) if PATTERN_PIVOT_WINDOW else 11
    out["is_pivot_high"] = out["high"] == out["high"].rolling(win, center=True).max()
    out["is_pivot_low"] = out["low"] == out["low"].rolling(win, center=True).min()
    out["is_pivot_high"] = out["is_pivot_high"].fillna(False)
    out["is_pivot_low"] = out["is_pivot_low"].fillna(False)
    return out


def _structure_flags(df: pd.DataFrame) -> dict[str, Any]:
    """HL 雏形 / 收盘吃掉 LH。"""
    out = {
        "higher_low": False,
        "ate_lh": False,
        "last_hl": 0.0,
        "last_lh": 0.0,
        "range_high": 0.0,
    }
    if len(df) < 30:
        return out
    closed = df.iloc[:-1]
    if "is_pivot_low" not in closed.columns:
        return out
    pivot_lows = closed[closed["is_pivot_low"]].tail(3)
    pivot_highs = closed[closed["is_pivot_high"]].tail(3)
    last_close = float(closed.iloc[-1]["close"])
    out["range_high"] = float(closed["high"].tail(12).max())
    if len(pivot_lows) >= 2:
        l1 = float(pivot_lows.iloc[-2]["low"])
        hl = float(pivot_lows.iloc[-1]["low"])
        out["last_hl"] = hl
        if hl > l1 * 1.001 and last_close >= hl:
            out["higher_low"] = True
    if len(pivot_highs) >= 1:
        lh = float(pivot_highs.iloc[-1]["high"])
        out["last_lh"] = lh
        if last_close > lh:
            out["ate_lh"] = True
    return out


def _atr_ratio(df: pd.DataFrame, short: int = 20, long: int = 60) -> float | None:
    if "atr14" not in df.columns or len(df) < long + 2:
        return None
    closed = df.iloc[:-1] if len(df) > short else df
    if len(closed) < long:
        return None
    recent = float(closed["atr14"].tail(short).mean())
    base = float(closed["atr14"].tail(long).mean())
    if base <= 0 or pd.isna(base) or pd.isna(recent):
        return None
    return recent / base


def _bb_width_percentile(df: pd.DataFrame, lookback: int = 60) -> float | None:
    if "bb_width_pct" not in df.columns or len(df) < lookback + 2:
        return None
    closed = df.iloc[:-1]
    win = closed["bb_width_pct"].tail(lookback).dropna()
    if len(win) < max(20, lookback // 3):
        return None
    cur = float(win.iloc[-1])
    return float((win <= cur).mean() * 100.0)


def _range_compressed(df: pd.DataFrame, n: int = 20) -> bool:
    """近 N 根振幅 < 近 60 根中位振幅的 MOONSHOT_RANGE_RATIO。"""
    if len(df) < 60:
        return False
    closed = df.iloc[:-1]
    rng = (closed["high"] - closed["low"]).astype(float)
    recent = float(rng.tail(n).mean())
    med = float(rng.tail(60).median())
    if med <= 0:
        return False
    return recent < med * float(MOONSHOT_RANGE_RATIO)


def _compress_day_span(df: pd.DataFrame, interval: str) -> float:
    """粗估压缩持续「天」：用近段小实体占比回溯。"""
    if len(df) < 30:
        return 0.0
    closed = df.iloc[:-1]
    body = (closed["close"] - closed["open"]).abs()
    rng = (closed["high"] - closed["low"]).replace(0, pd.NA)
    small = (body / rng) < 0.45
    # 从末尾往前数连续偏小实体
    run = 0
    for v in reversed(small.tail(120).tolist()):
        if bool(v):
            run += 1
        else:
            break
    sec = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}.get(interval, 3600)
    return run * sec / 86400.0


def _volume_dead_or_waking(df: pd.DataFrame) -> tuple[bool, float]:
    """近 5 日均量 ≤ 近 30 日，或刚单日量 >1.5× 但仍未加速。返回 (ok, vol_wake近似)。"""
    if len(df) < 40:
        return False, 0.0
    closed = df.iloc[:-1]
    # 用 quote_volume 优先
    vol = closed["quote_volume"] if "quote_volume" in closed.columns else closed["volume"]
    # 按「日」近似：1h→24 根
    bars_day = 24
    if len(closed) < bars_day * 7:
        bars_day = max(6, len(closed) // 10)
    v5 = float(vol.tail(bars_day * 5).mean()) if len(vol) >= bars_day * 5 else float(vol.tail(20).mean())
    v30 = float(vol.tail(bars_day * 30).mean()) if len(vol) >= bars_day * 30 else float(vol.tail(60).mean())
    last = float(vol.iloc[-1])
    wake = (last / v30) if v30 > 0 else 0.0
    dead = v30 > 0 and v5 <= v30 * 1.05
    waking = wake >= 1.5 and wake < float(MOONSHOT_VOL_BREAK)
    return dead or waking, wake


def _price_not_collapsed(df: pd.DataFrame) -> bool:
    """日线未创新低或出现更高低点雏形；收在 EMA12 附近或之上更优。"""
    if len(df) < 40:
        return False
    closed = df.iloc[:-1]
    last = closed.iloc[-1]
    low_min = float(closed["low"].tail(60).min())
    # 未贴近 60 根最低（崩盘区）
    if float(last["low"]) <= low_min * 1.002 and float(last["close"]) < float(last["open"]):
        # 允许若出现抬高低点
        lows = closed["low"].tail(30)
        if len(lows) >= 10 and float(lows.iloc[-1]) <= float(lows.iloc[-10]) * 0.99:
            return False
    vegas = last.get("vegas_filter")
    if vegas is not None and pd.notna(vegas):
        # 跌穿长隧道深处：收盘远低于 EMA12 且在 vegas_min 下
        vmin = last.get("vegas_min")
        if vmin is not None and pd.notna(vmin) and float(last["close"]) < float(vmin) * 0.97:
            return False
    return True


def _vol_wake_24h(df: pd.DataFrame) -> float:
    if len(df) < 50:
        return 0.0
    closed = df.iloc[:-1]
    vol = closed["quote_volume"] if "quote_volume" in closed.columns else closed["volume"]
    v24 = float(vol.tail(24).sum())
    # 7 日均「日量」≈ 24*7 根总量 / 7
    week = vol.tail(24 * 7)
    if len(week) < 24:
        return 0.0
    avg_day = float(week.sum()) / max(1.0, len(week) / 24.0)
    if avg_day <= 0:
        return 0.0
    return v24 / avg_day


def _bull_vol_bias(df: pd.DataFrame, n: int = 20) -> bool:
    closed = df.iloc[:-1].tail(n)
    if closed.empty:
        return False
    up = closed[closed["close"] >= closed["open"]]["volume"].sum()
    dn = closed[closed["close"] < closed["open"]]["volume"].sum()
    return float(up) > float(dn)


def _breakout_quality(df: pd.DataFrame, range_high: float) -> dict[str, Any]:
    """收盘突破 + 放量 + 实体为主。"""
    res = {
        "breakout": False,
        "vol_mult": 0.0,
        "body_ratio": 0.0,
        "extended": False,
    }
    if len(df) < 25 or range_high <= 0:
        return res
    # 用最近已收盘柱
    closed = df.iloc[:-1]
    bar = closed.iloc[-1]
    o, h, l, c = float(bar["open"]), float(bar["high"]), float(bar["low"]), float(bar["close"])
    rng = h - l
    body = abs(c - o)
    body_ratio = (body / rng) if rng > 0 else 0.0
    res["body_ratio"] = body_ratio
    vol = closed["volume"]
    vol_ma = float(vol.tail(20).mean())
    vol_mult = (float(bar["volume"]) / vol_ma) if vol_ma > 0 else 0.0
    res["vol_mult"] = vol_mult
    compress_max = float(vol.tail(40).iloc[:-1].max()) if len(vol) > 40 else vol_ma
    close_ok = c > range_high and c > o
    vol_ok = vol_mult >= float(MOONSHOT_VOL_BREAK) or (
        compress_max > 0 and float(bar["volume"]) >= compress_max
    )
    body_ok = body_ratio >= float(MOONSHOT_BODY_RATIO)
    # 上影不要吞大半
    upper = h - max(o, c)
    wick_ok = rng <= 0 or upper <= rng * 0.45
    res["breakout"] = bool(close_ok and vol_ok and body_ok and wick_ok)
    # 已竖直：距平台 ATR 倍数或量高潮
    atr = float(bar["atr14"]) if pd.notna(bar.get("atr14")) else 0.0
    if atr > 0 and (c - range_high) / atr > 3.0:
        res["extended"] = True
    if vol_mult >= 8.0:
        res["extended"] = True
    return res


def score_moonshot(
    *,
    compress_hits: int,
    structure: dict[str, Any],
    vol_wake: float,
    breakout: dict[str, Any],
    rel_strength: float,
    btc_ok: bool,
    oi_bonus: int = 0,
) -> tuple[float, dict[str, float]]:
    """五项 0～2 + OI 加减分，满分约 10。"""
    parts: dict[str, float] = {}
    # 压缩质量
    parts["compress"] = min(2.0, float(compress_hits) * (2.0 / 3.0))
    # 结构
    s = 0.0
    if structure.get("higher_low"):
        s += 1.2
    if structure.get("ate_lh"):
        s += 1.0
    parts["structure"] = min(2.0, s)
    # 量能
    if vol_wake >= float(MOONSHOT_VOL_BREAK):
        parts["volume"] = 2.0
    elif vol_wake >= float(MOONSHOT_VOL_WAKE_HI):
        parts["volume"] = 1.5
    elif vol_wake >= float(MOONSHOT_VOL_WAKE_LO):
        parts["volume"] = 1.0
    elif vol_wake >= 1.0:
        parts["volume"] = 0.5
    else:
        parts["volume"] = 0.0
    # 突破质量
    if breakout.get("breakout"):
        br = float(breakout.get("body_ratio") or 0)
        vm = float(breakout.get("vol_mult") or 0)
        parts["breakout"] = min(2.0, 1.0 + (0.5 if br >= 0.55 else 0) + (0.5 if vm >= 3 else 0))
    elif breakout.get("extended"):
        parts["breakout"] = 0.5  # 已竖直，不宜再当突破加分
    else:
        parts["breakout"] = 0.0
    # 大盘 / RS
    rs = 0.0
    if btc_ok:
        rs += 1.0
    if rel_strength > 0:
        rs += min(1.0, rel_strength / 5.0)
    parts["market"] = min(2.0, rs)
    total = sum(parts.values()) + max(-1, min(1, int(oi_bonus)))
    return round(total, 2), parts


def decide_state(
    *,
    compress: bool,
    structure: dict[str, Any],
    vol_wake: float,
    breakout: dict[str, Any],
    close: float,
    prev_state: str,
    last_hl: float,
) -> str:
    if breakout.get("extended") and (prev_state in (MS_IN_POSITION, MS_READY_BREAK, MS_FIND_TOP) or breakout.get("breakout")):
        return MS_FIND_TOP
    if last_hl > 0 and close < last_hl * 0.997 and prev_state in _ACTIVE_STATES - {MS_COMPRESS}:
        return MS_INVALID
    if breakout.get("breakout") and not breakout.get("extended"):
        return MS_IN_POSITION
    if compress and structure.get("ate_lh") and vol_wake < float(MOONSHOT_VOL_BREAK):
        # 贴近上沿 / 待突破
        if close >= float(structure.get("range_high") or 0) * 0.985:
            return MS_READY_BREAK
        return MS_LH_NEAR
    if compress and structure.get("higher_low") and vol_wake < float(MOONSHOT_VOL_BREAK):
        if float(MOONSHOT_VOL_WAKE_LO) <= vol_wake < float(MOONSHOT_VOL_BREAK):
            return MS_READY_BREAK if close >= float(structure.get("range_high") or 0) * 0.99 else MS_WAIT_HL
        return MS_WAIT_HL
    if compress:
        return MS_COMPRESS
    if prev_state == MS_IN_POSITION:
        return MS_IN_POSITION
    if prev_state in _ACTIVE_STATES and not compress:
        # 离开压缩且未突破 → 可能失效
        return MS_INVALID if prev_state not in (MS_FIND_TOP,) else prev_state
    return MS_COMPRESS if compress else MS_INVALID


@dataclass
class MoonshotRow:
    symbol: str
    state: str = MS_COMPRESS
    score: float = 0.0
    reasons: list[str] = field(default_factory=list)
    range_high: float = 0.0
    last_hl: float = 0.0
    last_lh: float = 0.0
    vol_wake: float = 0.0
    compress_days: float = 0.0
    updated_at: float = 0.0
    cooldown_until: float = 0.0
    score_parts: dict[str, float] = field(default_factory=dict)
    alerted_state: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "state": self.state,
            "state_label": MS_LABELS.get(self.state, self.state),
            "score": self.score,
            "reasons": list(self.reasons),
            "range_high": self.range_high,
            "last_hl": self.last_hl,
            "last_lh": self.last_lh,
            "vol_wake": round(self.vol_wake, 2),
            "compress_days": round(self.compress_days, 1),
            "updated_at": self.updated_at,
            "cooldown_until": self.cooldown_until,
            "score_parts": dict(self.score_parts),
        }


class MoonshotStore:
    def __init__(self, db_path: Path | None = None) -> None:
        base = db_path or MOONSHOT_STATE_DB
        if base is None:
            base = Path(PATTERN_STATE_DB).resolve().parent / "moonshot_state.db"
        self.db_path = Path(base)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS moonshot_state (
                    symbol TEXT PRIMARY KEY,
                    state TEXT NOT NULL,
                    score REAL NOT NULL DEFAULT 0,
                    reasons TEXT NOT NULL DEFAULT '[]',
                    range_high REAL NOT NULL DEFAULT 0,
                    last_hl REAL NOT NULL DEFAULT 0,
                    last_lh REAL NOT NULL DEFAULT 0,
                    vol_wake REAL NOT NULL DEFAULT 0,
                    compress_days REAL NOT NULL DEFAULT 0,
                    updated_at REAL NOT NULL DEFAULT 0,
                    cooldown_until REAL NOT NULL DEFAULT 0,
                    score_parts TEXT NOT NULL DEFAULT '{}',
                    alerted_state TEXT NOT NULL DEFAULT ''
                )
                """
            )

    def load_all(self) -> dict[str, MoonshotRow]:
        out: dict[str, MoonshotRow] = {}
        with self._connect() as conn:
            for r in conn.execute("SELECT * FROM moonshot_state"):
                try:
                    reasons = json.loads(r["reasons"] or "[]")
                except Exception:
                    reasons = []
                try:
                    parts = json.loads(r["score_parts"] or "{}")
                except Exception:
                    parts = {}
                out[str(r["symbol"]).upper()] = MoonshotRow(
                    symbol=str(r["symbol"]).upper(),
                    state=str(r["state"] or MS_COMPRESS),
                    score=_f(r["score"]),
                    reasons=list(reasons) if isinstance(reasons, list) else [],
                    range_high=_f(r["range_high"]),
                    last_hl=_f(r["last_hl"]),
                    last_lh=_f(r["last_lh"]),
                    vol_wake=_f(r["vol_wake"]),
                    compress_days=_f(r["compress_days"]),
                    updated_at=_f(r["updated_at"]),
                    cooldown_until=_f(r["cooldown_until"]),
                    score_parts=dict(parts) if isinstance(parts, dict) else {},
                    alerted_state=str(r["alerted_state"] or ""),
                )
        return out

    def upsert(self, row: MoonshotRow) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO moonshot_state (
                    symbol, state, score, reasons, range_high, last_hl, last_lh,
                    vol_wake, compress_days, updated_at, cooldown_until, score_parts, alerted_state
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(symbol) DO UPDATE SET
                    state=excluded.state,
                    score=excluded.score,
                    reasons=excluded.reasons,
                    range_high=excluded.range_high,
                    last_hl=excluded.last_hl,
                    last_lh=excluded.last_lh,
                    vol_wake=excluded.vol_wake,
                    compress_days=excluded.compress_days,
                    updated_at=excluded.updated_at,
                    cooldown_until=excluded.cooldown_until,
                    score_parts=excluded.score_parts,
                    alerted_state=excluded.alerted_state
                """,
                (
                    row.symbol,
                    row.state,
                    row.score,
                    json.dumps(row.reasons, ensure_ascii=False),
                    row.range_high,
                    row.last_hl,
                    row.last_lh,
                    row.vol_wake,
                    row.compress_days,
                    row.updated_at,
                    row.cooldown_until,
                    json.dumps(row.score_parts, ensure_ascii=False),
                    row.alerted_state,
                ),
            )

    def delete(self, symbol: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM moonshot_state WHERE symbol=?", (symbol.upper(),))


def evaluate_symbol_df(
    df: pd.DataFrame,
    *,
    symbol: str,
    interval: str,
    prev: MoonshotRow | None,
    rel_strength: float = 0.0,
    btc_ok: bool = True,
    oi_bonus: int = 0,
) -> MoonshotRow | None:
    if df is None or len(df) < 50:
        return None
    work = enrich_moonshot_df(df)
    atr_r = _atr_ratio(work)
    bb_p = _bb_width_percentile(work)
    range_ok = _range_compressed(work)
    hits = 0
    reasons: list[str] = []
    if atr_r is not None and atr_r < float(MOONSHOT_ATR_RATIO):
        hits += 1
        reasons.append(f"ATR比{atr_r:.2f}")
    if bb_p is not None and bb_p <= float(MOONSHOT_BB_PCTILE):
        hits += 1
        reasons.append(f"带宽分位{bb_p:.0f}%")
    if range_ok:
        hits += 1
        reasons.append("振幅压缩")
    compress_core = hits >= 2
    days = _compress_day_span(work, interval)
    vol_ok, wake_approx = _volume_dead_or_waking(work)
    vol_wake = max(wake_approx, _vol_wake_24h(work))
    if not vol_ok and vol_wake < float(MOONSHOT_VOL_WAKE_LO):
        # 量既不死亡也不转活，弱化
        if compress_core:
            reasons.append("量能一般")
    pos_ok = _price_not_collapsed(work)
    day_ok = float(MOONSHOT_COMPRESS_DAYS_MIN) <= days <= float(MOONSHOT_COMPRESS_DAYS_MAX)
    if days > 0:
        reasons.append(f"压缩~{days:.1f}天")
    compress = compress_core and pos_ok and (day_ok or days >= float(MOONSHOT_COMPRESS_DAYS_MIN) * 0.7)
    if not compress and not (prev and prev.state in (MS_IN_POSITION, MS_FIND_TOP)):
        # 非持仓且不压缩 → 可不入池
        if prev and prev.state in _ACTIVE_STATES and time.time() < prev.cooldown_until:
            return prev
        if not compress_core:
            return None

    structure = _structure_flags(work)
    if not _bull_vol_bias(work) and vol_wake >= float(MOONSHOT_VOL_WAKE_LO):
        reasons.append("阴量偏多")
    br = _breakout_quality(work, float(structure.get("range_high") or 0))
    close = float(work.iloc[-2]["close"]) if len(work) >= 2 else float(work.iloc[-1]["close"])
    prev_state = prev.state if prev else ""
    last_hl = float(structure.get("last_hl") or (prev.last_hl if prev else 0))
    state = decide_state(
        compress=bool(compress),
        structure=structure,
        vol_wake=vol_wake,
        breakout=br,
        close=close,
        prev_state=prev_state,
        last_hl=last_hl,
    )
    total, parts = score_moonshot(
        compress_hits=hits,
        structure=structure,
        vol_wake=vol_wake,
        breakout=br,
        rel_strength=rel_strength,
        btc_ok=btc_ok,
        oi_bonus=oi_bonus,
    )
    if structure.get("higher_low"):
        reasons.append("更高低点")
    if structure.get("ate_lh"):
        reasons.append("收盘破LH")
    if br.get("breakout"):
        reasons.append(f"放量收盘突破×{br['vol_mult']:.1f}")
    if br.get("extended"):
        reasons.append("已竖直/量高潮")
    if not btc_ok:
        reasons.append("大盘偏弱")
    if rel_strength > 0:
        reasons.append(f"RS+{rel_strength:.1f}%")

    row = MoonshotRow(
        symbol=symbol.upper(),
        state=state,
        score=total,
        reasons=reasons[:8],
        range_high=float(structure.get("range_high") or 0),
        last_hl=last_hl,
        last_lh=float(structure.get("last_lh") or 0),
        vol_wake=vol_wake,
        compress_days=days,
        updated_at=time.time(),
        cooldown_until=(
            time.time() + float(MOONSHOT_COOLDOWN_DAYS) * 86400
            if state == MS_INVALID
            else (prev.cooldown_until if prev else 0.0)
        ),
        score_parts=parts,
        alerted_state=prev.alerted_state if prev else "",
    )
    return row


def filter_hunt_symbols(
    pool_rows: list[dict[str, Any]],
    *,
    hot_symbols: set[str] | None = None,
    exclude_top_n: int | None = None,
) -> list[str]:
    """猎场：中场优先；踢稳定币/过热前排/低成交额。"""
    top_n = int(exclude_top_n if exclude_top_n is not None else MOONSHOT_HOT_EXCLUDE_TOP)
    hot = {s.upper() for s in (hot_symbols or set())}
    # 按 24h 涨幅取前排排除
    ranked = sorted(
        [r for r in pool_rows if r.get("symbol")],
        key=lambda r: abs(_f(r.get("price_change_pct_24h"))),
        reverse=True,
    )
    hot_front = {str(r["symbol"]).upper() for r in ranked[: max(0, top_n)]}
    hot |= hot_front

    mid_min = float(OI_TIER_MID_MIN_USD)
    heavy_min = float(OI_TIER_HEAVY_MIN_USD)
    qmin = float(MOONSHOT_QUOTE_VOL_MIN)
    out: list[str] = []
    for r in pool_rows:
        sym = str(r.get("symbol") or "").upper()
        if not sym or is_stablecoin_symbol(sym):
            continue
        if sym in hot:
            continue
        oi = _f(r.get("current_oi_usd"))
        tier = str(r.get("oi_tier") or "")
        # mid 优先；heavy 仅非热门
        if tier == TIER_HEAVY or oi >= heavy_min:
            # 允许少量大象，但已在 hot 排除
            pass
        elif tier == TIER_MID or oi >= mid_min:
            pass
        elif oi > 0 and oi < mid_min:
            # OI 不足不否决，但要有现货量
            if _f(r.get("quote_volume")) < qmin:
                continue
        else:
            if _f(r.get("quote_volume")) < qmin:
                continue
        if qmin > 0 and _f(r.get("quote_volume")) < qmin:
            continue
        out.append(sym)
    # 稳序去重
    seen: set[str] = set()
    uniq: list[str] = []
    for s in out:
        if s not in seen:
            seen.add(s)
            uniq.append(s)
    return uniq


class MoonshotEngine:
    def __init__(self) -> None:
        self.store = MoonshotStore()
        self._rows: dict[str, MoonshotRow] = self.store.load_all()
        self._last_a_scan_ts: float = 0.0
        self._last_alerts: list[dict[str, Any]] = []
        self._a_candidates: list[str] = []

    @property
    def enabled(self) -> bool:
        return bool(MOONSHOT_ENABLED)

    def get_row(self, symbol: str) -> MoonshotRow | None:
        return self._rows.get(symbol.upper())

    def list_rows(self) -> list[MoonshotRow]:
        now = time.time()
        rows = [r for r in self._rows.values() if r.state != MS_INVALID or r.cooldown_until > now]
        rows.sort(key=lambda r: (-r.score, r.symbol))
        return rows

    def get_payload(self) -> dict[str, Any]:
        rows = self.list_rows()
        return {
            "moonshot_enabled": self.enabled,
            "moonshot_full_scan": bool(MOONSHOT_FULL_SCAN),
            "moonshot_a_interval_sec": int(MOONSHOT_A_INTERVAL_SEC),
            "moonshot_last_a_scan_ts": self._last_a_scan_ts,
            "moonshot_a_pool_size": len(self._a_candidates),
            "moonshot_score_b": float(MOONSHOT_SCORE_B),
            "moonshot_score_c": float(MOONSHOT_SCORE_C),
            "moonshot": [r.to_dict() for r in rows[: max(50, int(MOONSHOT_A_POOL_MAX))]],
            "moonshot_alerts": list(self._last_alerts[-30:]),
            "moonshot_by_symbol": {r.symbol: r.to_dict() for r in rows},
        }

    def _btc_context(self, pool_rows: list[dict[str, Any]]) -> tuple[bool, float]:
        btc = next((r for r in pool_rows if str(r.get("symbol") or "").upper() == "BTCUSDT"), None)
        chg = _f(btc.get("price_change_pct_24h")) if btc else 0.0
        # 单边暴跌：24h < -5%
        return chg > -5.0, chg

    def _rel_strength(self, row: dict[str, Any] | None, btc_chg: float) -> float:
        if not row:
            return 0.0
        return _f(row.get("price_change_pct_24h")) - btc_chg

    def _oi_bonus(self, row: dict[str, Any] | None) -> int:
        """有数据才加减分；缺失为 0。"""
        if not row:
            return 0
        # 价格横/微跌而 OI 升：+1（用 5m/15m oi 变动若存在）
        oi_pct = _f(row.get("oi_change_pct_15m") or row.get("oi_change_pct_5m"))
        px = _f(row.get("price_change_pct_24h"))
        if oi_pct > 2 and px <= 1.0:
            return 1
        if oi_pct < -5 and px > 3:
            return -1
        return 0

    def upsert_row(self, row: MoonshotRow) -> MoonshotRow:
        self._rows[row.symbol] = row
        try:
            self.store.upsert(row)
        except Exception as exc:  # noqa: BLE001
            logger.warning("moonshot 落盘失败 %s: %s", row.symbol, exc)
        return row

    def _make_alert(self, row: MoonshotRow, *, kind: str, message: str) -> dict[str, Any]:
        return {
            "type": kind,
            "symbol": row.symbol,
            "message": message,
            "state": row.state,
            "state_label": MS_LABELS.get(row.state, row.state),
            "score": row.score,
            "vol_wake": row.vol_wake,
            "range_high": row.range_high,
            "ts": time.time(),
            "dir": "long",
        }

    def _maybe_alert(self, prev: MoonshotRow | None, row: MoonshotRow) -> dict[str, Any] | None:
        if row.state == MS_INVALID:
            return None
        if row.state == MS_FIND_TOP:
            if not prev or prev.state != MS_FIND_TOP:
                return self._make_alert(
                    row,
                    kind="moonshot_find_top",
                    message=f"寻找顶部 · 分{row.score} · 停追",
                )
            return None
        if row.state == MS_IN_POSITION and row.score >= float(MOONSHOT_SCORE_C):
            if not prev or prev.state != MS_IN_POSITION:
                return self._make_alert(
                    row,
                    kind="moonshot_trigger",
                    message=f"C触发放量收盘突破 · 分{row.score}",
                )
            return None
        if row.state in _B_STATES and row.score >= float(MOONSHOT_SCORE_B):
            key = f"B:{row.state}"
            if row.alerted_state == key:
                return None
            row.alerted_state = key
            return self._make_alert(
                row,
                kind="moonshot_coil",
                message=f"B蓄势 {MS_LABELS.get(row.state)} · 分{row.score}",
            )
        return None

    async def scan_a(
        self,
        session: aiohttp.ClientSession,
        *,
        pool_rows: list[dict[str, Any]],
        hot_tickers: list[dict[str, Any]] | None = None,
        base_url: str = FAPI_BASE_URL,
        fetch_klines_batch: Callable[..., Any] | None = None,
        universe_symbols: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """A 压缩扫描（猎场或全市场符号列表）。"""
        if not self.enabled:
            return []
        from oi_mornitor.pattern_monitor import fetch_pattern_klines_batch

        fetch = fetch_klines_batch or fetch_pattern_klines_batch
        hot_syms = {
            str(t.get("symbol") or "").upper()
            for t in (hot_tickers or [])
            if t.get("symbol")
        }
        if universe_symbols is not None:
            symbols = [
                s.upper()
                for s in universe_symbols
                if s and not is_stablecoin_symbol(str(s))
            ]
        else:
            symbols = filter_hunt_symbols(pool_rows, hot_symbols=hot_syms)
        # 限制 A 扫描量，控制消耗
        symbols = symbols[: max(50, int(MOONSHOT_A_POOL_MAX) * 2)]
        self._a_candidates = symbols
        if not symbols:
            self._last_a_scan_ts = time.time()
            return []

        logger.info(
            "moonshot A 扫描 %d 币 interval=%s full=%s",
            len(symbols),
            MOONSHOT_KLINE_INTERVAL,
            bool(MOONSHOT_FULL_SCAN) and universe_symbols is not None,
        )
        # 错峰：调用方已 sleep；此处再限并发
        kmap = await fetch(
            session,
            base_url=base_url,
            symbols=symbols,
            interval=str(MOONSHOT_KLINE_INTERVAL),
            limit=int(MOONSHOT_KLINE_LIMIT),
        )
        btc_ok, btc_chg = self._btc_context(pool_rows)
        by_sym = {str(r.get("symbol") or "").upper(): r for r in pool_rows}
        alerts: list[dict[str, Any]] = []
        kept = 0
        for sym in symbols:
            raw = kmap.get(sym) or []
            # 新币：K 线不足 → 踢（≈上所不久）
            if len(raw) < max(48, int(MOONSHOT_KLINE_LIMIT) // 3):
                continue
            try:
                df = klines_to_df(raw)
            except Exception:
                continue
            prev = self._rows.get(sym)
            if prev and prev.state == MS_INVALID and time.time() < prev.cooldown_until:
                continue
            prow = by_sym.get(sym)
            row = evaluate_symbol_df(
                df,
                symbol=sym,
                interval=str(MOONSHOT_KLINE_INTERVAL),
                prev=prev,
                rel_strength=self._rel_strength(prow, btc_chg),
                btc_ok=btc_ok,
                oi_bonus=self._oi_bonus(prow),
            )
            if row is None:
                continue
            # A 池只保留压缩相关或持仓/寻顶
            if row.state == MS_INVALID and (not prev or prev.state != MS_INVALID):
                self.upsert_row(row)
                continue
            if row.state not in _ACTIVE_STATES:
                continue
            kept += 1
            al = self._maybe_alert(prev, row)
            self.upsert_row(row)
            if al:
                alerts.append(al)
        # 裁剪过大池：按分保留 A_POOL_MAX
        ranked = self.list_rows()
        if len(ranked) > int(MOONSHOT_A_POOL_MAX):
            keep_set = {r.symbol for r in ranked[: int(MOONSHOT_A_POOL_MAX)]}
            # 持仓/寻顶保护
            for r in ranked:
                if r.state in (MS_IN_POSITION, MS_FIND_TOP, MS_READY_BREAK):
                    keep_set.add(r.symbol)
            for sym in list(self._rows.keys()):
                if sym not in keep_set:
                    self._rows.pop(sym, None)
                    try:
                        self.store.delete(sym)
                    except Exception:
                        pass
        self._last_a_scan_ts = time.time()
        if alerts:
            self._last_alerts = (self._last_alerts + alerts)[-40:]
        logger.info("moonshot A 完成：候选入池=%d 警报=%d", kept, len(alerts))
        return alerts

    def update_from_15m(
        self,
        klines_map: dict[str, list[list[Any]]],
        *,
        pool_rows: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        """对已监听/已在 moonshot 池的币，用 15m 轻量刷新 B/C（复用形态 K）。"""
        if not self.enabled:
            return []
        pool_rows = pool_rows or []
        btc_ok, btc_chg = self._btc_context(pool_rows)
        by_sym = {str(r.get("symbol") or "").upper(): r for r in pool_rows}
        alerts: list[dict[str, Any]] = []
        # 只更新已在 moonshot 表，或 klines_map ∩ 高分 A
        targets = set(self._rows.keys()) | set(klines_map.keys())
        for sym in list(targets):
            raw = klines_map.get(sym)
            if not raw or len(raw) < 50:
                continue
            prev = self._rows.get(sym)
            # 冷却中的失效跳过
            if prev and prev.state == MS_INVALID and time.time() < prev.cooldown_until:
                continue
            try:
                df = klines_to_df(raw)
            except Exception:
                continue
            prow = by_sym.get(sym)
            row = evaluate_symbol_df(
                df,
                symbol=sym,
                interval="15m",
                prev=prev,
                rel_strength=self._rel_strength(prow, btc_chg),
                btc_ok=btc_ok,
                oi_bonus=self._oi_bonus(prow),
            )
            if row is None:
                continue
            al = self._maybe_alert(prev, row)
            self.upsert_row(row)
            if al:
                alerts.append(al)
        if alerts:
            self._last_alerts = (self._last_alerts + alerts)[-40:]
        return alerts

    def top_for_watchlist(self, limit: int = 50) -> list[str]:
        """按分选出应占监听槽的币（不含失效）。"""
        rows = [
            r
            for r in self.list_rows()
            if r.state in _ACTIVE_STATES and r.score >= float(MOONSHOT_SCORE_B) * 0.5
        ]
        return [r.symbol for r in rows[:limit]]

    def b_candidates_for_sandbox(self) -> list[MoonshotRow]:
        return [
            r
            for r in self.list_rows()
            if r.state in _B_STATES and r.score >= float(MOONSHOT_SCORE_B)
        ]

    def c_triggers(self) -> list[MoonshotRow]:
        return [
            r
            for r in self.list_rows()
            if r.state == MS_IN_POSITION and r.score >= float(MOONSHOT_SCORE_C)
        ]


async def run_moonshot_a_loop(
    is_running: Callable[[], bool],
    *,
    get_session: Callable[[], Any],
    get_pool_rows: Callable[[], list[dict[str, Any]]],
    get_hot: Callable[[], list[dict[str, Any]]],
    engine: MoonshotEngine,
    get_full_universe: Callable[[], Any] | None = None,
    on_alerts: Callable[[list[dict[str, Any]]], Any] | None = None,
) -> None:
    """独立慢环：默认 2h；与主雷达错峰。"""
    await asyncio.sleep(45)  # 错开 taker_flow 启动尖峰
    while is_running():
        if not engine.enabled:
            await asyncio.sleep(30)
            continue
        try:
            session = get_session()
            if session is None:
                await asyncio.sleep(20)
                continue
            pool = get_pool_rows() or []
            hot = get_hot() or []
            universe = None
            if MOONSHOT_FULL_SCAN and get_full_universe is not None:
                try:
                    universe = await get_full_universe()
                except Exception as exc:  # noqa: BLE001
                    logger.warning("moonshot 全市场枚举失败，回退猎场: %s", exc)
                    universe = None
            alerts = await engine.scan_a(
                session,
                pool_rows=pool,
                hot_tickers=hot,
                universe_symbols=universe,
            )
            if alerts and on_alerts:
                try:
                    on_alerts(alerts)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("moonshot on_alerts: %s", exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("moonshot A 环异常: %s", exc)
        # 间隔
        await asyncio.sleep(max(300.0, float(MOONSHOT_A_INTERVAL_SEC)))
