"""检查归档是否已存在."""

from __future__ import annotations

import re
from pathlib import Path

_ID_RE = re.compile(r"^[\w-]{11}$")


def archive_exists(archives_dir: Path, video_id: str) -> bool:
    if not _ID_RE.match(video_id):
        return False
    return (archives_dir / f"{video_id}.md").is_file() and (archives_dir / f"{video_id}.json").is_file()
