"""简单日志."""

from __future__ import annotations

import logging
import sys

_LEVEL = logging.INFO


def set_log_level(level: str) -> None:
    global _LEVEL
    _LEVEL = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(
        level=_LEVEL,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
        force=True,
    )


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
