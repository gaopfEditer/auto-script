"""解析 youtube-transcript.ai 返回的 Markdown."""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class ParsedTranscript:
    video_id: str
    title: str | None
    source_url: str
    language_line: str | None
    transcript: str
    raw: str


def parse_transcript_markdown(raw: str, video_id: str) -> ParsedTranscript:
    text = str(raw or "")
    title_m = re.search(r"^#\s*Transcript:\s*(.+)$", text, re.MULTILINE)
    source_m = re.search(r"^Source video:\s*(.+)$", text, re.MULTILINE)
    lang_m = re.search(r"^Language:\s*(.+)$", text, re.MULTILINE)
    marker = "\n## Transcript\n"
    idx = text.find(marker)
    transcript = text[idx + len(marker) :].strip() if idx >= 0 else text.strip()

    return ParsedTranscript(
        video_id=video_id,
        title=title_m.group(1).strip() if title_m else None,
        source_url=source_m.group(1).strip() if source_m else f"https://www.youtube.com/watch?v={video_id}",
        language_line=lang_m.group(1).strip() if lang_m else None,
        transcript=transcript,
        raw=text,
    )
