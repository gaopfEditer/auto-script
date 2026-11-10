"""解析可用的本地 HTTP 代理（Clash 常见端口 7890–7894，按顺序用第一个可达的）。"""
from __future__ import annotations

import logging
import os
import socket
import time
from dataclasses import dataclass
from urllib.parse import urlparse, urlunparse

logger = logging.getLogger("OI_HTTP")


@dataclass
class _CacheEntry:
    url: str | None
    expires_at: float
    verified: bool


_cached: _CacheEntry | None = None
_switch_logged: tuple[str, str] | None = None
_dead_logged: str | None = None
_auto_logged: str | None = None
_remote_down_logged: str | None = None


def _ttl_ok() -> float:
    raw = (os.getenv("OI_PROXY_CACHE_TTL_SEC") or "30").strip()
    try:
        return max(1.0, float(raw))
    except ValueError:
        return 30.0


def _ttl_dead() -> float:
    """端口全灭时的短缓存。Clash 换端口后必须能重新探测，不能把死地址卡住。"""
    raw = (os.getenv("OI_PROXY_CACHE_TTL_DEAD_SEC") or "5").strip()
    try:
        return max(0.5, float(raw))
    except ValueError:
        return 5.0


# 靠前的端口经常被别的进程占用，所以按顺序继续试后面的。
_DEFAULT_FALLBACK_PORTS: tuple[int, ...] = (7890, 7891, 7892, 7893, 7894)


def _fallback_ports() -> tuple[int, ...]:
    """OI_PROXY_FALLBACK_PORTS 可覆盖；空或非法时用 7890–7894。"""
    raw = (os.getenv("OI_PROXY_FALLBACK_PORTS") or "").strip()
    if not raw:
        return _DEFAULT_FALLBACK_PORTS
    out: list[int] = []
    for part in raw.split(","):
        p = part.strip()
        if not p:
            continue
        try:
            out.append(int(p))
        except ValueError:
            continue
    return tuple(out) or _DEFAULT_FALLBACK_PORTS


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
    _cached = None


def proxy_endpoint_verified() -> bool:
    """最近一次解析是否确认代理端口 TCP 可达。过期缓存视为未确认。"""
    if _cached is None:
        return False
    if time.monotonic() >= _cached.expires_at:
        return False
    return bool(_cached.verified)


def _store(url: str | None, *, verified: bool) -> str | None:
    global _cached, _dead_logged
    ttl = _ttl_ok() if verified else _ttl_dead()
    _cached = _CacheEntry(url=url, expires_at=time.monotonic() + ttl, verified=verified)
    if verified:
        _dead_logged = None
    return url


def _log_switch(configured: str, picked: str) -> None:
    global _switch_logged
    key = (configured, picked)
    if _switch_logged == key:
        return
    _switch_logged = key
    logger.warning(
        "HTTPS_PROXY=%s 不可达，改用 %s（OI_PROXY_FALLBACK_PORTS）",
        configured,
        picked,
    )


def _log_all_dead(configured: str) -> None:
    global _dead_logged
    if _dead_logged == configured:
        return
    _dead_logged = configured
    logger.error(
        "HTTPS_PROXY=%s 且本地回退端口 %s 均不可达",
        configured,
        ",".join(str(p) for p in _fallback_ports()),
    )


def _probe_host(host: str) -> str:
    if host in ("localhost", "::1"):
        return "127.0.0.1"
    return host


def resolve_effective_proxy_url(*, force_refresh: bool = False) -> str | None:
    """返回当前进程应使用的代理 URL。

    本地默认按 7890,7891,7892,7893,7894 顺序互备（可用 ``OI_PROXY_FALLBACK_PORTS`` 覆盖）。
    可达结果缓存 ``OI_PROXY_CACHE_TTL_SEC``（默认 30s）；
    端口全灭时只短缓存死地址（``OI_PROXY_CACHE_TTL_DEAD_SEC``，默认 5s），
    Clash 换到后面的端口后会重新探测，而不是一直停在已经关掉的前面端口。
    全灭时仍返回配置里的 URL（不改成 None），避免调用方在代理其实还在的窗口里改直连。
    """
    now = time.monotonic()
    if not force_refresh and _cached is not None and now < _cached.expires_at:
        return _cached.url

    configured = _proxy_from_env()
    if not configured:
        port = _first_open_local_port()
        if port is not None:
            picked = _local_proxy_url("127.0.0.1", port)
            global _auto_logged
            if _auto_logged != picked:
                _auto_logged = picked
                logger.info("未配置 HTTPS_PROXY，自动选用本地代理 %s", picked)
            return _store(picked, verified=True)
        return _store(None, verified=False)

    parsed = urlparse(configured)
    scheme = parsed.scheme or "http"
    host = (parsed.hostname or "127.0.0.1").lower()
    port = parsed.port

    if host in ("127.0.0.1", "localhost", "::1"):
        local_host = _probe_host(host)
        if port is not None and _tcp_reachable(local_host, port):
            return _store(configured, verified=True)
        open_port = _first_open_local_port("127.0.0.1")
        if open_port is not None:
            picked = urlunparse(
                parsed._replace(scheme=scheme, netloc=f"127.0.0.1:{open_port}")
            )
            if configured != picked:
                _log_switch(configured, picked)
            return _store(picked, verified=True)
        _log_all_dead(configured)
        # 短缓存死配置。下次解析会再按回退端口顺序探测，Clash 换端口后能切走。
        return _store(configured, verified=False)

    probe = _probe_host(host)
    if port is not None and _tcp_reachable(probe, port):
        return _store(configured, verified=True)
    if port is not None:
        global _remote_down_logged
        if _remote_down_logged != configured:
            _remote_down_logged = configured
            logger.warning("代理 %s 端口不可达，仍按配置使用", configured)
    return _store(configured, verified=False)
