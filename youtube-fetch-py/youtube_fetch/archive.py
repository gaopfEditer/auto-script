"""本地归档 .md + .json."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .parse_transcript import ParsedTranscript


def strip_bom(raw: str) -> str:
    return raw[1:] if raw and ord(raw[0]) == 0xFEFF else raw


def word_count_from_language_line(language_line: str | None) -> int | None:
    m = re.search(r"Words:\s*(\d+)", str(language_line or ""), re.I)
    return int(m.group(1)) if m else None


@dataclass
class ArchivePayload:
    md: str
    meta: dict[str, Any]


def build_archive_payload(parsed: ParsedTranscript, video_id: str, lang: str | None) -> ArchivePayload:
    title = (parsed.title or video_id).removeprefix("Transcript:").strip()
    fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    transcript = (parsed.transcript or "").strip()
    language_line = parsed.language_line

    md = "\n".join(
        [
            f"# {title}",
            "",
            f"Source: {parsed.source_url}",
            f"Language: {language_line}" if language_line else "Language: —",
            f"Fetched: {fetched_at}",
            "",
            "## Transcript",
            "",
            transcript,
            "",
        ]
    )

    meta = {
        "videoId": video_id,
        "title": title,
        "sourceUrl": parsed.source_url,
        "languageLine": language_line,
        "lang": lang,
        "fetchedAt": fetched_at,
        "charCount": len(transcript),
        "wordCount": word_count_from_language_line(language_line),
    }
    return ArchivePayload(md=md, meta=meta)


def write_archive_files(archives_dir: Path, video_id: str, payload: ArchivePayload) -> dict[str, str]:
    archives_dir.mkdir(parents=True, exist_ok=True)
    md_path = archives_dir / f"{video_id}.md"
    json_path = archives_dir / f"{video_id}.json"
    md_path.write_text(payload.md, encoding="utf-8")
    json_path.write_text(json.dumps(payload.meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"mdPath": str(md_path), "jsonPath": str(json_path)}
