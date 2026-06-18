#!/usr/bin/env python3
"""币安 BTC 实时交易辅助系统 — 入口."""

from __future__ import annotations

import asyncio
import logging
import sys

from realtime_btc.config import load_settings
from realtime_btc.orchestrator import TradingSystemOrchestrator


def setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


async def main() -> None:
    settings = load_settings()
    setup_logging(settings.log_level)
    orch = TradingSystemOrchestrator(settings)
    await orch.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n已退出", file=sys.stderr)
