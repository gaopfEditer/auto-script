"""图文帖子存储 — SQLite。"""
from __future__ import annotations

import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any


class ContentStore:
    def __init__(self, db_path: Path, uploads_dir: Path) -> None:
        self.db_path = db_path
        self.uploads_dir = uploads_dir
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS posts (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  title TEXT NOT NULL DEFAULT '',
                  body TEXT NOT NULL DEFAULT '',
                  created_at REAL NOT NULL,
                  updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS post_images (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                  filename TEXT NOT NULL,
                  original_name TEXT NOT NULL DEFAULT '',
                  sort_order INTEGER NOT NULL DEFAULT 0,
                  created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_post_images_post
                  ON post_images(post_id, sort_order);
                """
            )

    def _images_for(self, conn: sqlite3.Connection, post_id: int) -> list[dict[str, Any]]:
        rows = conn.execute(
            """
            SELECT id, filename, original_name, sort_order, created_at
            FROM post_images
            WHERE post_id = ?
            ORDER BY sort_order ASC, id ASC
            """,
            (post_id,),
        ).fetchall()
        return [
            {
                "id": int(r["id"]),
                "filename": r["filename"],
                "original_name": r["original_name"],
                "url": f"/api/content/files/{r['filename']}",
                "sort_order": int(r["sort_order"]),
                "created_at": float(r["created_at"]),
            }
            for r in rows
        ]

    def _row_to_post(self, conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        pid = int(row["id"])
        return {
            "id": pid,
            "title": row["title"] or "",
            "body": row["body"] or "",
            "created_at": float(row["created_at"]),
            "updated_at": float(row["updated_at"]),
            "images": self._images_for(conn, pid),
        }

    def list_posts(self, *, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        limit = max(1, min(limit, 200))
        offset = max(0, offset)
        with self._connect() as conn:
            total = int(conn.execute("SELECT COUNT(*) AS c FROM posts").fetchone()["c"])
            rows = conn.execute(
                """
                SELECT id, title, body, created_at, updated_at
                FROM posts
                ORDER BY updated_at DESC, id DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
            items = [self._row_to_post(conn, r) for r in rows]
        return {"total": total, "limit": limit, "offset": offset, "items": items}

    def get_post(self, post_id: int) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id, title, body, created_at, updated_at FROM posts WHERE id = ?",
                (post_id,),
            ).fetchone()
            if not row:
                return None
            return self._row_to_post(conn, row)

    def create_post(self, *, title: str, body: str) -> dict[str, Any]:
        now = time.time()
        with self._connect() as conn:
            cur = conn.execute(
                "INSERT INTO posts (title, body, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (title.strip(), body, now, now),
            )
            pid = int(cur.lastrowid)
            row = conn.execute(
                "SELECT id, title, body, created_at, updated_at FROM posts WHERE id = ?",
                (pid,),
            ).fetchone()
            assert row is not None
            return self._row_to_post(conn, row)

    def update_post(self, post_id: int, *, title: str | None, body: str | None) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id, title, body FROM posts WHERE id = ?", (post_id,)
            ).fetchone()
            if not row:
                return None
            new_title = row["title"] if title is None else title.strip()
            new_body = row["body"] if body is None else body
            now = time.time()
            conn.execute(
                "UPDATE posts SET title = ?, body = ?, updated_at = ? WHERE id = ?",
                (new_title, new_body, now, post_id),
            )
            updated = conn.execute(
                "SELECT id, title, body, created_at, updated_at FROM posts WHERE id = ?",
                (post_id,),
            ).fetchone()
            assert updated is not None
            return self._row_to_post(conn, updated)

    def delete_post(self, post_id: int) -> bool:
        with self._connect() as conn:
            images = self._images_for(conn, post_id)
            cur = conn.execute("DELETE FROM posts WHERE id = ?", (post_id,))
            if cur.rowcount <= 0:
                return False
        for img in images:
            path = self.uploads_dir / img["filename"]
            if path.is_file():
                try:
                    path.unlink()
                except OSError:
                    pass
        return True

    def add_image(
        self,
        post_id: int,
        *,
        data: bytes,
        original_name: str,
        content_type: str = "",
    ) -> dict[str, Any] | None:
        if not self.get_post(post_id):
            return None
        ext = _ext_from_name(original_name, content_type)
        filename = f"{post_id}_{uuid.uuid4().hex[:12]}{ext}"
        dest = self.uploads_dir / filename
        dest.write_bytes(data)
        now = time.time()
        with self._connect() as conn:
            max_ord = conn.execute(
                "SELECT COALESCE(MAX(sort_order), -1) AS m FROM post_images WHERE post_id = ?",
                (post_id,),
            ).fetchone()["m"]
            cur = conn.execute(
                """
                INSERT INTO post_images (post_id, filename, original_name, sort_order, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (post_id, filename, original_name or filename, int(max_ord) + 1, now),
            )
            conn.execute(
                "UPDATE posts SET updated_at = ? WHERE id = ?",
                (now, post_id),
            )
            img_id = int(cur.lastrowid)
        return {
            "id": img_id,
            "filename": filename,
            "original_name": original_name or filename,
            "url": f"/api/content/files/{filename}",
            "sort_order": int(max_ord) + 1,
            "created_at": now,
        }

    def delete_image(self, image_id: int) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id, post_id, filename FROM post_images WHERE id = ?",
                (image_id,),
            ).fetchone()
            if not row:
                return False
            filename = row["filename"]
            post_id = int(row["post_id"])
            conn.execute("DELETE FROM post_images WHERE id = ?", (image_id,))
            conn.execute(
                "UPDATE posts SET updated_at = ? WHERE id = ?",
                (time.time(), post_id),
            )
        path = self.uploads_dir / filename
        if path.is_file():
            try:
                path.unlink()
            except OSError:
                pass
        return True

    def resolve_file(self, filename: str) -> Path | None:
        # 防路径穿越
        name = Path(filename).name
        if name != filename or ".." in filename:
            return None
        path = self.uploads_dir / name
        if not path.is_file():
            return None
        return path


def _ext_from_name(name: str, content_type: str) -> str:
    lower = (name or "").lower()
    for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"):
        if lower.endswith(ext):
            return ".jpg" if ext == ".jpeg" else ext
    ct = (content_type or "").lower()
    if "png" in ct:
        return ".png"
    if "gif" in ct:
        return ".gif"
    if "webp" in ct:
        return ".webp"
    return ".jpg"
