"""
雷达多榜共振 → TradingView BB-Wicks 信号监听（CDP 9222）。

规则：
- 币种同时出现在 ≥ N 个矩阵榜单（默认 4）→ 为其 15m + 1h 创建 TV 提醒
- 条件：指标 BB-Wicks +「任何 alert() 函数调用」
- 容量满时淘汰本系统最早加入的币种（BTC/ETH 永不淘汰）
- 每次成功 create/remove 写入 SQLite 日志
"""
from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any

from oi_mornitor.config import (
    BREAKOUT_MATRIX_TF,
    MATRIX_TOP_N,
    TV_ALERT_CDP_URL,
    TV_ALERT_ENABLED,
    TV_ALERT_INDICATOR,
    TV_ALERT_INTERVALS,
    TV_ALERT_LOG_DB,
    TV_ALERT_MAX_SYMBOLS,
    TV_ALERT_MIN_BOARDS,
    TV_ALERT_NODE_SCRIPT,
    TV_ALERT_PROTECTED,
    TV_ALERT_SCRIPT_TIMEOUT_SEC,
)
from oi_mornitor.matrix_breakout import collect_matrix_leaderboard

logger = logging.getLogger("OI_Radar")


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS tv_alert_active (
            symbol TEXT NOT NULL,
            interval TEXT NOT NULL,
            alert_name TEXT NOT NULL,
            boards_json TEXT NOT NULL DEFAULT '[]',
            board_count INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            PRIMARY KEY (symbol, interval)
        );
        CREATE TABLE IF NOT EXISTS tv_alert_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            symbol TEXT NOT NULL,
            interval TEXT NOT NULL,
            ok INTEGER NOT NULL,
            detail TEXT NOT NULL DEFAULT '',
            boards_json TEXT NOT NULL DEFAULT '[]',
            created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tv_alert_log_ts ON tv_alert_log(created_at DESC);
        """
    )
    conn.commit()


def symbols_on_n_boards(
    leaderboard: dict[str, dict[str, Any]],
    *,
    min_boards: int = 4,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for sym, meta in leaderboard.items():
        cats = list(meta.get("categories") or [])
        if len(cats) >= min_boards:
            out.append(
                {
                    "symbol": str(sym).upper(),
                    "board_count": len(cats),
                    "categories": cats,
                    "labels": list(meta.get("labels") or []),
                    "best_rank": int(meta.get("best_rank") or 999),
                }
            )
    out.sort(key=lambda x: (-x["board_count"], x["best_rank"], x["symbol"]))
    return out


def _base_symbol(sym: str) -> str:
    s = str(sym or "").upper().replace("USDT", "").replace("USDC", "").replace("BUSD", "")
    return s


def _is_protected(symbol: str, protected: set[str]) -> bool:
    u = str(symbol or "").upper()
    if u in protected:
        return True
    base = _base_symbol(u)
    return base in protected or f"{base}USDT" in protected


class TvAlertSync:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._last_tick_ts = 0.0
        self._db = TV_ALERT_LOG_DB
        with _connect(self._db) as conn:
            _init_db(conn)

    def _log_row(
        self,
        conn: sqlite3.Connection,
        *,
        action: str,
        symbol: str,
        interval: str,
        ok: bool,
        detail: str,
        boards: list[str] | None = None,
    ) -> None:
        conn.execute(
            """
            INSERT INTO tv_alert_log(action, symbol, interval, ok, detail, boards_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                action,
                symbol,
                interval,
                1 if ok else 0,
                (detail or "")[:2000],
                json.dumps(boards or [], ensure_ascii=False),
                time.time(),
            ),
        )

    def list_active(self) -> list[dict[str, Any]]:
        with _connect(self._db) as conn:
            _init_db(conn)
            rows = conn.execute(
                "SELECT * FROM tv_alert_active ORDER BY created_at ASC"
            ).fetchall()
        return [dict(r) for r in rows]

    def active_symbols(self) -> list[str]:
        seen: list[str] = []
        for row in self.list_active():
            s = str(row["symbol"]).upper()
            if s not in seen:
                seen.append(s)
        return seen

    async def _run_node(
        self, action: str, symbol: str, interval: str
    ) -> dict[str, Any]:
        script = Path(TV_ALERT_NODE_SCRIPT)
        if not script.is_file():
            return {"ok": False, "error": f"script missing: {script}"}
        cmd = [
            "node",
            str(script),
            "--cdp",
            TV_ALERT_CDP_URL,
            "--action",
            action,
            "--symbol",
            symbol,
            "--interval",
            interval,
            "--indicator",
            TV_ALERT_INDICATOR,
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(script.parent),
            )
            try:
                stdout_b, stderr_b = await asyncio.wait_for(
                    proc.communicate(), timeout=TV_ALERT_SCRIPT_TIMEOUT_SEC
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.communicate()
                return {"ok": False, "error": "timeout"}
            stdout = (stdout_b or b"").decode("utf-8", errors="replace")
            stderr = (stderr_b or b"").decode("utf-8", errors="replace")
            if stderr.strip():
                for line in stderr.strip().splitlines()[-8:]:
                    logger.info("tv-alert %s", line)
            # 取最后一行 JSON
            result: dict[str, Any] = {"ok": False, "error": "no_json"}
            for line in reversed(stdout.strip().splitlines() if stdout.strip() else []):
                line = line.strip()
                if line.startswith("{") and line.endswith("}"):
                    try:
                        result = json.loads(line)
                        break
                    except json.JSONDecodeError:
                        continue
            if proc.returncode not in (0, None) and result.get("ok") is not True:
                result.setdefault("error", f"exit={proc.returncode}")
            return result
        except FileNotFoundError:
            return {"ok": False, "error": "node not found"}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    async def _ensure_symbol(
        self,
        symbol: str,
        *,
        boards: list[str],
        board_count: int,
    ) -> dict[str, Any]:
        """为 symbol 创建全部 interval 的提醒；必要时先腾容量。"""
        sym = symbol.upper()
        intervals = list(TV_ALERT_INTERVALS)
        active_syms = self.active_symbols()
        if sym not in active_syms:
            # 容量按「币种」计：每个币占 len(intervals) 条提醒
            while len(active_syms) >= TV_ALERT_MAX_SYMBOLS:
                evicted = await self._evict_oldest()
                if not evicted:
                    return {"ok": False, "error": "capacity_full_no_evictable", "symbol": sym}
                active_syms = self.active_symbols()

        results: list[dict[str, Any]] = []
        all_ok = True
        for iv in intervals:
            # 已存在则跳过
            with _connect(self._db) as conn:
                exists = conn.execute(
                    "SELECT 1 FROM tv_alert_active WHERE symbol=? AND interval=?",
                    (sym, iv),
                ).fetchone()
            if exists:
                results.append({"ok": True, "skipped": True, "interval": iv})
                continue
            res = await self._run_node("create", sym, iv)
            # TV 端提醒已满：先淘汰本系统最早加入的非主流币，再重试一次
            err = str(res.get("error") or "").lower()
            if not res.get("ok") and any(
                k in err for k in ("已满", "limit", "maximum", "too many", "full")
            ):
                evicted = await self._evict_oldest()
                if evicted:
                    logger.info("TV 提醒已满，已淘汰 %s，重试创建 %s %s", evicted, sym, iv)
                    await asyncio.sleep(2.0)
                    res = await self._run_node("create", sym, iv)
            results.append(res)
            with _connect(self._db) as conn:
                _init_db(conn)
                self._log_row(
                    conn,
                    action="create",
                    symbol=sym,
                    interval=iv,
                    ok=bool(res.get("ok")),
                    detail=json.dumps(res, ensure_ascii=False)[:2000],
                    boards=boards,
                )
                if res.get("ok"):
                    now = time.time()
                    name = str(res.get("name") or f"{TV_ALERT_INDICATOR} {sym} {iv}")
                    conn.execute(
                        """
                        INSERT INTO tv_alert_active(symbol, interval, alert_name, boards_json, board_count, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(symbol, interval) DO UPDATE SET
                          alert_name=excluded.alert_name,
                          boards_json=excluded.boards_json,
                          board_count=excluded.board_count,
                          updated_at=excluded.updated_at
                        """,
                        (
                            sym,
                            iv,
                            name,
                            json.dumps(boards, ensure_ascii=False),
                            board_count,
                            now,
                            now,
                        ),
                    )
                else:
                    all_ok = False
                conn.commit()
            # CDP 操作间隔，避免 TV 风控
            await asyncio.sleep(2.5)

        if all_ok:
            logger.info(
                "TV 信号监听已添加 %s boards=%d %s",
                sym,
                board_count,
                ",".join(boards[:6]),
            )
        return {"ok": all_ok, "symbol": sym, "results": results}

    async def _remove_symbol(self, symbol: str, *, reason: str) -> dict[str, Any]:
        sym = symbol.upper()
        if _is_protected(sym, set(TV_ALERT_PROTECTED)):
            return {"ok": False, "error": "protected", "symbol": sym}
        rows = [r for r in self.list_active() if str(r["symbol"]).upper() == sym]
        if not rows:
            return {"ok": True, "skipped": True, "symbol": sym}
        results = []
        for row in rows:
            iv = str(row["interval"])
            res = await self._run_node("remove", sym, iv)
            results.append(res)
            with _connect(self._db) as conn:
                _init_db(conn)
                self._log_row(
                    conn,
                    action=f"remove:{reason}",
                    symbol=sym,
                    interval=iv,
                    ok=bool(res.get("ok")),
                    detail=json.dumps(res, ensure_ascii=False)[:2000],
                )
                if res.get("ok") or res.get("skipped"):
                    conn.execute(
                        "DELETE FROM tv_alert_active WHERE symbol=? AND interval=?",
                        (sym, iv),
                    )
                conn.commit()
            await asyncio.sleep(2.0)
        logger.info("TV 信号监听已移除 %s reason=%s", sym, reason)
        return {"ok": True, "symbol": sym, "results": results}

    async def _evict_oldest(self) -> str | None:
        protected = set(TV_ALERT_PROTECTED)
        # 按币种最早 created_at
        by_sym: dict[str, float] = {}
        for row in self.list_active():
            sym = str(row["symbol"]).upper()
            if _is_protected(sym, protected):
                continue
            ts = float(row["created_at"] or 0)
            if sym not in by_sym or ts < by_sym[sym]:
                by_sym[sym] = ts
        if not by_sym:
            return None
        oldest = min(by_sym.items(), key=lambda x: x[1])[0]
        await self._remove_symbol(oldest, reason="capacity")
        return oldest

    async def tick(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        if not TV_ALERT_ENABLED:
            return {"ok": True, "skipped": True, "reason": "disabled"}
        async with self._lock:
            leaderboard = collect_matrix_leaderboard(
                rows, tf=BREAKOUT_MATRIX_TF, top_n=MATRIX_TOP_N
            )
            candidates = symbols_on_n_boards(
                leaderboard, min_boards=TV_ALERT_MIN_BOARDS
            )
            active = set(self.active_symbols())
            added: list[str] = []
            errors: list[str] = []

            for c in candidates:
                sym = c["symbol"]
                if sym in active:
                    # 刷新榜单元数据
                    with _connect(self._db) as conn:
                        conn.execute(
                            """
                            UPDATE tv_alert_active
                            SET boards_json=?, board_count=?, updated_at=?
                            WHERE symbol=?
                            """,
                            (
                                json.dumps(c["categories"], ensure_ascii=False),
                                c["board_count"],
                                time.time(),
                                sym,
                            ),
                        )
                        conn.commit()
                    continue
                res = await self._ensure_symbol(
                    sym,
                    boards=c["categories"],
                    board_count=c["board_count"],
                )
                if res.get("ok"):
                    added.append(sym)
                    active.add(sym)
                else:
                    errors.append(f"{sym}:{res.get('error') or res}")

            self._last_tick_ts = time.time()
            return {
                "ok": True,
                "candidates": len(candidates),
                "added": added,
                "active": sorted(active),
                "errors": errors[:10],
                "min_boards": TV_ALERT_MIN_BOARDS,
            }

    def get_payload(self) -> dict[str, Any]:
        active = self.list_active()
        with _connect(self._db) as conn:
            logs = conn.execute(
                "SELECT action, symbol, interval, ok, detail, created_at FROM tv_alert_log ORDER BY id DESC LIMIT 30"
            ).fetchall()
        return {
            "tv_alert_enabled": TV_ALERT_ENABLED,
            "tv_alert_min_boards": TV_ALERT_MIN_BOARDS,
            "tv_alert_max_symbols": TV_ALERT_MAX_SYMBOLS,
            "tv_alert_intervals": list(TV_ALERT_INTERVALS),
            "tv_alert_indicator": TV_ALERT_INDICATOR,
            "tv_alert_active": [
                {
                    "symbol": r["symbol"],
                    "interval": r["interval"],
                    "name": r["alert_name"],
                    "board_count": r["board_count"],
                    "created_at": r["created_at"],
                }
                for r in active
            ],
            "tv_alert_log": [dict(x) for x in logs],
            "tv_alert_last_tick_ts": self._last_tick_ts,
        }
