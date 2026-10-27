"""Shared SQLite helpers: WAL + NORMAL sync to cut SSD wear."""
from __future__ import annotations

import sqlite3
from pathlib import Path


def connect(path: str | Path, timeout: float = 30.0) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=timeout)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn
