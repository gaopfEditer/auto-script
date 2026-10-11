#!/usr/bin/env python3
"""手动跑一轮潜力发现（慢扫+快扫），不依赖雷达 daemon。"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

import aiohttp

from oi_mornitor.config import FAPI_BASE_URL
from oi_mornitor.potential_discovery_runner import (
    run_potential_discovery_scan,
)
from oi_mornitor.potential_discovery_store import get_discovery_payload
from oi_mornitor.radar import BinanceOIRadar


async def main() -> None:
    radar = BinanceOIRadar()
    async with aiohttp.ClientSession(trust_env=True) as session:
        await radar.scan(session)
    rows = radar.last_all_rows or []
    print(f"池子行数: {len(rows)}")
    async with aiohttp.ClientSession(trust_env=True) as session:
        cands = await run_potential_discovery_scan(
            session,
            pool_rows=rows,
            base_url=radar.base_url,
        )
    payload = get_discovery_payload()
    print(
        f"完成：candidates={len(cands)} · "
        f"updated={payload.get('updated_utc8')} · "
        f"fast={payload.get('fast_scan_at_utc8')} · "
        f"slow={payload.get('slow_scan_at_utc8')}"
    )
    if not cands:
        print("仍为空：看日志「跳过原因」；需 OI 雷达有 pool 且第三梯队小币能过预筛。")


if __name__ == "__main__":
    asyncio.run(main())
