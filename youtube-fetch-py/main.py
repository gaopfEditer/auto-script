#!/usr/bin/env python3
"""youtube-fetch Python 版入口."""

from __future__ import annotations

import uvicorn

from youtube_fetch.config import load_settings


def main() -> None:
    s = load_settings()
    uvicorn.run(
        "youtube_fetch.server:app",
        host="127.0.0.1",
        port=s.port,
        log_level=s.log_level,
    )


if __name__ == "__main__":
    main()
