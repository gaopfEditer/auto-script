"""解析可用的本地 HTTP 代理（兼容 Clash 7890 / 7891 等常见端口）。"""
from __future__ import annotations

import logging
import os
import socket
from urllib.parse import urlparse, urlunparse

logger = logging.getLogger("OI_HTTP")

_UNSET = object()
_cached: str | None | object = _UNSET


def _fallback_ports() -> tuple[int, ...]:
    raw = (os.getenv("OI_PROXY_FALLBACK_PORTS") or "7890,7891").strip()
    out: list[int] = []
    for part in raw.split(","):
        p = part.strip()
        if not p:
            continue
        try:
            out.append(int(p))
        except ValueError:
            continue
    return tuple(out) or (7890, 7891)


def _proxy_from_env() -> str | None:
    for key in (
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "COMMON_PROXY",
        "BINANCE_PROXY",
    ):
        v = (os.getenv(key) or "").strip()
        if v:
            return v
    return None


def _tcp_reachable(host: str, port: int, timeout: float = 1.2) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _local_proxy_url(host: str, port: int) -> str:
    return f"http://{host}:{port}"


def _first_open_local_port(host: str = "127.0.0.1") -> int | None:
    for port in _fallback_ports():
        if _tcp_reachable(host, port):
            return port
    return None


def invalidate_proxy_cache() -> None:
    global _cached
    _cached = _UNSET


def resolve_effective_proxy_url(*, force_refresh: bool = False) -> str | None:
    """返回当前进程应使用的代理 URL（缓存；端口不可达时尝试 7890/7891 互备）。"""
    global _cached
    if not force_refresh and _cached is not _UNSET:
        return _cached  # type: ignore[return-value]

    configured = _proxy_from_env()
    if not configured:
        port = _first_open_local_port()
        if port is not None:
            picked = _local_proxy_url("127.0.0.1", port)
            logger.info("未配置 HTTPS_PROXY，自动选用本地代理 %s", picked)
            _cached = picked
            return picked
        _cached = None
        return None

    parsed = urlparse(configured)
    scheme = parsed.scheme or "http"
    host = (parsed.hostname or "127.0.0.1").lower()
    port = parsed.port

    if host in ("127.0.0.1", "localhost", "::1"):
        if port is not None and _tcp_reachable(host if host != "::1" else "127.0.0.1", port):
            _cached = configured
            return configured
        open_port = _first_open_local_port("127.0.0.1")
        if open_port is not None:
            picked = urlunparse(
                parsed._replace(scheme=scheme, netloc=f"127.0.0.1:{open_port}")
            )
            if configured != picked:
                logger.warning(
                    "HTTPS_PROXY=%s 不可达，改用 %s（OI_PROXY_FALLBACK_PORTS）",
                    configured,
                    picked,
                )
            _cached = picked
            return picked
        logger.error(
            "HTTPS_PROXY=%s 且本地回退端口 %s 均不可达",
            configured,
            ",".join(str(p) for p in _fallback_ports()),
        )
        _cached = configured
        return configured

    if port is not None and not _tcp_reachable(host, port):
        logger.warning("代理 %s 端口不可达，仍按配置使用", configured)
    _cached = configured
    return configured
