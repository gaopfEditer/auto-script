"""三路对比回测：A_pure_oi / B_oi_pattern / C_kol_pattern。

进出场与 structure_backtest 对齐：next_bar_open + 滑点/手续费 + settle_signal_by_5m_bars。
A/B 需要可验证 OI 历史事件；缺重叠数据时标记 blocked，不伪造胜率。
"""
from __future__ import annotations

import json
import logging
import re
import sqlite3
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from oi_mornitor.backtest_kline_store import BacktestKlineStore
from oi_mornitor.backtest_metrics import summarize_backtest_extended
from oi_mornitor.backtest_trade_config import OI_BT_FEE_PCT, OI_BT_SLIPPAGE_PCT
from oi_mornitor.config import (
    BACKTEST_KLINES_DIR,
    OI_ENTRY_PATTERN_TIMEOUT_BARS,
    OI_ENTRY_PATTERNS,
)
from oi_mornitor.env_parse import env_float, env_int, env_str
from oi_mornitor.mcap_tier import resolve_mcap_tier
from oi_mornitor.oi_entry_filter import (
    CONSENSUS_SIDE,
    apply_entry_filter,
    bars_from_ohlcv_rows,
    find_pattern_confirmation,
    scan_patterns_on_bar,
)
from oi_mornitor.pattern_entry import resolve_backtest_entry_price
from oi_mornitor.pattern_settle import settle_signal_by_5m_bars
from oi_mornitor.pattern_settle_profile import build_settle_plan, resolve_verify_delay_ms
from oi_mornitor.symbol_aliases import normalize_usdt_symbol

logger = logging.getLogger(__name__)

_PKG = Path(__file__).resolve().parent
_DATA = _PKG / "data"
_DEFAULT_OI_EVENTS = _DATA / "oi_events.jsonl"
_INTERVAL_MS = {"5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000}

# 临时资深 KOL allowlist（Discord 高产频道 + telegram/channel_profiles.json send + Ashley）
TEMP_DISCORD_CHANNEL_IDS: tuple[str, ...] = (
    "1444962439471955989",  # 三马哥合约
    "1444963506431463474",  # 山寨之王
    "1444963405185159238",  # 币圈所长
    "1444962376066793513",  # 舒琴行情分析
    "1444963929393729686",  # 比特币峰哥
    "1444963474718462085",  # 比特币军长
    "1444962339743989843",  # 大镖客
    "1444963372134301827",  # seven
    "1444963689194192947",  # 颜驰-vip
)
TEMP_TELEGRAM_CHAT_IDS: tuple[str, ...] = (
    "-1004346465376",  # twitter先行消息
    "-1001720924085",  # Leo
    "-1003962150986",  # 熊猫说交易
    "-1001908181865",  # Aura
    "-1002404948215",  # Fly
    "-1001766481463",  # 砸锅卖铁去炒币
    "-1002355647897",  # KAI
    "-1003938902957",  # Nine Call
    "-1002666021235",  # Ashley（档案有，未必在 send）
)

KOL_PATTERN_TF = env_str("KOL_PATTERN_TF", "15m").lower()
KOL_PATTERN_LOOKAHEAD_BARS = env_int("KOL_PATTERN_LOOKAHEAD_BARS", 24, min_val=1, max_val=200)
KOL_PATTERNS = env_str("KOL_PATTERNS", "inverted_hammer,engulfing,shooting_star")
KOL_MYSQL_DSN = env_str(
    "KOL_MYSQL_DSN",
    "mysql+pymysql://root:123456@127.0.0.1/discord_collector",
)
# 简化：脚本内直接用 mysql connector 参数
KOL_MYSQL_HOST = env_str("KOL_MYSQL_HOST", "127.0.0.1")
KOL_MYSQL_USER = env_str("KOL_MYSQL_USER", "root")
KOL_MYSQL_PASSWORD = env_str("KOL_MYSQL_PASSWORD", "123456")
KOL_MYSQL_DB = env_str("KOL_MYSQL_DB", "discord_collector")

# K 线覆盖盘点上界（UTC）
KLINE_COVERAGE_END_MS = int(
    datetime(2026, 8, 15, 13, 15, tzinfo=timezone.utc).timestamp() * 1000
)


@dataclass
class ArmResult:
    scenario: str
    status: str  # ok | blocked | empty
    blocked_reason: str | None = None
    signals: int = 0
    settled: int = 0
    win_rate: float | None = None
    expectancy_pct: float | None = None
    expectancy_r: float | None = None
    summary: dict[str, Any] = field(default_factory=dict)
    items: list[dict[str, Any]] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def public_row(self) -> dict[str, Any]:
        return {
            "scenario": self.scenario,
            "status": self.status,
            "blocked_reason": self.blocked_reason,
            "signals": self.signals,
            "settled": self.settled,
            "win_rate": self.win_rate,
            "expectancy_pct": self.expectancy_pct,
            "expectancy_r": self.expectancy_r,
            "meta": self.meta,
            "summary": {
                k: self.summary.get(k)
                for k in (
                    "wins",
                    "losses",
                    "winRate",
                    "avgPnlPct",
                    "expectancyR",
                    "profitFactor",
                    "maxDrawdownPct",
                )
                if k in self.summary
            },
        }


def _parse_patterns(raw: str) -> frozenset[str]:
    parts = [p.strip() for p in (raw or "").split(",") if p.strip()]
    return frozenset(parts)


def _ms_to_iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def discover_oi_history(*, data_dir: Path | None = None) -> dict[str, Any]:
    """搜索规范 OI 历史；尝试从 supervisor 日志抽事件并评估与 K 线对齐。"""
    root = data_dir or _DATA
    pkg = _PKG
    found_files: list[str] = []
    for pat in ("*oi*event*", "*oi*hist*", "*open*interest*", "oi_*.parquet", "oi_*.sqlite", "oi_*.db"):
        for p in list(root.glob(pat)) + list(pkg.glob(pat)):
            if p.is_file():
                found_files.append(str(p))

    events_path = _DEFAULT_OI_EVENTS
    structured_events = 0
    if events_path.is_file():
        with events_path.open() as f:
            for line in f:
                if line.strip():
                    structured_events += 1
        found_files.append(str(events_path))

    log_paths = sorted(root.glob("oi-supervisor.log*"))
    log_events = _parse_oi_supervisor_alerts(log_paths)
    log_ts = [e["ts_ms"] for e in log_events]
    log_min = min(log_ts) if log_ts else None
    log_max = max(log_ts) if log_ts else None

    kline_end = _kline_coverage_end_ms()
    overlap = False
    if log_min is not None and kline_end is not None:
        overlap = log_min <= kline_end

    usable = structured_events > 0 and _events_file_has_required_fields(events_path)
    # 仅有日志告警行不够：缺 oi/delta/price，且与 K 线无重叠
    blocked_reason = None
    if usable:
        status = "ready"
    else:
        status = "blocked"
        parts = []
        if structured_events <= 0:
            parts.append("无规范 oi_events.jsonl（需 ts_ms,symbol,oi_up/pct_oi,price）")
        if log_events:
            parts.append(
                f"supervisor 日志可解析告警 {len(log_events)} 条"
                f"（{_ms_to_iso(log_min)}～{_ms_to_iso(log_max)}），"
                "但缺 oi/delta/pct/price 字段，不可作 A/B ground truth"
            )
        else:
            parts.append("supervisor 日志未解析出可复现 OI 异动事件")
        if kline_end is not None and log_min is not None and not overlap:
            parts.append(
                f"与 K 线无重叠（K 线止于 {_ms_to_iso(kline_end)}，OI 日志自 {_ms_to_iso(log_min)}）"
            )
        blocked_reason = "；".join(parts)

    return {
        "status": status,
        "blocked_reason": blocked_reason,
        "found_files": found_files,
        "structured_events": structured_events,
        "log_alert_events": len(log_events),
        "log_range": {
            "min": _ms_to_iso(log_min) if log_min else None,
            "max": _ms_to_iso(log_max) if log_max else None,
        },
        "kline_coverage_end": _ms_to_iso(kline_end) if kline_end else None,
        "oi_kline_overlap": overlap,
        "sample_log_events": log_events[:5],
    }


def _kline_coverage_end_ms() -> int | None:
    meta = Path(BACKTEST_KLINES_DIR) / "meta.db"
    if not meta.is_file():
        return KLINE_COVERAGE_END_MS
    try:
        with sqlite3.connect(str(meta)) as conn:
            row = conn.execute("SELECT MAX(max_open_time) FROM coverage").fetchone()
        return int(row[0]) if row and row[0] else KLINE_COVERAGE_END_MS
    except sqlite3.Error:
        return KLINE_COVERAGE_END_MS


def _events_file_has_required_fields(path: Path) -> bool:
    if not path.is_file():
        return False
    need = {"ts_ms", "symbol"}
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                return False
            if not need.issubset(obj):
                return False
            if "oi_up" not in obj and "pct_oi" not in obj:
                return False
            return True
    return False


def _parse_oi_supervisor_alerts(paths: Sequence[Path]) -> list[dict[str, Any]]:
    """从日志抽「OI异动/OI放大 → 形态追踪」行；仅含 ts+symbol，缺数值字段。"""
    pat = re.compile(
        r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*?"
        r"(?:OI异动|OI放大).*?：\s*(.+)$"
    )
    out: list[dict[str, Any]] = []
    seen: set[tuple[int, str]] = set()
    for path in paths:
        if not path.is_file():
            continue
        # 跳过超大 live-inode / gzip，避免拖垮；只读明文 log / log.N
        name = path.name
        if name.endswith(".gz") or "live-inode" in name or "archive" in name:
            continue
        try:
            with path.open("r", errors="ignore") as f:
                for line in f:
                    m = pat.match(line.strip())
                    if not m:
                        continue
                    ts_s, rest = m.group(1), m.group(2)
                    try:
                        dt = datetime.strptime(ts_s, "%Y-%m-%d %H:%M:%S").replace(
                            tzinfo=timezone.utc
                        )
                        # 日志为本地 Asia/Shanghai（UTC+8）
                        dt = datetime.strptime(ts_s, "%Y-%m-%d %H:%M:%S")
                        # box/Mac 日志按本地墙钟 → 当作 Asia/Shanghai
                        from zoneinfo import ZoneInfo

                        dt = dt.replace(tzinfo=ZoneInfo("Asia/Shanghai"))
                        ts_ms = int(dt.timestamp() * 1000)
                    except ValueError:
                        continue
                    for sym in re.findall(r"[A-Z0-9]+USDT", rest.upper()):
                        key = (ts_ms, sym)
                        if key in seen:
                            continue
                        seen.add(key)
                        out.append(
                            {
                                "ts_ms": ts_ms,
                                "symbol": sym,
                                "source": "supervisor_log_alert",
                                "incomplete": True,
                                "note": "缺 oi/delta/pct/price",
                            }
                        )
        except OSError as exc:
            logger.warning("读日志失败 %s: %s", path, exc)
    out.sort(key=lambda e: e["ts_ms"])
    return out


def load_oi_events(path: Path | None = None) -> list[dict[str, Any]]:
    p = path or _DEFAULT_OI_EVENTS
    if not p.is_file():
        return []
    rows: list[dict[str, Any]] = []
    with p.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            sym = normalize_usdt_symbol(str(obj.get("symbol") or ""))
            if not sym:
                continue
            try:
                ts_ms = int(obj["ts_ms"])
            except (KeyError, TypeError, ValueError):
                continue
            oi_up = obj.get("oi_up")
            if oi_up is None and obj.get("pct_oi") is not None:
                try:
                    oi_up = float(obj["pct_oi"]) > 0
                except (TypeError, ValueError):
                    oi_up = True
            rows.append(
                {
                    "ts_ms": ts_ms,
                    "symbol": sym,
                    "oi_up": bool(oi_up) if oi_up is not None else True,
                    "pct_oi": obj.get("pct_oi"),
                    "pct_price_5m": float(obj.get("pct_price_5m") or 0.0),
                    "pct_price_15m": float(obj.get("pct_price_15m") or 0.0),
                    "price": obj.get("price"),
                }
            )
    return rows


def load_temp_kol_allowlist() -> dict[str, Any]:
    ids = list(TEMP_DISCORD_CHANNEL_IDS) + list(TEMP_TELEGRAM_CHAT_IDS)
    # 合并 channel_profiles.json send（若存在）
    profiles = (
        _PKG.parent.parent / "telegram" / "channel_profiles.json"
    )
    # discord-collector/../telegram → auto-script/telegram
    alt = _PKG.parent.parent / "telegram" / "channel_profiles.json"
    # oi_mornitor -> discord-collector -> auto-script
    auto_script = _PKG.parent.parent
    profiles = auto_script / "telegram" / "channel_profiles.json"
    send_ids: list[str] = []
    if profiles.is_file():
        try:
            data = json.loads(profiles.read_text())
            send_ids = [str(x) for x in (data.get("send") or [])]
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("读 channel_profiles 失败: %s", exc)
    for sid in send_ids:
        if sid not in ids:
            ids.append(sid)
    return {
        "temporary": True,
        "note": "临时名单：Discord 高产频道 + telegram channel_profiles.send（+Ashley）；非最终资深 KOL",
        "channel_ids": ids,
        "discord_high_yield": list(TEMP_DISCORD_CHANNEL_IDS),
        "telegram_send": send_ids or list(TEMP_TELEGRAM_CHAT_IDS),
        "profiles_path": str(profiles) if profiles.is_file() else None,
    }


def load_kol_mentions(
    *,
    allowlist: Sequence[str],
    start_ms: int | None = None,
    end_ms: int | None = None,
) -> list[dict[str, Any]]:
    """从 MySQL discord_signal_cards 拉 mention 事件。"""
    try:
        import pymysql
    except ImportError:
        # fallback mysql.connector / subprocess
        return _load_kol_mentions_via_cli(allowlist, start_ms=start_ms, end_ms=end_ms)

    end_ms = end_ms if end_ms is not None else _kline_coverage_end_ms() or KLINE_COVERAGE_END_MS
    start_iso = (
        datetime.fromtimestamp((start_ms or 0) / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M:%S"
        )
        if start_ms
        else "2026-05-01"
    )
    end_iso = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    placeholders = ",".join(["%s"] * len(allowlist))
    sql = f"""
        SELECT id, channel_id, symbol, source_type,
               COALESCE(signal_at, created_at) AS event_at
        FROM discord_signal_cards
        WHERE symbol IS NOT NULL AND symbol <> ''
          AND channel_id IN ({placeholders})
          AND COALESCE(signal_at, created_at) >= %s
          AND COALESCE(signal_at, created_at) < %s
        ORDER BY COALESCE(signal_at, created_at) ASC
    """
    conn = pymysql.connect(
        host=KOL_MYSQL_HOST,
        user=KOL_MYSQL_USER,
        password=KOL_MYSQL_PASSWORD,
        database=KOL_MYSQL_DB,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(sql, list(allowlist) + [start_iso, end_iso])
            rows = cur.fetchall()
    finally:
        conn.close()

    out: list[dict[str, Any]] = []
    for r in rows:
        sym = normalize_usdt_symbol(str(r["symbol"]))
        if not sym:
            continue
        event_at = r["event_at"]
        if hasattr(event_at, "timestamp"):
            # MySQL datetime 无 tz → 按 UTC 墙钟（库内多为 UTC 存）
            ts_ms = int(event_at.replace(tzinfo=timezone.utc).timestamp() * 1000)
        else:
            continue
        out.append(
            {
                "ts_ms": ts_ms,
                "symbol": sym,
                "channel_id": str(r["channel_id"]),
                "source_type": str(r.get("source_type") or ""),
                "card_id": r.get("id"),
            }
        )
    return out


def _load_kol_mentions_via_cli(
    allowlist: Sequence[str],
    *,
    start_ms: int | None,
    end_ms: int | None,
) -> list[dict[str, Any]]:
    import subprocess

    end_ms = end_ms if end_ms is not None else _kline_coverage_end_ms() or KLINE_COVERAGE_END_MS
    end_iso = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    start_iso = (
        datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        if start_ms
        else "2026-05-01"
    )
    ids = ",".join("'" + x.replace("'", "") + "'" for x in allowlist)
    sql = (
        "SELECT id, channel_id, symbol, source_type, "
        "UNIX_TIMESTAMP(COALESCE(signal_at, created_at))*1000 AS ts_ms "
        "FROM discord_signal_cards "
        f"WHERE symbol IS NOT NULL AND symbol<>'' AND channel_id IN ({ids}) "
        f"AND COALESCE(signal_at, created_at) >= '{start_iso}' "
        f"AND COALESCE(signal_at, created_at) < '{end_iso}' "
        "ORDER BY COALESCE(signal_at, created_at)"
    )
    cmd = [
        "mysql",
        "-uroot",
        f"-p{KOL_MYSQL_PASSWORD}",
        f"-h{KOL_MYSQL_HOST}",
        KOL_MYSQL_DB,
        "-N",
        "-B",
        "-e",
        sql,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        logger.error("mysql cli failed: %s", proc.stderr[:500])
        return []
    out: list[dict[str, Any]] = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        sym = normalize_usdt_symbol(parts[2])
        if not sym:
            continue
        try:
            ts_ms = int(float(parts[4]))
        except ValueError:
            continue
        out.append(
            {
                "ts_ms": ts_ms,
                "symbol": sym,
                "channel_id": parts[1],
                "source_type": parts[3],
                "card_id": parts[0],
            }
        )
    return out


def _bars_dicts_from_store(
    store: BacktestKlineStore,
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
) -> list[dict[str, Any]]:
    rows = store.load_rows(symbol, interval, start_ms, end_ms)
    return bars_from_ohlcv_rows(rows)


def _find_bar_index(bars: Sequence[MappingLike], ts_ms: int) -> int | None:
    if not bars:
        return None
    # 信号时刻所在已收盘柱：open_time <= ts_ms 的最后一根
    best = None
    for i, b in enumerate(bars):
        ot = int(b.get("open_time") or b.get("ts") or 0)
        if ot <= ts_ms:
            best = i
        else:
            break
    return best


# typing alias without importing Mapping everywhere for py3
MappingLike = dict[str, Any]


def _settle_one(
    *,
    store: BacktestKlineStore,
    symbol: str,
    interval: str,
    side: str,
    signal_bar: dict[str, Any],
    next_bar_open: float | None,
    signal_at_ms: int,
    kind: str,
    type_label: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    side_norm = "short" if side in ("short", "bear") else "long"
    entry = resolve_backtest_entry_price(
        side=side_norm,
        signal_bar_close=float(signal_bar["close"]),
        next_bar_open=next_bar_open,
    )
    settle_stub: dict[str, Any] = {
        "side": side_norm,
        "entry": entry,
        "tradeSymbol": symbol,
        "symbol": symbol,
        "signalAt": signal_at_ms,
        "interval": interval,
        "typeLabel": type_label,
        "mcapTier": resolve_mcap_tier(symbol),
    }
    try:
        plan = build_settle_plan(settle_stub)
    except ValueError:
        plan = None
    verify_ms = resolve_verify_delay_ms(settle_stub)
    settle_end = signal_at_ms + verify_ms + 5 * 60_000
    bars_settle = store.load_5m_bars(symbol, signal_at_ms, settle_end)
    settled = settle_signal_by_5m_bars(
        side=side_norm,
        entry=entry,
        symbol=symbol,
        signal_at_ms=signal_at_ms,
        bars_5m=bars_settle,
        now_ms=settle_end,
        alert_rec=settle_stub,
        fee_pct_per_side=OI_BT_FEE_PCT,
        slippage_pct_per_side=OI_BT_SLIPPAGE_PCT,
        plan=plan,
    )
    row: dict[str, Any] = {
        "symbol": symbol,
        "interval": interval,
        "kind": kind,
        "typeLabel": type_label,
        "side": side_norm,
        "signalAt": signal_at_ms,
        "entry": entry,
        "mcapTier": settle_stub.get("mcapTier"),
        "outcome": settled.get("outcome"),
        "movePct": settled.get("movePct"),
        "netMovePct": settled.get("netMovePct"),
        "pnlPct": settled.get("pnlPct"),
        "exitPrice": settled.get("exitPrice"),
        "slPrice": settled.get("slPrice") or (plan.sl_price if plan else None),
        "tp1Price": settled.get("tp1Price") or (plan.tp1_price if plan else None),
        "error": settled.get("error"),
    }
    if extra:
        row.update(extra)
    return row


def run_arm_a_pure_oi(
    store: BacktestKlineStore,
    events: list[dict[str, Any]],
    *,
    interval: str = "15m",
) -> ArmResult:
    """A：OI 异动即入场（用共识方向；无共识则按 oi_up 多/空）。"""
    items: list[dict[str, Any]] = []
    iv_ms = _INTERVAL_MS.get(interval, 900_000)
    by_sym: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e in events:
        by_sym[e["symbol"]].append(e)

    for sym, evs in by_sym.items():
        if not evs:
            continue
        t0 = min(e["ts_ms"] for e in evs) - 50 * iv_ms
        t1 = max(e["ts_ms"] for e in evs) + 10 * iv_ms
        bars = _bars_dicts_from_store(store, sym, interval, t0, t1)
        if len(bars) < 5:
            continue
        for e in evs:
            idx = _find_bar_index(bars, e["ts_ms"])
            if idx is None or idx + 1 >= len(bars):
                continue
            preferred = CONSENSUS_SIDE.get(
                apply_entry_filter(
                    oi_up=bool(e.get("oi_up", True)),
                    pct_price_5m=float(e.get("pct_price_5m") or 0.0),
                    pct_price_15m=float(e.get("pct_price_15m") or 0.0),
                    run_l3=False,
                ).consensus
            )
            side = preferred or ("long" if e.get("oi_up", True) else "short")
            if not preferred:
                # flat/unknown → 仍按 oi 方向进（纯 OI 臂）
                side = "long" if e.get("oi_up", True) else "short"
            bar = bars[idx]
            next_open = float(bars[idx + 1]["open"])
            signal_at = int(bar.get("close_time") or (bar["open_time"] + iv_ms - 1))
            items.append(
                _settle_one(
                    store=store,
                    symbol=sym,
                    interval=interval,
                    side=side,
                    signal_bar=bar,
                    next_bar_open=next_open,
                    signal_at_ms=signal_at,
                    kind="pure_oi",
                    type_label="A_pure_oi",
                    extra={"scenario": "A_pure_oi", "oi_ts": e["ts_ms"]},
                )
            )
    return _arm_from_items("A_pure_oi", items, meta={"interval": interval, "events": len(events)})


def run_arm_b_oi_pattern(
    store: BacktestKlineStore,
    events: list[dict[str, Any]],
    *,
    interval: str = "15m",
    timeout_bars: int | None = None,
) -> ArmResult:
    """B：OI 后等待 §10 L3 形态。"""
    allow = _parse_patterns(OI_ENTRY_PATTERNS)
    tmax = OI_ENTRY_PATTERN_TIMEOUT_BARS if timeout_bars is None else int(timeout_bars)
    items: list[dict[str, Any]] = []
    expired = 0
    filtered = 0
    iv_ms = _INTERVAL_MS.get(interval, 900_000)
    by_sym: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e in events:
        by_sym[e["symbol"]].append(e)

    for sym, evs in by_sym.items():
        t0 = min(e["ts_ms"] for e in evs) - 50 * iv_ms
        t1 = max(e["ts_ms"] for e in evs) + (tmax + 5) * iv_ms
        bars = _bars_dicts_from_store(store, sym, interval, t0, t1)
        if len(bars) < 5:
            continue
        for e in evs:
            idx = _find_bar_index(bars, e["ts_ms"])
            if idx is None:
                continue
            filt = apply_entry_filter(
                oi_up=bool(e.get("oi_up", True)),
                pct_price_5m=float(e.get("pct_price_5m") or 0.0),
                pct_price_15m=float(e.get("pct_price_15m") or 0.0),
                bars=bars,
                signal_bar_index=idx,
                timeout_bars=tmax,
                run_l3=True,
            )
            if filt.entry_status == "filtered_divergence":
                filtered += 1
                continue
            if filt.entry_status != "entry_ready" or filt.entry_bar_index is None:
                expired += 1
                continue
            ei = filt.entry_bar_index
            if ei + 1 >= len(bars):
                continue
            bar = bars[ei]
            next_open = float(bars[ei + 1]["open"])
            signal_at = int(bar.get("close_time") or (bar["open_time"] + iv_ms - 1))
            items.append(
                _settle_one(
                    store=store,
                    symbol=sym,
                    interval=interval,
                    side=str(filt.entry_side or filt.preferred_side or "long"),
                    signal_bar=bar,
                    next_bar_open=next_open,
                    signal_at_ms=signal_at,
                    kind=str(filt.entry_pattern or "pattern"),
                    type_label="B_oi_pattern",
                    extra={
                        "scenario": "B_oi_pattern",
                        "oi_ts": e["ts_ms"],
                        "consensus": filt.consensus,
                        "patterns_allow": sorted(allow),
                    },
                )
            )
    return _arm_from_items(
        "B_oi_pattern",
        items,
        meta={
            "interval": interval,
            "events": len(events),
            "expired": expired,
            "filtered_divergence": filtered,
            "patterns": sorted(allow),
            "timeout_bars": tmax,
        },
    )


def run_arm_c_kol_pattern(
    store: BacktestKlineStore,
    mentions: list[dict[str, Any]],
    *,
    interval: str | None = None,
    lookahead_bars: int | None = None,
    patterns: str | None = None,
) -> ArmResult:
    """C：KOL mention 后前瞻窗口内 hammer/engulfing。"""
    iv = (interval or KOL_PATTERN_TF).lower()
    look = KOL_PATTERN_LOOKAHEAD_BARS if lookahead_bars is None else int(lookahead_bars)
    allow = _parse_patterns(patterns or KOL_PATTERNS)
    items: list[dict[str, Any]] = []
    expired = 0
    no_bars = 0
    iv_ms = _INTERVAL_MS.get(iv, 900_000)
    by_sym: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for m in mentions:
        by_sym[m["symbol"]].append(m)

    for sym, mens in by_sym.items():
        t0 = min(m["ts_ms"] for m in mens) - 30 * iv_ms
        t1 = max(m["ts_ms"] for m in mens) + (look + 5) * iv_ms
        bars = _bars_dicts_from_store(store, sym, iv, t0, t1)
        if len(bars) < 3:
            no_bars += len(mens)
            continue
        last_entry_idx = -10_000
        for m in mens:
            idx = _find_bar_index(bars, m["ts_ms"])
            if idx is None:
                expired += 1
                continue
            # 去重：同币过近不重复进
            if idx - last_entry_idx < 4:
                continue
            hit = find_pattern_confirmation(
                bars,
                signal_bar_index=idx,
                preferred_side=None,
                timeout_bars=look,
                allowed=allow,
            )
            if not hit:
                expired += 1
                continue
            ei = int(hit["bar_index"])
            if ei + 1 >= len(bars):
                expired += 1
                continue
            bar = bars[ei]
            next_open = float(bars[ei + 1]["open"])
            signal_at = int(bar.get("close_time") or (bar["open_time"] + iv_ms - 1))
            items.append(
                _settle_one(
                    store=store,
                    symbol=sym,
                    interval=iv,
                    side=str(hit.get("side") or "long"),
                    signal_bar=bar,
                    next_bar_open=next_open,
                    signal_at_ms=signal_at,
                    kind=str(hit.get("kind") or "kol_pattern"),
                    type_label="C_kol_pattern",
                    extra={
                        "scenario": "C_kol_pattern",
                        "mention_ts": m["ts_ms"],
                        "channel_id": m.get("channel_id"),
                        "allowlist": "temporary",
                    },
                )
            )
            last_entry_idx = ei

    return _arm_from_items(
        "C_kol_pattern",
        items,
        meta={
            "interval": iv,
            "mentions": len(mentions),
            "expired": expired,
            "no_bars": no_bars,
            "patterns": sorted(allow),
            "lookahead_bars": look,
            "allowlist": "temporary",
        },
    )


def _arm_from_items(
    scenario: str,
    items: list[dict[str, Any]],
    *,
    meta: dict[str, Any] | None = None,
) -> ArmResult:
    if not items:
        return ArmResult(
            scenario=scenario,
            status="empty",
            signals=0,
            meta=meta or {},
        )
    summary = summarize_backtest_extended(items)
    settled = [
        it
        for it in items
        if str(it.get("outcome") or "") in ("take_profit", "stop_loss")
    ]
    pnls = []
    for it in settled:
        try:
            pnls.append(float(it.get("pnlPct") or 0))
        except (TypeError, ValueError):
            pass
    exp = sum(pnls) / len(pnls) if pnls else None
    wr = summary.get("winRate")
    return ArmResult(
        scenario=scenario,
        status="ok",
        signals=len(items),
        settled=len(settled),
        win_rate=float(wr) if wr is not None else None,
        expectancy_pct=round(exp, 4) if exp is not None else None,
        expectancy_r=summary.get("expectancyR"),
        summary=summary,
        items=items,
        meta=meta or {},
    )


def run_three_way(
    *,
    oi_events_path: Path | None = None,
    skip_c: bool = False,
    max_mentions: int | None = None,
) -> dict[str, Any]:
    """一键跑三路；A/B 无数据则 blocked。"""
    t0 = time.time()
    store = BacktestKlineStore()
    oi_disc = discover_oi_history()
    allow = load_temp_kol_allowlist()
    kline_end = _kline_coverage_end_ms() or KLINE_COVERAGE_END_MS

    arms: dict[str, ArmResult] = {}

    # A / B
    if oi_disc["status"] != "ready":
        reason = oi_disc.get("blocked_reason") or "OI 历史不可用"
        for name in ("A_pure_oi", "B_oi_pattern"):
            arms[name] = ArmResult(
                scenario=name,
                status="blocked",
                blocked_reason=reason,
                meta={"oi_discovery": oi_disc},
            )
    else:
        events = load_oi_events(oi_events_path)
        # 只保留与 K 线重叠
        events = [e for e in events if e["ts_ms"] <= kline_end]
        if not events:
            reason = "oi_events 与 K 线无重叠区间"
            for name in ("A_pure_oi", "B_oi_pattern"):
                arms[name] = ArmResult(
                    scenario=name,
                    status="blocked",
                    blocked_reason=reason,
                    meta={"oi_discovery": oi_disc},
                )
        else:
            arms["A_pure_oi"] = run_arm_a_pure_oi(store, events)
            arms["B_oi_pattern"] = run_arm_b_oi_pattern(store, events)

    # C
    if skip_c:
        arms["C_kol_pattern"] = ArmResult(
            scenario="C_kol_pattern",
            status="blocked",
            blocked_reason="skip_c",
        )
    else:
        mentions = load_kol_mentions(
            allowlist=allow["channel_ids"],
            end_ms=kline_end,
        )
        if max_mentions is not None:
            mentions = mentions[: max(0, int(max_mentions))]
        if not mentions:
            arms["C_kol_pattern"] = ArmResult(
                scenario="C_kol_pattern",
                status="empty",
                blocked_reason="临时 allowlist 在 K 线重叠窗口内无 mention",
                meta={"allowlist": allow, "kline_end": _ms_to_iso(kline_end)},
            )
        else:
            # 与 K 线是否有交集：mentions 已按 end_ms 过滤
            arm = run_arm_c_kol_pattern(store, mentions)
            arm.meta["allowlist"] = allow
            arm.meta["kline_end"] = _ms_to_iso(kline_end)
            arm.meta["mention_range"] = {
                "min": _ms_to_iso(min(m["ts_ms"] for m in mentions)),
                "max": _ms_to_iso(max(m["ts_ms"] for m in mentions)),
            }
            arms["C_kol_pattern"] = arm

    params = {
        "fee_pct_per_side": OI_BT_FEE_PCT,
        "slippage_pct_per_side": OI_BT_SLIPPAGE_PCT,
        "entry_mode": "next_bar_open",
        "oi_patterns": OI_ENTRY_PATTERNS,
        "oi_pattern_timeout_bars": OI_ENTRY_PATTERN_TIMEOUT_BARS,
        "kol_tf": KOL_PATTERN_TF,
        "kol_lookahead_bars": KOL_PATTERN_LOOKAHEAD_BARS,
        "kol_patterns": KOL_PATTERNS,
        "kline_dir": str(BACKTEST_KLINES_DIR),
        "kline_coverage_end": _ms_to_iso(kline_end),
        "allowlist": "temporary",
        "ran_at_asia_shanghai": datetime.now(tz=__import__("zoneinfo").ZoneInfo("Asia/Shanghai")).isoformat(
            timespec="seconds"
        ),
    }

    result = {
        "params": params,
        "oi_discovery": oi_disc,
        "arms": {k: v.public_row() for k, v in arms.items()},
        "elapsed_sec": round(time.time() - t0, 2),
    }
    # 落盘明细（不含伪造）
    out_dir = _DATA / "three_way_backtest"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(tz=__import__("zoneinfo").ZoneInfo("Asia/Shanghai")).strftime(
        "%Y%m%d_%H%M%S"
    )
    summary_path = out_dir / f"summary_{stamp}.json"
    summary_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    for name, arm in arms.items():
        if arm.items:
            (out_dir / f"{name}_{stamp}.json").write_text(
                json.dumps(arm.items, ensure_ascii=False, indent=2)
            )
    result["summary_path"] = str(summary_path)
    # 最新指针
    (out_dir / "latest_summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2)
    )
    return result


__all__ = [
    "ArmResult",
    "discover_oi_history",
    "load_kol_mentions",
    "load_oi_events",
    "load_temp_kol_allowlist",
    "run_arm_a_pure_oi",
    "run_arm_b_oi_pattern",
    "run_arm_c_kol_pattern",
    "run_three_way",
]
