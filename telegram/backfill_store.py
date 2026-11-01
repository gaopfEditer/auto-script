"""
Telegram 回溯本地存储：消息去重、覆盖区间、建卡结果持久化（增量拉取 / 窗口聚合）。
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DEFAULT_CACHE = ROOT / ".backfill_cache"
MESSAGES_DIR_NAME = "messages_db"
COVERAGE_FILE = "coverage.json"


def _ms(dt: datetime) -> int:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _merge_ranges(ranges: list[list[int]]) -> list[list[int]]:
    if not ranges:
        return []
    sorted_r = sorted((int(a), int(b)) for a, b in ranges if int(b) >= int(a))
    if not sorted_r:
        return []
    out: list[list[int]] = [[sorted_r[0][0], sorted_r[0][1]]]
    for a, b in sorted_r[1:]:
        last = out[-1]
        if a <= last[1] + 1:
            last[1] = max(last[1], b)
        else:
            out.append([a, b])
    return out


def gaps_in_range(covered: list[list[int]], start_ms: int, end_ms: int) -> list[tuple[int, int]]:
    """返回 [start_ms,end_ms] 内未被 covered 覆盖的子区间。"""
    if start_ms > end_ms:
        return []
    merged = _merge_ranges(covered)
    if not merged:
        return [(start_ms, end_ms)]
    gaps: list[tuple[int, int]] = []
    cur = start_ms
    for a, b in merged:
        if b < cur:
            continue
        if a > end_ms:
            break
        if a > cur:
            gaps.append((cur, min(a - 1, end_ms)))
        cur = max(cur, b + 1)
    if cur <= end_ms:
        gaps.append((cur, end_ms))
    return gaps


@dataclass
class FetchStats:
    gaps: int = 0
    fetched_new: int = 0
    skipped_existing: int = 0
    telethon_calls: int = 0


class BackfillStore:
    def __init__(self, cache_dir: Path | None = None) -> None:
        self.cache_dir = cache_dir or DEFAULT_CACHE
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.messages_dir = self.cache_dir / MESSAGES_DIR_NAME
        self.messages_dir.mkdir(parents=True, exist_ok=True)
        self.coverage_path = self.cache_dir / COVERAGE_FILE
        self._coverage = self._load_coverage()

    def _load_coverage(self) -> dict[str, Any]:
        if not self.coverage_path.is_file():
            return {"chats": {}}
        try:
            raw = json.loads(self.coverage_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and isinstance(raw.get("chats"), dict):
                return raw
        except json.JSONDecodeError:
            pass
        return {"chats": {}}

    def _save_coverage(self) -> None:
        self.coverage_path.write_text(
            json.dumps(self._coverage, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _chat_cov(self, chat_id: str) -> dict[str, Any]:
        chats = self._coverage.setdefault("chats", {})
        key = str(chat_id)
        row = chats.get(key)
        if not isinstance(row, dict):
            row = {"ranges": [], "minMsgId": None, "maxMsgId": None}
            chats[key] = row
        if not isinstance(row.get("ranges"), list):
            row["ranges"] = []
        return row

    def coverage_for(self, chat_id: str) -> dict[str, Any]:
        return dict(self._chat_cov(chat_id))

    def add_coverage_range(self, chat_id: str, start_ms: int, end_ms: int) -> None:
        cov = self._chat_cov(chat_id)
        ranges = cov.get("ranges") or []
        if not isinstance(ranges, list):
            ranges = []
        ranges.append([int(start_ms), int(end_ms)])
        cov["ranges"] = _merge_ranges(ranges)
        cov["lastFetchAt"] = datetime.now(timezone.utc).isoformat()
        self._save_coverage()

    def gaps_for_window(self, chat_id: str, start_ms: int, end_ms: int) -> list[tuple[int, int]]:
        cov = self._chat_cov(chat_id)
        ranges = cov.get("ranges") or []
        if not isinstance(ranges, list):
            ranges = []
        return gaps_in_range(ranges, start_ms, end_ms)

    def _db_path(self, chat_id: str) -> Path:
        safe = str(chat_id).lstrip("-")
        return self.messages_dir / f"{safe}.sqlite"

    def _connect(self, chat_id: str) -> sqlite3.Connection:
        path = self._db_path(chat_id)
        conn = sqlite3.connect(path, timeout=60)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
              msg_id INTEGER NOT NULL,
              ts_ms INTEGER NOT NULL,
              sender TEXT NOT NULL DEFAULT '',
              text TEXT NOT NULL DEFAULT '',
              PRIMARY KEY (msg_id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cards (
              digest TEXT NOT NULL PRIMARY KEY,
              msg_id INTEGER,
              ts_ms INTEGER,
              card_json TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS replay_state (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              last_msg_id INTEGER NOT NULL DEFAULT 0,
              digest_json TEXT NOT NULL DEFAULT '[]'
            )
            """
        )
        conn.execute(
            "INSERT OR IGNORE INTO replay_state (id, last_msg_id, digest_json) VALUES (1, 0, '[]')"
        )
        conn.commit()
        return conn

    def has_message(self, chat_id: str, msg_id: int) -> bool:
        conn = self._connect(chat_id)
        try:
            row = conn.execute(
                "SELECT 1 FROM messages WHERE msg_id = ? LIMIT 1", (int(msg_id),)
            ).fetchone()
            return row is not None
        finally:
            conn.close()

    def upsert_message(self, chat_id: str, msg_id: int, ts_ms: int, sender: str, text: str) -> bool:
        """Returns True if inserted new row."""
        conn = self._connect(chat_id)
        try:
            cur = conn.execute(
                """
                INSERT INTO messages (msg_id, ts_ms, sender, text)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(msg_id) DO NOTHING
                """,
                (int(msg_id), int(ts_ms), sender or "", text or ""),
            )
            conn.commit()
            if cur.rowcount > 0:
                cov = self._chat_cov(chat_id)
                mn = cov.get("minMsgId")
                mx = cov.get("maxMsgId")
                mid = int(msg_id)
                if mn is None or mid < int(mn):
                    cov["minMsgId"] = mid
                if mx is None or mid > int(mx):
                    cov["maxMsgId"] = mid
                self._save_coverage()
                return True
            return False
        finally:
            conn.close()

    def list_messages_in_window(
        self, chat_id: str, start_ms: int, end_ms: int, *, limit: int = 50000
    ) -> list[tuple[int, str, str, datetime]]:
        conn = self._connect(chat_id)
        try:
            rows = conn.execute(
                """
                SELECT msg_id, ts_ms, sender, text FROM messages
                WHERE ts_ms >= ? AND ts_ms <= ?
                ORDER BY ts_ms ASC, msg_id ASC
                LIMIT ?
                """,
                (int(start_ms), int(end_ms), int(limit)),
            ).fetchall()
        finally:
            conn.close()
        out: list[tuple[int, str, str, datetime]] = []
        for msg_id, ts_ms, sender, text in rows:
            dt = datetime.fromtimestamp(int(ts_ms) / 1000, tz=timezone.utc)
            out.append((int(msg_id), str(sender or ""), str(text or ""), dt))
        return out

    def load_replay_state(self, chat_id: str) -> tuple[int, set[str]]:
        conn = self._connect(chat_id)
        try:
            row = conn.execute(
                "SELECT last_msg_id, digest_json FROM replay_state WHERE id = 1"
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return 0, set()
        last_id = int(row[0] or 0)
        try:
            digests = json.loads(row[1] or "[]")
            dset = {str(x) for x in digests if str(x).strip()}
        except json.JSONDecodeError:
            dset = set()
        return last_id, dset

    def save_replay_state(self, chat_id: str, last_msg_id: int, digests: set[str]) -> None:
        conn = self._connect(chat_id)
        try:
            lst = list(digests)[-800:]
            conn.execute(
                "UPDATE replay_state SET last_msg_id = ?, digest_json = ? WHERE id = 1",
                (int(last_msg_id), json.dumps(lst, ensure_ascii=False)),
            )
            conn.commit()
        finally:
            conn.close()

    def upsert_card(self, chat_id: str, digest: str, card: dict[str, Any], msg_id: int, ts_ms: int) -> None:
        conn = self._connect(chat_id)
        try:
            conn.execute(
                """
                INSERT INTO cards (digest, msg_id, ts_ms, card_json)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(digest) DO UPDATE SET
                  card_json = excluded.card_json,
                  msg_id = excluded.msg_id,
                  ts_ms = excluded.ts_ms
                """,
                (str(digest), int(msg_id), int(ts_ms), json.dumps(card, ensure_ascii=False)),
            )
            conn.commit()
        finally:
            conn.close()

    def list_cards_in_window(
        self, chat_id: str, start_ms: int, end_ms: int, *, limit: int = 2000
    ) -> list[dict[str, Any]]:
        conn = self._connect(chat_id)
        try:
            rows = conn.execute(
                """
                SELECT card_json FROM cards
                WHERE ts_ms >= ? AND ts_ms <= ?
                ORDER BY ts_ms ASC, msg_id ASC
                LIMIT ?
                """,
                (int(start_ms), int(end_ms), int(limit)),
            ).fetchall()
        finally:
            conn.close()
        out: list[dict[str, Any]] = []
        for (raw,) in rows:
            try:
                c = json.loads(raw)
                if isinstance(c, dict):
                    out.append(c)
            except json.JSONDecodeError:
                continue
        return out
