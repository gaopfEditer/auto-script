#!/usr/bin/env python3
"""命令行单次拉取（无需启动 HTTP 服务）."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from youtube_fetch.cdp_client import CdpTranscriptClient
from youtube_fetch.config import load_settings
from youtube_fetch.fetch_transcript import TranscriptFetcher
from youtube_fetch.logger import get_logger, set_log_level
from youtube_fetch.video_id import parse_youtube_video_id


async def run(url: str, lang: str | None, save: bool, raw: bool) -> int:
    settings = load_settings()
    set_log_level(settings.log_level)
    log = get_logger("cli")
    client = CdpTranscriptClient(
        settings.cdp_connect_url,
        settings.transcript_site,
        settings.fetch_timeout_ms,
        get_logger("cdp"),
    )
    await client.connect()
    fetcher = TranscriptFetcher(client, settings.archives_dir, log)
    video_id = parse_youtube_video_id(url)
    if not video_id:
        print(json.dumps({"ok": False, "error": "无法解析 video id"}, ensure_ascii=False))
        return 1
    try:
        if raw:
            text = await client.fetch_transcript_text(video_id, lang)
            print(text)
        else:
            out = await fetcher.fetch_transcript(video_id, lang, save)
            print(json.dumps({"ok": True, **out}, ensure_ascii=False, indent=2))
    finally:
        await client.close()
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="拉取 YouTube 文字稿")
    parser.add_argument("url", help="YouTube URL 或 video id")
    parser.add_argument("--lang", default=None)
    parser.add_argument("--save", action="store_true", help="写入 archives/")
    parser.add_argument("--raw", action="store_true", help="输出原始 Markdown")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(run(args.url, args.lang, args.save, args.raw)))


if __name__ == "__main__":
    main()
