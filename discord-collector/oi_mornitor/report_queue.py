"""每 5 分钟聚合形态信号与 OI/持仓量异常，供 collector Show 页报告队列读取。

主扫描间隔不变（默认 150s）。本模块只做窗口聚合、去重与持久化：
- 窗口按 UTC+8 时钟对齐（与现网结算摘要同一时区偏移）
- 纳入 /oi 已监控的各周期（5m/15m/1h/4h 等）；形态周期最低 5m，不收录 1m
- 窗口内无事件不落空报告
- 放量口径复用形态卡片 vol_ratio / CANDLE_CARD_VOL_MULT；缺失标为 unknown
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from oi_mornitor.sqlite_util import connect

logger = logging.getLogger(__name__)

_TZ_CN = timezone(timedelta(hours=8))
_INTERVAL_RE = re.compile(
    r"^(\d+(?:\.\d+)?)(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|wk|week|weeks)?$",
    re.IGNORECASE,
)
_INTERVAL_UNIT_SEC = {
    "ms": 0.001,
    "s": 1,
    "sec": 1,
    "secs": 1,
    "m": 60,
    "min": 60,
    "mins": 60,
    "h": 3600,
    "hr": 3600,
    "hrs": 3600,
    "d": 86400,
    "day": 86400,
    "days": 86400,
    "w": 604800,
    "wk": 604800,
    "week": 604800,
    "weeks": 604800,
}
_BULL_SIDES = {"bull", "long", "buy", "pump", "多", "做多", "多头"}
_BEAR_SIDES = {"bear", "short", "sell", "dump", "空", "做空", "空头"}
_DEFAULT_WINDOW_SEC = 300
_DEFAULT_MIN_INTERVAL_SEC = 300
_DEFAULT_RETENTION_DAYS = 7
_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    window_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    side TEXT NOT NULL,
    pattern TEXT NOT NULL,
    volume_surge TEXT NOT NULL,
    volume_ratio REAL,
    oi_anomaly INTEGER NOT NULL DEFAULT 0,
    oi_historic INTEGER NOT NULL DEFAULT 0,
    oi_windows TEXT NOT NULL DEFAULT '[]',
    time_ms INTEGER NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_window ON events (window_id, time_ms);
CREATE TABLE IF NOT EXISTS reports (
    window_id TEXT PRIMARY KEY,
    window_start_ms INTEGER NOT NULL,
    window_end_ms INTEGER NOT NULL,
    item_count INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS flushed_windows (
    window_id TEXT PRIMARY KEY,
    window_start_ms INTEGER NOT NULL,
    window_end_ms INTEGER NOT NULL,
    item_count INTEGER NOT NULL,
    flushed_at_ms INTEGER NOT NULL
);
"""

_LOCK = threading.Lock()
_QUEUE: "ReportQueue | None" = None


def _pkg_data_dir() -> Path:
    return Path(__file__).resolve().parent / "data"


def default_db_path() -> Path:
    return _pkg_data_dir() / "report_queue.db"


def _now_cn(now: datetime | float | int | None = None) -> datetime:
    if now is None:
        return datetime.now(_TZ_CN)
    if isinstance(now, (int, float)):
        return datetime.fromtimestamp(float(now), tz=_TZ_CN)
    if now.tzinfo is None:
        return now.replace(tzinfo=_TZ_CN)
    return now.astimezone(_TZ_CN)


def _ms(ts: datetime | float | int) -> int:
    if isinstance(ts, datetime):
        return int(ts.timestamp() * 1000)
    return int(float(ts) * 1000)


def interval_seconds(raw: Any) -> int | None:
    """解析 5m/15m/1h/4h/1d 等；无法识别则返回 None。"""
    s = str(raw or "").strip().lower().replace(" ", "")
    if not s:
        return None
    aliases = {"1min": "1m", "5min": "5m", "15min": "15m", "30min": "30m"}
    s = aliases.get(s, s)
    m = _INTERVAL_RE.fullmatch(s)
    if not m:
        return None
    n = float(m.group(1))
    unit = (m.group(2) or "").lower()
    if not unit:
        return None
    scale = _INTERVAL_UNIT_SEC.get(unit)
    if scale is None:
        return None
    sec = n * scale
    if sec <= 0:
        return None
    return int(sec)


def normalize_interval_label(raw: Any) -> str:
    s = str(raw or "").strip()
    sec = interval_seconds(s)
    if sec is None:
        return s
    if sec % 604800 == 0:
        return f"{sec // 604800}w"
    if sec % 86400 == 0:
        return f"{sec // 86400}d"
    if sec % 3600 == 0:
        return f"{sec // 3600}h"
    if sec % 60 == 0:
        return f"{sec // 60}m"
    return f"{sec}s"


def is_min_interval(raw: Any, *, min_sec: int = _DEFAULT_MIN_INTERVAL_SEC) -> bool:
    sec = interval_seconds(raw)
    if sec is None:
        return False
    return sec >= int(min_sec)


def classify_volume_surge(
    rec: dict[str, Any] | None,
    *,
    threshold: float | None = None,
) -> tuple[str, float | None]:
    """返回 (yes|no|unknown, vol_ratio)。缺失或无法解析时为 unknown，不编造。"""
    rec = rec or {}
    raw = rec.get("vol_ratio")
    if raw is None:
        raw = rec.get("volRatio")
    if raw is None:
        raw = rec.get("climax_vol_ratio")
    try:
        ratio = float(raw) if raw is not None else None
    except (TypeError, ValueError):
        ratio = None
    if ratio is None:
        return "unknown", None
    if threshold is None:
        try:
            from oi_mornitor.config import CANDLE_CARD_VOL_MULT

            threshold = float(CANDLE_CARD_VOL_MULT)
        except Exception:  # noqa: BLE001
            threshold = 1.2
    if ratio >= float(threshold):
        return "yes", ratio
    return "no", ratio


def normalize_side(raw: Any, *, fallback: str = "") -> str:
    s = str(raw or "").strip().lower()
    if s in _BULL_SIDES:
        return "bull"
    if s in _BEAR_SIDES:
        return "bear"
    if s:
        return s
    return str(fallback or "").strip().lower()


def _side_from_delta(delta: Any, pct: Any = None) -> str:
    for val in (delta, pct):
        try:
            n = float(val)
        except (TypeError, ValueError):
            continue
        if n > 0:
            return "bull"
        if n < 0:
            return "bear"
    return ""


def _event_time_ms(rec: dict[str, Any], now_ts: float) -> int:
    for key in (
        "kline_close_time",
        "close_time",
        "time_ms",
        "alert_ts",
        "scan_ts",
        "time",
        "kline_open_time",
    ):
        raw = rec.get(key)
        if raw is None or raw == "" or raw == 0:
            continue
        try:
            n = float(raw)
        except (TypeError, ValueError):
            continue
        if n <= 0:
            continue
        # 秒 / 毫秒
        if n >= 1e12:
            return int(n)
        if n >= 1e9:
            return int(n * 1000)
        return int(n * 1000)
    return int(now_ts * 1000)


def _pattern_label(rec: dict[str, Any]) -> str:
    for key in ("type_label", "signal_text", "signal_kind", "kind", "message", "type"):
        val = rec.get(key)
        if val is None:
            continue
        s = str(val).strip()
        if s and s not in {"candle_pattern_card", "CANDLE_CARD", "equity_pattern"}:
            return s
    return ""


def _symbol(rec: dict[str, Any]) -> str:
    return str(rec.get("symbol") or rec.get("base") or "").strip().upper()


def window_start(now: datetime | float | int, window_sec: int) -> datetime:
    dt = _now_cn(now)
    epoch = int(dt.timestamp())
    start = epoch - (epoch % int(window_sec))
    return datetime.fromtimestamp(start, tz=_TZ_CN)


def window_id_for(start: datetime) -> str:
    return start.astimezone(_TZ_CN).strftime("%Y-%m-%dT%H:%M%z")


def window_label(start: datetime, end: datetime) -> str:
    return f"{start.strftime('%H:%M')}–{end.strftime('%H:%M')}"


def _tf_bar_start_ms(time_ms: int, interval_sec: int) -> int:
    step = max(1, int(interval_sec) * 1000)
    return (int(time_ms) // step) * step


def _oi_limits() -> tuple[float, float]:
    try:
        from oi_mornitor.config import OI_PCT_LIMIT, OI_USD_LIMIT

        return float(OI_USD_LIMIT), float(OI_PCT_LIMIT)
    except Exception:  # noqa: BLE001
        return 500000.0, 2.5


def _oi_triggered(delta_usd: Any, pct: Any, usd_limit: float, pct_limit: float) -> bool:
    try:
        d = abs(float(delta_usd))
    except (TypeError, ValueError):
        d = 0.0
    try:
        p = abs(float(pct))
    except (TypeError, ValueError):
        p = 0.0
    return d >= usd_limit or p >= pct_limit


class ReportQueue:
    def __init__(
        self,
        db_path: str | Path | None = None,
        *,
        window_sec: int = _DEFAULT_WINDOW_SEC,
        min_interval_sec: int = _DEFAULT_MIN_INTERVAL_SEC,
        retention_days: int = _DEFAULT_RETENTION_DAYS,
        volume_threshold: float | None = None,
    ) -> None:
        self.db_path = Path(db_path) if db_path else default_db_path()
        self.window_sec = max(60, int(window_sec))
        self.min_interval_sec = max(60, int(min_interval_sec))
        self.retention_days = max(1, int(retention_days))
        self.volume_threshold = volume_threshold
        self._ensured = False
        self._lock = threading.Lock()

    def _connect(self):
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = connect(self.db_path)
        if not self._ensured:
            conn.executescript(_SCHEMA)
            conn.commit()
            self._ensured = True
        return conn

    def _window_bounds(self, now: datetime | float | int) -> tuple[datetime, datetime, str]:
        start = window_start(now, self.window_sec)
        end = start + timedelta(seconds=self.window_sec)
        return start, end, window_id_for(start)

    def ingest_pattern_alerts(
        self,
        alerts: Iterable[dict[str, Any]] | None,
        *,
        now: datetime | float | int | None = None,
    ) -> int:
        added = 0
        now_dt = _now_cn(now)
        now_ts = now_dt.timestamp()
        for rec in alerts or []:
            if not isinstance(rec, dict):
                continue
            event = self._pattern_event(rec, now_ts=now_ts)
            if event is None:
                continue
            if self._insert_event(event, now=now_dt):
                added += 1
        return added

    def ingest_oi_rows(
        self,
        rows: Iterable[dict[str, Any]] | None,
        *,
        now: datetime | float | int | None = None,
        usd_limit: float | None = None,
        pct_limit: float | None = None,
    ) -> int:
        added = 0
        now_dt = _now_cn(now)
        now_ts = now_dt.timestamp()
        default_usd, default_pct = _oi_limits()
        usd_limit = default_usd if usd_limit is None else float(usd_limit)
        pct_limit = default_pct if pct_limit is None else float(pct_limit)
        for rec in rows or []:
            if not isinstance(rec, dict):
                continue
            for event in self._oi_events(
                rec, now_ts=now_ts, usd_limit=usd_limit, pct_limit=pct_limit
            ):
                if self._insert_event(event, now=now_dt):
                    added += 1
        return added

    def flush_due(self, now: datetime | float | int | None = None) -> list[dict[str, Any]]:
        """关闭已结束窗口：有事件则生成报告，无事件不落空报告。"""
        now_dt = _now_cn(now)
        current_start, _, current_id = self._window_bounds(now_dt)
        created: list[dict[str, Any]] = []
        with self._lock:
            conn = self._connect()
            try:
                pending_ids = [
                    str(r[0])
                    for r in conn.execute(
                        "SELECT DISTINCT window_id FROM events "
                        "WHERE window_id NOT IN (SELECT window_id FROM flushed_windows)"
                    )
                ]
                # 也把「当前窗之前、尚无事件」的缺口标成已刷新（不写报告）
                last = conn.execute(
                    "SELECT window_end_ms FROM flushed_windows ORDER BY window_end_ms DESC LIMIT 1"
                ).fetchone()
                cursor_ms = int(last["window_end_ms"]) if last else None
                to_flush: list[tuple[str, int, int]] = []
                seen = set()
                for wid in pending_ids:
                    start, end = self._parse_window_id(wid)
                    if end is None or end > now_dt:
                        continue
                    to_flush.append((wid, _ms(start), _ms(end)))
                    seen.add(wid)
                if cursor_ms is not None:
                    t = datetime.fromtimestamp(cursor_ms / 1000.0, tz=_TZ_CN)
                    while t + timedelta(seconds=self.window_sec) <= current_start:
                        start = t
                        end = t + timedelta(seconds=self.window_sec)
                        wid = window_id_for(start)
                        if wid not in seen and wid != current_id:
                            to_flush.append((wid, _ms(start), _ms(end)))
                            seen.add(wid)
                        t = end
                to_flush.sort(key=lambda x: x[1])
                now_ms = _ms(now_dt)
                for wid, start_ms, end_ms in to_flush:
                    count_row = conn.execute(
                        "SELECT COUNT(*) AS n FROM events WHERE window_id = ?",
                        (wid,),
                    ).fetchone()
                    count = int(count_row["n"] if count_row else 0)
                    conn.execute(
                        "INSERT OR REPLACE INTO flushed_windows "
                        "(window_id, window_start_ms, window_end_ms, item_count, flushed_at_ms) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (wid, start_ms, end_ms, count, now_ms),
                    )
                    if count <= 0:
                        continue
                    conn.execute(
                        "INSERT OR REPLACE INTO reports "
                        "(window_id, window_start_ms, window_end_ms, item_count, created_at_ms) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (wid, start_ms, end_ms, count, now_ms),
                    )
                    created.append(self._report_from_conn(conn, wid, include_items=True) or {})
                self._prune(conn, now_dt)
                conn.commit()
            finally:
                conn.close()
        return [r for r in created if r]

    def list_reports(
        self,
        *,
        limit: int = 96,
        include_items: bool = True,
        now: datetime | float | int | None = None,
    ) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 500))
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    "SELECT window_id FROM reports ORDER BY window_start_ms DESC LIMIT ?",
                    (limit,),
                ).fetchall()
                out = []
                for row in rows:
                    rec = self._report_from_conn(
                        conn, str(row["window_id"]), include_items=include_items
                    )
                    if rec:
                        out.append(rec)
            finally:
                conn.close()
        return out

    def get_report(self, report_id: str, *, include_items: bool = True) -> dict[str, Any] | None:
        wid = str(report_id or "").strip()
        if not wid:
            return None
        with self._lock:
            conn = self._connect()
            try:
                return self._report_from_conn(conn, wid, include_items=include_items)
            finally:
                conn.close()

    def pending_report(self, now: datetime | float | int | None = None) -> dict[str, Any] | None:
        """当前未结束窗口：有事件才返回，不写入 reports 表。"""
        now_dt = _now_cn(now)
        start, end, wid = self._window_bounds(now_dt)
        with self._lock:
            conn = self._connect()
            try:
                count_row = conn.execute(
                    "SELECT COUNT(*) AS n FROM events WHERE window_id = ?",
                    (wid,),
                ).fetchone()
                count = int(count_row["n"] if count_row else 0)
                if count <= 0:
                    return None
                items = self._items_for_window(conn, wid) if True else []
                return self._format_report(
                    window_id=wid,
                    start=start,
                    end=end,
                    item_count=count,
                    created_at_ms=None,
                    items=items,
                    pending=True,
                )
            finally:
                conn.close()

    def payload(
        self,
        *,
        limit: int = 96,
        include_items: bool = True,
        now: datetime | float | int | None = None,
    ) -> dict[str, Any]:
        reports = self.list_reports(limit=limit, include_items=include_items, now=now)
        pending = self.pending_report(now=now)
        return {
            "ok": True,
            "timezone": "UTC+8",
            "windowSec": self.window_sec,
            "minInterval": normalize_interval_label(f"{self.min_interval_sec // 60}m"),
            "pending": pending,
            "reports": reports,
            "count": len(reports),
        }

    def _pattern_event(self, rec: dict[str, Any], *, now_ts: float) -> dict[str, Any] | None:
        symbol = _symbol(rec)
        interval = normalize_interval_label(rec.get("interval") or rec.get("tf") or rec.get("timeframe"))
        if not symbol or not interval:
            return None
        if not is_min_interval(interval, min_sec=self.min_interval_sec):
            return None
        side = normalize_side(rec.get("side") or rec.get("direction"))
        pattern = _pattern_label(rec)
        surge, ratio = classify_volume_surge(rec, threshold=self.volume_threshold)
        time_ms = _event_time_ms(rec, now_ts)
        close_key = rec.get("kline_close_time") or rec.get("time") or rec.get("kline_open_time") or time_ms
        kind_key = rec.get("kind") or rec.get("signal_kind") or rec.get("type") or pattern or "pattern"
        event_id = f"pattern:{symbol}:{interval}:{kind_key}:{close_key}"
        oi_flag = bool(rec.get("oi_anomaly") or rec.get("oiAnomaly"))
        return {
            "event_id": event_id,
            "kind": "pattern",
            "symbol": symbol,
            "interval": interval,
            "side": side,
            "pattern": pattern,
            "volume_surge": surge,
            "volume_ratio": ratio,
            "oi_anomaly": 1 if oi_flag else 0,
            "oi_historic": 0,
            "oi_windows": [interval] if oi_flag else [],
            "time_ms": time_ms,
            "payload": {
                "type": rec.get("type"),
                "source": rec.get("source") or rec.get("asset_class") or "",
            },
        }

    def _oi_events(
        self,
        rec: dict[str, Any],
        *,
        now_ts: float,
        usd_limit: float,
        pct_limit: float,
    ) -> list[dict[str, Any]]:
        if rec.get("status") == "warming":
            return []
        symbol = _symbol(rec)
        if not symbol:
            return []
        time_ms = _event_time_ms(rec, now_ts)
        historic = bool(rec.get("is_historic_anomaly"))
        triggered: dict[str, dict[str, Any]] = {}

        def _add(interval: str, *, delta: Any = None, pct: Any = None, historic_flag: bool = False) -> None:
            label = normalize_interval_label(interval)
            if not is_min_interval(label, min_sec=self.min_interval_sec):
                return
            side = _side_from_delta(delta, pct)
            if not side:
                side = normalize_side(rec.get("type") or rec.get("status"))
            triggered[label] = {
                "delta": delta,
                "pct": pct,
                "side": side,
                "historic": historic_flag,
            }

        raw_windows = rec.get("triggered_windows") or []
        if rec.get("is_alert") and isinstance(raw_windows, list):
            for w in raw_windows:
                label = normalize_interval_label(w)
                delta = rec.get(f"delta_{label}_usd", rec.get("delta_5m_usd") if label == "5m" else rec.get("delta_15m_usd"))
                pct = rec.get(f"pct_{label}", rec.get("pct_5m") if label == "5m" else rec.get("pct_15m"))
                oi_tf = (rec.get("oi_by_tf") or {}).get(label) if isinstance(rec.get("oi_by_tf"), dict) else None
                if isinstance(oi_tf, dict):
                    delta = oi_tf.get("delta_usd", delta)
                    pct = oi_tf.get("pct", pct)
                _add(label, delta=delta, pct=pct, historic_flag=historic and label == "5m")

        if historic and "5m" not in triggered:
            _add(
                "5m",
                delta=rec.get("delta_5m_usd"),
                pct=rec.get("pct_5m"),
                historic_flag=True,
            )

        oi_by_tf = rec.get("oi_by_tf") if isinstance(rec.get("oi_by_tf"), dict) else {}
        for label, stats in oi_by_tf.items():
            if not isinstance(stats, dict):
                continue
            if not _oi_triggered(stats.get("delta_usd"), stats.get("pct"), usd_limit, pct_limit):
                continue
            if normalize_interval_label(label) in triggered:
                continue
            _add(label, delta=stats.get("delta_usd"), pct=stats.get("pct"))

        events: list[dict[str, Any]] = []
        for label, info in triggered.items():
            sec = interval_seconds(label) or self.min_interval_sec
            bar = _tf_bar_start_ms(time_ms, sec)
            side = info["side"] or "oi"
            event_id = f"oi:{symbol}:{label}:{side}:{bar}"
            events.append(
                {
                    "event_id": event_id,
                    "kind": "oi_anomaly",
                    "symbol": symbol,
                    "interval": label,
                    "side": info["side"],
                    "pattern": "持仓量异常",
                    "volume_surge": "unknown",
                    "volume_ratio": None,
                    "oi_anomaly": 1,
                    "oi_historic": 1 if info.get("historic") else 0,
                    "oi_windows": [label],
                    "time_ms": time_ms,
                    "payload": {
                        "delta_usd": info.get("delta"),
                        "pct": info.get("pct"),
                        "type": rec.get("type"),
                        "status": rec.get("status"),
                    },
                }
            )
        return events

    def _insert_event(self, event: dict[str, Any], *, now: datetime) -> bool:
        start, _end, wid = self._window_bounds(now)
        # 只写入当前或尚未刷新的窗口；过期事件若窗口已 flush 则丢弃（避免补进旧报告）
        with self._lock:
            conn = self._connect()
            try:
                flushed = conn.execute(
                    "SELECT 1 FROM flushed_windows WHERE window_id = ?",
                    (wid,),
                ).fetchone()
                if flushed:
                    # 时钟落到已关闭窗口（测试里手动 now 回拨除外）——若该窗已 flush 则不再写入
                    return False
                cur = conn.execute(
                    "INSERT OR IGNORE INTO events ("
                    "event_id, window_id, kind, symbol, interval, side, pattern, "
                    "volume_surge, volume_ratio, oi_anomaly, oi_historic, oi_windows, "
                    "time_ms, payload, created_at_ms"
                    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        event["event_id"],
                        wid,
                        event["kind"],
                        event["symbol"],
                        event["interval"],
                        event["side"],
                        event["pattern"],
                        event["volume_surge"],
                        event["volume_ratio"],
                        int(event["oi_anomaly"]),
                        int(event["oi_historic"]),
                        json.dumps(event.get("oi_windows") or [], ensure_ascii=False),
                        int(event["time_ms"]),
                        json.dumps(event.get("payload") or {}, ensure_ascii=False, default=str),
                        _ms(now),
                    ),
                )
                conn.commit()
                return cur.rowcount == 1
            finally:
                conn.close()

    def _items_for_window(self, conn, window_id: str) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT * FROM events WHERE window_id = ? ORDER BY time_ms ASC, event_id ASC",
            (window_id,),
        ).fetchall()
        items = []
        for row in rows:
            items.append(self._format_item(row))
        return items

    def _report_from_conn(
        self, conn, window_id: str, *, include_items: bool
    ) -> dict[str, Any] | None:
        row = conn.execute(
            "SELECT * FROM reports WHERE window_id = ?",
            (window_id,),
        ).fetchone()
        if not row:
            return None
        start = datetime.fromtimestamp(int(row["window_start_ms"]) / 1000.0, tz=_TZ_CN)
        end = datetime.fromtimestamp(int(row["window_end_ms"]) / 1000.0, tz=_TZ_CN)
        items = self._items_for_window(conn, window_id) if include_items else []
        return self._format_report(
            window_id=window_id,
            start=start,
            end=end,
            item_count=int(row["item_count"]),
            created_at_ms=int(row["created_at_ms"]),
            items=items,
            pending=False,
        )

    def _format_item(self, row: Any) -> dict[str, Any]:
        try:
            oi_windows = json.loads(row["oi_windows"] or "[]")
        except (TypeError, json.JSONDecodeError):
            oi_windows = []
        time_ms = int(row["time_ms"])
        dt = datetime.fromtimestamp(time_ms / 1000.0, tz=_TZ_CN)
        ratio = row["volume_ratio"]
        try:
            ratio_out = float(ratio) if ratio is not None else None
        except (TypeError, ValueError):
            ratio_out = None
        return {
            "id": row["event_id"],
            "kind": row["kind"],
            "symbol": row["symbol"],
            "interval": row["interval"],
            "side": row["side"],
            "sideLabel": _side_label(row["side"]),
            "pattern": row["pattern"],
            "volumeSurge": row["volume_surge"],
            "volumeSurgeLabel": _volume_label(row["volume_surge"]),
            "volumeRatio": ratio_out,
            "oiAnomaly": bool(row["oi_anomaly"]),
            "oiHistoric": bool(row["oi_historic"]),
            "oiWindows": oi_windows,
            "timeMs": time_ms,
            "timeLabel": dt.strftime("%H:%M:%S"),
            "dateLabel": dt.strftime("%Y-%m-%d %H:%M:%S"),
        }

    def _format_report(
        self,
        *,
        window_id: str,
        start: datetime,
        end: datetime,
        item_count: int,
        created_at_ms: int | None,
        items: list[dict[str, Any]],
        pending: bool,
    ) -> dict[str, Any]:
        preview = _preview_from_items(items, item_count)
        return {
            "id": window_id,
            "windowStartMs": _ms(start),
            "windowEndMs": _ms(end),
            "windowLabel": window_label(start, end),
            "windowDateLabel": start.strftime("%Y-%m-%d"),
            "itemCount": item_count,
            "createdAtMs": created_at_ms,
            "pending": pending,
            "preview": preview,
            "items": items,
        }

    def _parse_window_id(self, window_id: str) -> tuple[datetime | None, datetime | None]:
        raw = str(window_id or "").strip()
        try:
            # 2026-11-18T16:25+0800
            start = datetime.strptime(raw, "%Y-%m-%dT%H:%M%z")
        except ValueError:
            try:
                start = datetime.fromisoformat(raw)
            except ValueError:
                return None, None
        if start.tzinfo is None:
            start = start.replace(tzinfo=_TZ_CN)
        else:
            start = start.astimezone(_TZ_CN)
        end = start + timedelta(seconds=self.window_sec)
        return start, end

    def _prune(self, conn, now: datetime) -> None:
        cutoff_ms = _ms(now) - self.retention_days * 86400 * 1000
        conn.execute("DELETE FROM reports WHERE window_end_ms < ?", (cutoff_ms,))
        conn.execute("DELETE FROM flushed_windows WHERE window_end_ms < ?", (cutoff_ms,))
        conn.execute("DELETE FROM events WHERE time_ms < ?", (cutoff_ms,))


def _side_label(side: Any) -> str:
    s = normalize_side(side)
    if s == "bull":
        return "多"
    if s == "bear":
        return "空"
    return str(side or "—") or "—"


def _volume_label(surge: Any) -> str:
    s = str(surge or "").strip().lower()
    if s == "yes":
        return "放量"
    if s == "no":
        return "未放量"
    return "未知"


def _preview_from_items(items: list[dict[str, Any]], count: int) -> str:
    if not items:
        return f"{count} 条" if count else ""
    first = items[0]
    bits = [
        str(first.get("symbol") or ""),
        str(first.get("interval") or ""),
        str(first.get("pattern") or ""),
    ]
    text = " ".join(x for x in bits if x).strip()
    if first.get("volumeSurge") == "yes":
        text = f"{text} · 放量" if text else "放量"
    if count > 1:
        text = f"{text} 等 {count} 条" if text else f"{count} 条"
    return text


def ingest_scan(
    *,
    pattern_alerts: Iterable[dict[str, Any]] | None = None,
    oi_rows: Iterable[dict[str, Any]] | None = None,
    equity_alerts: Iterable[dict[str, Any]] | None = None,
    now: datetime | float | int | None = None,
    now_ts: float | None = None,
    usd_limit: float | None = None,
    pct_limit: float | None = None,
    queue: ReportQueue | None = None,
) -> dict[str, int]:
    q = queue or get_queue()
    when = now if now is not None else now_ts
    n_pat = q.ingest_pattern_alerts(list(pattern_alerts or []) + list(equity_alerts or []), now=when)
    n_oi = q.ingest_oi_rows(oi_rows, now=when, usd_limit=usd_limit, pct_limit=pct_limit)
    flushed = q.flush_due(now=when)
    return {"ingested": n_pat + n_oi, "flushed": len(flushed)}


def flush_due_windows(
    now: datetime | float | int | None = None,
    queue: ReportQueue | None = None,
) -> list[dict[str, Any]]:
    return (queue or get_queue()).flush_due(now=now)


def list_report_queue_payload(
    *,
    limit: int = 96,
    include_items: bool = True,
    now: datetime | float | int | None = None,
    queue: ReportQueue | None = None,
) -> dict[str, Any]:
    return (queue or get_queue()).payload(limit=limit, include_items=include_items, now=now)


def get_report_payload(
    report_id: str,
    *,
    queue: ReportQueue | None = None,
) -> dict[str, Any] | None:
    rec = (queue or get_queue()).get_report(report_id, include_items=True)
    if rec is None:
        return None
    return {"ok": True, "report": rec}


def get_queue() -> ReportQueue:
    global _QUEUE
    with _LOCK:
        if _QUEUE is None:
            _QUEUE = ReportQueue()
        return _QUEUE


def reset_queue_for_tests(queue: ReportQueue | None = None) -> None:
    global _QUEUE
    with _LOCK:
        _QUEUE = queue


async def run_report_queue_loop(
    is_running: Callable[[], bool],
    *,
    interval_sec: float = 15.0,
) -> None:
    """窗口边界刷新，避免两次主扫描之间漏关窗。"""
    delay = max(5.0, float(interval_sec))
    while is_running():
        try:
            created = flush_due_windows()
            if created:
                logger.info("报告队列新增 %d 份", len(created))
        except asyncio_cancelled():
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("报告队列刷新失败: %s", exc)
        try:
            import asyncio

            await asyncio.sleep(delay)
        except Exception:
            raise


def asyncio_cancelled() -> type[BaseException]:
    try:
        import asyncio

        return asyncio.CancelledError
    except Exception:  # pragma: no cover
        return KeyboardInterrupt
