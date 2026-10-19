"""币安 forceOrder 全市场强平流 → capital_flow_store。"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import aiohttp

from oi_mornitor.capital_flow_config import CF_ENABLED
from oi_mornitor.capital_flow_store import record_liquidation
from oi_mornitor.config import FSTREAM_WS_BASE

logger = logging.getLogger(__name__)

_WS_URL = f"{FSTREAM_WS_BASE.rstrip('/')}/ws/!forceOrder@arr"


async def run_liquidation_ws(stop_event: asyncio.Event | None = None) -> None:
    if not CF_ENABLED:
        return
    backoff = 3.0
    while stop_event is None or not stop_event.is_set():
        try:
            async with aiohttp.ClientSession() as session:
                async with session.ws_connect(_WS_URL, heartbeat=30) as ws:
                    logger.info("强平 WS 已连接 %s", _WS_URL)
                    backoff = 3.0
                    async for msg in ws:
                        if stop_event and stop_event.is_set():
                            break
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            continue
                        try:
                            payload = json.loads(msg.data)
                        except (TypeError, json.JSONDecodeError):
                            continue
                        _ingest_force_order(payload)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("强平 WS 断开: %s · %.0fs 后重连", exc, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 1.6, 60.0)


def _ingest_force_order(payload: Any) -> None:
    if not isinstance(payload, dict):
        return
    data = payload.get("o") if payload.get("e") == "forceOrder" else payload
    if not isinstance(data, dict):
        return
    sym = str(data.get("s") or "").upper()
    try:
        t_ms = int(data.get("T") or data.get("E") or 0)
        price = float((data.get("p") or data.get("ap") or 0))
        qty = float(data.get("q") or data.get("z") or 0)
    except (TypeError, ValueError):
        return
    side = str(data.get("S") or "")
    record_liquidation(
        symbol=sym,
        event_time_ms=t_ms,
        side=side,
        price=price,
        qty=qty,
        raw=data,
    )
