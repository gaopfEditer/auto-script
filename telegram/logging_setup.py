"""Telethon 连接阶段的详细日志（stderr）。"""

from __future__ import annotations

import logging
import os
import sys

# 子 logger 会向上冒泡到 telethon，只需配置这一条即可看到 network / mtprotosender 等
_TELETHON_LOGGER = "telethon"


def setup_telethon_logging() -> None:
    # 默认 INFO：连接成功后大量 DEBUG（Encrypting / Handling RPC）易被误认为报错
    level_name = os.environ.get("TELEGRAM_LOG_LEVEL", "INFO").strip().upper()
    level = getattr(logging, level_name, logging.INFO)

    log = logging.getLogger(_TELETHON_LOGGER)
    log.setLevel(level)
    log.propagate = False

    fmt = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
    handler = logging.StreamHandler(sys.stderr)
    handler.setLevel(level)
    handler.setFormatter(logging.Formatter(fmt, datefmt="%H:%M:%S"))

    log.handlers.clear()
    log.addHandler(handler)
