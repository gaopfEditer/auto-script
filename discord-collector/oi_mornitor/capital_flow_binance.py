"""币安 U 本位 REST：与现有代码一致的 FAPI 基址回退链。"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

import aiohttp

from oi_mornitor import http_backoff
from oi_mornitor.capital_flow_config import CF_FAPI_FALLBACK_BASES
from oi_mornitor.config import FAPI_BASE_URL, HTTP_TIMEOUT_SEC


def iter_fapi_bases(primary: str | None = None) -> list[str]:
    """fapi.binance.com → www.binance.com（路径仍为 /fapi/v1/... 或 /futures/data/...）。"""
    out: list[str] = []
    for b in (primary, FAPI_BASE_URL, *CF_FAPI_FALLBACK_BASES):
        if not b:
            continue
        base = str(b).strip().rstrip("/")
        if base and base not in out:
            out.append(base)
    return out


async def get_json_fapi_chain(
    session: aiohttp.ClientSession,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    primary_base: str | None = None,
    label: str = "cf-fapi",
    max_attempts: int = 2,
) -> tuple[int, Any, str]:
    """
    按基址链请求；返回 (status, data, base_used)。
    path 以 / 开头，如 /fapi/v1/fundingRate 或 /futures/data/openInterestHist。
    """
    if not path.startswith("/"):
        path = "/" + path
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT_SEC)
    last_status = 0
    last_data: Any = None
    for base in iter_fapi_bases(primary_base):
        if http_backoff.is_cooling() and "binance.com" in base:
            continue
        url = f"{base.rstrip('/')}{path}"
        if params:
            url = f"{url}?{urlencode(params)}"
        status, data = await http_backoff.get_json(
            session,
            url,
            timeout=timeout,
            max_attempts=max_attempts,
            label=f"{label}:{base}",
        )
        last_status, last_data = status, data
        if status == 200 and data is not None:
            return status, data, base
        if status in (451, 418, 429) and http_backoff.is_cooling():
            continue
    return last_status, last_data, ""
