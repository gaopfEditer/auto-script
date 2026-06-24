"""环境变量配置."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parents[1]
_REPO = _ROOT.parent
load_dotenv(_REPO / ".env")
load_dotenv(_ROOT / ".env")


def _normalize_cdp_url(raw: str | None) -> str:
    s = (raw or "").strip() or "http://127.0.0.1:9222"
    return s.rstrip("/")


@dataclass(frozen=True)
class Settings:
    cdp_connect_url: str
    port: int
    transcript_site: str
    archives_dir: Path
    fetch_timeout_ms: int
    log_level: str


def load_settings() -> Settings:
    archives_raw = (os.getenv("YOUTUBE_ARCHIVES_DIR") or "youtube-fetch/archives").strip()
    archives_path = Path(archives_raw)
    if not archives_path.is_absolute():
        archives_path = (_REPO / archives_path).resolve()

    return Settings(
        cdp_connect_url=_normalize_cdp_url(os.getenv("CDP_CONNECT_URL")),
        port=int(os.getenv("YOUTUBE_FETCH_PORT", "3921")),
        transcript_site=(os.getenv("YOUTUBE_TRANSCRIPT_SITE") or "https://youtube-transcript.ai").rstrip("/"),
        archives_dir=archives_path,
        fetch_timeout_ms=int(os.getenv("YOUTUBE_FETCH_TIMEOUT_MS", "90000")),
        log_level=(os.getenv("YOUTUBE_FETCH_LOG_LEVEL") or os.getenv("LOG_LEVEL") or "info").lower(),
    )
