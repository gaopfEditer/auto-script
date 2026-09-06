#!/usr/bin/env python3
"""入口：python news_mornitor/run.py web [--port 8770]"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    p = argparse.ArgumentParser(prog="news_mornitor")
    p.add_argument("cmd", nargs="?", default="web", choices=["web", "once"])
    p.add_argument("--host", default=None)
    p.add_argument("--port", type=int, default=None)
    args = p.parse_args(argv)

    if args.cmd == "once":
        import asyncio

        from news_mornitor.server import refresh_all

        print(asyncio.run(refresh_all(force=True)))
        return 0

    from news_mornitor.server import main as serve
    from news_mornitor.settings import HOST, PORT

    serve(host=args.host or HOST, port=args.port or PORT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
