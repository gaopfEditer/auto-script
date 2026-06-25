"""YouTube URL → video id."""

from __future__ import annotations

import re
from urllib.parse import urlparse, parse_qs

_ID_RE = re.compile(r"^[\w-]{11}$")
_EMBED_RE = re.compile(r"(?:v=|/embed/|/shorts/|youtu\.be/)([\w-]{11})")


def parse_youtube_video_id(input_str: str | None) -> str | None:
    raw = str(input_str or "").strip()
    if not raw:
        return None
    if _ID_RE.match(raw):
        return raw

    try:
        url = urlparse(raw if "://" in raw else f"https://{raw}")
    except ValueError:
        m = _EMBED_RE.search(raw)
        return m.group(1) if m else None

    host = (url.hostname or "").removeprefix("www.")
    if host == "youtu.be":
        part = url.path.lstrip("/").split("/")[0]
        return part if _ID_RE.match(part) else None

    if host in ("youtube.com", "m.youtube.com", "music.youtube.com"):
        v = parse_qs(url.query).get("v", [None])[0]
        if v and _ID_RE.match(v):
            return v
        parts = [p for p in url.path.split("/") if p]
        for key in ("shorts", "embed"):
            if key in parts:
                idx = parts.index(key)
                if idx + 1 < len(parts) and _ID_RE.match(parts[idx + 1]):
                    return parts[idx + 1]
    return None
