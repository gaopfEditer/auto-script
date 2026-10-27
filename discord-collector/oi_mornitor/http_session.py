"""共享 aiohttp ClientSession：有 HTTPS_PROXY 时强制走代理，不回退直连。"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import aiohttp

from oi_mornitor.config import proxy_url

logger = logging.getLogger("OI_HTTP")

_DEFAULT_HEADERS = {"User-Agent": "oi-mornitor/1.0"}
_DEFAULT_BYBIT = "https://api.bybit.com"


class ProxiedClientSession(aiohttp.ClientSession):
    """每条请求显式带 proxy=，避免 trust_env + NO_PROXY 把 Bybit 改成直连。"""

    def __init__(self, *args: Any, default_proxy: str | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._default_proxy = default_proxy

    async def _request(self, method: str, str_or_url: Any, **kwargs: Any) -> aiohttp.ClientResponse:
        if self._default_proxy and kwargs.get("proxy") is None:
            kwargs["proxy"] = self._default_proxy
        return await super()._request(method, str_or_url, **kwargs)


def make_http_session(*, trust_env: bool = False, default_proxy: str | None = None) -> aiohttp.ClientSession:
    return ProxiedClientSession(
        headers=_DEFAULT_HEADERS,
        trust_env=trust_env,
        default_proxy=default_proxy,
        connector=aiohttp.TCPConnector(limit=20, ttl_dns_cache=300),
    )


async def _probe_reachable(session: aiohttp.ClientSession, base_url: str) -> bool:
    url = f"{base_url.rstrip('/')}/v5/market/time"
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=12)) as resp:
            if resp.status != 200:
                logger.warning("Bybit 探测 HTTP %s", resp.status)
                return False
            data = await resp.json(content_type=None)
            # retCode=0 表示成功；不能写 `or -1`，0 在 Python 里是 falsy
            ret = data.get("retCode") if isinstance(data, dict) else None
            return ret is not None and int(ret) == 0
    except Exception as exc:  # noqa: BLE001
        logger.warning("Bybit 探测失败: %s", exc)
        return False


@asynccontextmanager
async def http_session_with_fallback(
    probe_base_url: str | None = None,
) -> AsyncIterator[aiohttp.ClientSession]:
    """有 HTTPS_PROXY 时始终走代理。国内直连 api.bybit.com 会被 RST，探测失败不改直连。"""
    base = (probe_base_url or _DEFAULT_BYBIT).rstrip("/")
    session: aiohttp.ClientSession | None = None
    try:
        px = proxy_url()
        if px:
            session = make_http_session(trust_env=False, default_proxy=px)
            ok = False
            for attempt in range(1, 4):
                if await _probe_reachable(session, base):
                    ok = True
                    logger.info("Bybit 经代理可达 (%s)，第 %d 次探测成功", px, attempt)
                    break
                await asyncio.sleep(0.4 * attempt)
            if not ok:
                await session.close()
                session = None
                raise RuntimeError(
                    f"HTTPS_PROXY={px} 探测 Bybit {base}/v5/market/time 失败"
                    "（未改直连，直连会被墙）。请确认 Clash HTTP 端口可用后再拉 K 线。"
                )
        else:
            session = make_http_session(trust_env=False)
            logger.warning("未设置 HTTPS_PROXY，Bybit 将直连（国内通常会失败）")
        yield session
    finally:
        if session is not None and not session.closed:
            await session.close()
