"""币安永续 WebSocket：K 线、持仓量、强平流."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import websockets
from websockets.asyncio.client import ClientConnection

from realtime_btc.config import Settings
from realtime_btc.models import Candle, LiquidationEvent

log = logging.getLogger(__name__)

FSTREAM_BASE = "wss://fstream.binance.com"

KlineHandler = Callable[[str, Candle, bool], Awaitable[None] | None]
LiquidationHandler = Callable[[LiquidationEvent], Awaitable[None] | None]
OpenInterestHandler = Callable[[float, int], Awaitable[None] | None]


@dataclass
class WsRuntime:
    last_price: float = 0.0
    open_interest: float = 0.0
    oi_ts_ms: int = 0
    klines: dict[str, Candle] = field(default_factory=dict)
    liquidations: list[LiquidationEvent] = field(default_factory=list)


class BinanceWsClient:
    """多路 WebSocket 订阅管理."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.runtime = WsRuntime()
        self._on_kline: KlineHandler | None = None
        self._on_liquidation: LiquidationHandler | None = None
        self._on_oi: OpenInterestHandler | None = None
        self._tasks: list[asyncio.Task[Any]] = []
        self._stop = asyncio.Event()

    def on_kline(self, handler: KlineHandler) -> None:
        self._on_kline = handler

    def on_liquidation(self, handler: LiquidationHandler) -> None:
        self._on_liquidation = handler

    def on_open_interest(self, handler: OpenInterestHandler) -> None:
        self._on_oi = handler

    def _stream_paths(self) -> list[str]:
        sym = self.settings.ws_symbol_lower
        paths = [f"{sym}@kline_{iv}" for iv in ("5m", "15m", "1h", "4h")]
        paths.append(f"{sym}@openInterest@1s")
        paths.append("!forceOrder@arr")
        return paths

    async def run(self) -> None:
        self._stop.clear()
        self._tasks = [
            asyncio.create_task(self._combined_stream_loop(), name="binance-combined-ws"),
        ]
        await self._stop.wait()

    async def stop(self) -> None:
        self._stop.set()
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    async def _combined_stream_loop(self) -> None:
        streams = "/".join(self._stream_paths())
        url = f"{FSTREAM_BASE}/stream?streams={streams}"
        backoff = 1.0
        connect_kw: dict[str, Any] = {"ping_interval": 20, "ping_timeout": 60}
        if self.settings.proxy_url:
            connect_kw["proxy"] = self.settings.proxy_url
            log.info("WebSocket 使用代理: %s", self.settings.proxy_url)
        while not self._stop.is_set():
            try:
                async with websockets.connect(url, **connect_kw) as ws:
                    log.info("WebSocket 已连接: %s", url[:80] + "...")
                    backoff = 1.0
                    await self._read_loop(ws)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("WebSocket 断开，%ss 后重连: %s", backoff, e)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    async def _read_loop(self, ws: ClientConnection) -> None:
        async for raw in ws:
            if self._stop.is_set():
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            stream = msg.get("stream", "")
            data = msg.get("data", msg)
            if "@kline_" in stream:
                await self._handle_kline(data)
            elif "@openInterest" in stream:
                await self._handle_open_interest(data)
            elif stream == "!forceOrder@arr" or data.get("e") == "forceOrder":
                await self._handle_force_order(data)

    async def _handle_kline(self, data: dict[str, Any]) -> None:
        k = data.get("k") or data
        interval = str(k.get("i", ""))
        candle = Candle(
            ts=int(k["t"]),
            open=float(k["o"]),
            high=float(k["h"]),
            low=float(k["l"]),
            close=float(k["c"]),
            volume=float(k["v"]),
        )
        closed = bool(k.get("x"))
        self.runtime.klines[interval] = candle
        self.runtime.last_price = candle.close
        if self._on_kline:
            await _maybe_await(self._on_kline(interval, candle, closed))

    async def _handle_open_interest(self, data: dict[str, Any]) -> None:
        oi = float(data.get("openInterest", data.get("o", 0)))
        ts = int(data.get("E", data.get("T", time.time() * 1000)))
        self.runtime.open_interest = oi
        self.runtime.oi_ts_ms = ts
        if self._on_oi:
            await _maybe_await(self._on_oi(oi, ts))

    async def _handle_force_order(self, data: dict[str, Any]) -> None:
        o = data.get("o") or data
        sym = str(o.get("s", ""))
        if sym and sym != self.settings.symbol:
            return
        price = float(o.get("p", 0))
        qty = float(o.get("q", 0))
        side = str(o.get("S", ""))
        ts = int(o.get("T", data.get("E", time.time() * 1000)))
        usd = price * qty
        evt = LiquidationEvent(ts_ms=ts, symbol=sym or self.settings.symbol, side=side, price=price, qty=qty, usd=usd)
        self.runtime.liquidations.append(evt)
        # 仅保留最近 5 分钟
        cutoff = int(time.time() * 1000) - 5 * 60_000
        self.runtime.liquidations = [x for x in self.runtime.liquidations if x.ts_ms >= cutoff]
        if self._on_liquidation:
            await _maybe_await(self._on_liquidation(evt))


async def _maybe_await(result: Awaitable[None] | None) -> None:
    if result is not None:
        await result
