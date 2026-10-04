"""候选信号与事后收益落库（含被过滤掉的）。"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from oi_mornitor.config import SIGNAL_LOG_DB
from oi_mornitor.strategy.params import PARAMS_VERSION

CODE_VERSION = "oi-signal-v1"


def _connect(db_path: Path | str | None = None) -> sqlite3.Connection:
    path = Path(db_path or SIGNAL_LOG_DB)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_signal_log_db(db_path: Path | str | None = None) -> None:
    with _connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS signal_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                exchange TEXT NOT NULL DEFAULT 'binance_um',
                tf TEXT NOT NULL,
                bar_open_ts INTEGER,
                bar_close_ts INTEGER NOT NULL,
                detected_at INTEGER NOT NULL,
                pushed_at INTEGER,
                side TEXT NOT NULL,
                family TEXT,
                kind TEXT NOT NULL,
                strength REAL,
                score_tf REAL,
                resonance_r REAL,
                grade TEXT,
                tfs_hit TEXT,
                price_close REAL,
                features_json TEXT,
                reject_reason TEXT,
                params_version TEXT,
                code_version TEXT,
                tags_json TEXT,
                UNIQUE(symbol, tf, kind, bar_close_ts, side)
            );
            CREATE INDEX IF NOT EXISTS idx_signal_log_sym_tf
                ON signal_log(symbol, tf, bar_close_ts);
            CREATE INDEX IF NOT EXISTS idx_signal_log_kind
                ON signal_log(kind, reject_reason);

            CREATE TABLE IF NOT EXISTS signal_outcome (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                signal_id INTEGER NOT NULL,
                exit_ts INTEGER,
                exit_price REAL,
                pnl_pct REAL,
                pnl_r REAL,
                mfe_pct REAL,
                mae_pct REAL,
                mfe_r REAL,
                mae_r REAL,
                bars_held INTEGER,
                exit_reason TEXT,
                leverage REAL,
                fee_pct REAL,
                group_tag TEXT,
                FOREIGN KEY(signal_id) REFERENCES signal_log(id)
            );
            CREATE INDEX IF NOT EXISTS idx_signal_outcome_sid
                ON signal_outcome(signal_id);

            CREATE TABLE IF NOT EXISTS resonance_state (
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                grade TEXT,
                resonance_r REAL,
                last_upgrade_ts INTEGER,
                bar_4h_close INTEGER,
                PRIMARY KEY(symbol, side)
            );
            """
        )
        conn.commit()


def insert_signal(
    event: dict[str, Any],
    *,
    db_path: Path | str | None = None,
) -> int | None:
    """写入或更新一条候选；返回 row id。"""
    init_signal_log_db(db_path)
    features = event.get("features") or event.get("features_json") or {}
    if isinstance(features, dict):
        features_json = json.dumps(features, ensure_ascii=False)
    else:
        features_json = str(features or "")
    tags = event.get("tags") or {}
    tags_json = json.dumps(tags, ensure_ascii=False) if isinstance(tags, dict) else str(tags or "")
    tfs_hit = event.get("tfs_hit") or []
    tfs_json = json.dumps(tfs_hit, ensure_ascii=False) if isinstance(tfs_hit, (list, tuple)) else str(tfs_hit or "")
    payload = (
        str(event.get("symbol") or "").upper(),
        str(event.get("exchange") or "binance_um"),
        str(event.get("tf") or event.get("interval") or ""),
        int(event.get("bar_open_ts") or 0) or None,
        int(event.get("bar_close_ts") or event.get("kline_close_time") or 0),
        int(event.get("detected_at") or time.time() * 1000),
        int(event["pushed_at"]) if event.get("pushed_at") else None,
        str(event.get("side") or ""),
        str(event.get("family") or ""),
        str(event.get("kind") or ""),
        float(event["strength"]) if event.get("strength") is not None else None,
        float(event["score_tf"]) if event.get("score_tf") is not None else None,
        float(event["resonance_r"]) if event.get("resonance_r") is not None else None,
        event.get("grade"),
        tfs_json,
        float(event["price_close"]) if event.get("price_close") is not None else event.get("close"),
        features_json,
        event.get("reject_reason"),
        str(event.get("params_version") or PARAMS_VERSION),
        str(event.get("code_version") or CODE_VERSION),
        tags_json,
    )
    if not payload[0] or not payload[2] or not payload[4] or not payload[9]:
        return None
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO signal_log (
                symbol, exchange, tf, bar_open_ts, bar_close_ts, detected_at, pushed_at,
                side, family, kind, strength, score_tf, resonance_r, grade, tfs_hit,
                price_close, features_json, reject_reason, params_version, code_version, tags_json
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(symbol, tf, kind, bar_close_ts, side) DO UPDATE SET
                detected_at=excluded.detected_at,
                reject_reason=COALESCE(excluded.reject_reason, signal_log.reject_reason),
                score_tf=COALESCE(excluded.score_tf, signal_log.score_tf),
                resonance_r=COALESCE(excluded.resonance_r, signal_log.resonance_r),
                grade=COALESCE(excluded.grade, signal_log.grade),
                features_json=excluded.features_json,
                tags_json=excluded.tags_json,
                pushed_at=COALESCE(excluded.pushed_at, signal_log.pushed_at)
            """,
            payload,
        )
        row = conn.execute(
            """
            SELECT id FROM signal_log
            WHERE symbol=? AND tf=? AND kind=? AND bar_close_ts=? AND side=?
            """,
            (payload[0], payload[2], payload[9], payload[4], payload[7]),
        ).fetchone()
        conn.commit()
    return int(row["id"]) if row else None


def insert_outcome(
    signal_id: int,
    outcome: dict[str, Any],
    *,
    db_path: Path | str | None = None,
) -> None:
    init_signal_log_db(db_path)
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO signal_outcome (
                signal_id, exit_ts, exit_price, pnl_pct, pnl_r,
                mfe_pct, mae_pct, mfe_r, mae_r, bars_held,
                exit_reason, leverage, fee_pct, group_tag
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                int(signal_id),
                outcome.get("exit_ts"),
                outcome.get("exit_price"),
                outcome.get("pnl_pct"),
                outcome.get("pnl_r"),
                outcome.get("mfe_pct"),
                outcome.get("mae_pct"),
                outcome.get("mfe_r"),
                outcome.get("mae_r"),
                outcome.get("bars_held"),
                outcome.get("exit_reason"),
                outcome.get("leverage"),
                outcome.get("fee_pct"),
                outcome.get("group_tag"),
            ),
        )
        conn.commit()


def list_signals(
    *,
    db_path: Path | str | None = None,
    symbol: str | None = None,
    kind: str | None = None,
    limit: int = 500,
) -> list[dict[str, Any]]:
    init_signal_log_db(db_path)
    sql = "SELECT * FROM signal_log WHERE 1=1"
    args: list[Any] = []
    if symbol:
        sql += " AND symbol=?"
        args.append(symbol.upper())
    if kind:
        sql += " AND kind=?"
        args.append(kind)
    sql += " ORDER BY bar_close_ts DESC LIMIT ?"
    args.append(int(limit))
    with _connect(db_path) as conn:
        rows = conn.execute(sql, args).fetchall()
    return [dict(r) for r in rows]
