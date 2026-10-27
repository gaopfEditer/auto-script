"""拉取 + 解析 + 可选归档."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .archive import build_archive_payload, write_archive_files
from .cdp_client import CdpTranscriptClient
from .parse_transcript import parse_transcript_markdown


class TranscriptFetcher:
    def __init__(self, client: CdpTranscriptClient, archives_dir: Path, log: logging.Logger) -> None:
        self.client = client
        self.archives_dir = archives_dir
        self.log = log

    async def fetch_and_archive(self, video_id: str, lang: str | None = None) -> dict[str, Any]:
        if not self.client.ready:
            raise RuntimeError("CDP 未就绪，请确认 Chrome 已开启 remote debugging")
        markdown = await self.client.fetch_transcript_text(video_id, lang)
        parsed = parse_transcript_markdown(markdown, video_id)
        archive = build_archive_payload(parsed, video_id, lang)
        saved = write_archive_files(self.archives_dir, video_id, archive)
        self.log.info("已归档 %s → %s", video_id, saved["mdPath"])
        return {
            "videoId": video_id,
            "title": archive.meta["title"],
            "sourceUrl": archive.meta["sourceUrl"],
            "languageLine": archive.meta["languageLine"],
            "charCount": archive.meta["charCount"],
            "wordCount": archive.meta["wordCount"],
            "saved": saved,
        }

    async def fetch_transcript(
        self, video_id: str, lang: str | None = None, save: bool = False
    ) -> dict[str, Any]:
        if not self.client.ready:
            raise RuntimeError("CDP 未就绪，请确认 Chrome 已开启 remote debugging")
        markdown = await self.client.fetch_transcript_text(video_id, lang)
        parsed = parse_transcript_markdown(markdown, video_id)
        archive = build_archive_payload(parsed, video_id, lang)
        saved = None
        if save:
            saved = write_archive_files(self.archives_dir, video_id, archive)
            self.log.info("已归档 %s → %s", video_id, saved["mdPath"])
        return {
            "videoId": video_id,
            "title": archive.meta["title"],
            "sourceUrl": archive.meta["sourceUrl"],
            "languageLine": archive.meta["languageLine"],
            "charCount": archive.meta["charCount"],
            "wordCount": archive.meta["wordCount"],
            "transcript": parsed.transcript,
            "saved": saved,
        }
