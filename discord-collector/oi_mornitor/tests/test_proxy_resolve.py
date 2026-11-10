"""代理解析：死 7891、活 7890、缓存 TTL / invalidate，以及 session 跟着有效 URL 走。"""
from __future__ import annotations

import asyncio
import os
import time
import unittest
from unittest import mock

from oi_mornitor.proxy_resolve import (
    invalidate_proxy_cache,
    proxy_endpoint_verified,
    resolve_effective_proxy_url,
)
from oi_mornitor.radar import BinanceOIRadar, RadarService

_PROXY_KEYS = (
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "COMMON_PROXY",
    "BINANCE_PROXY",
)


def _env(**extra: str) -> dict[str, str]:
    base = {key: "" for key in _PROXY_KEYS}
    base.update(
        {
            "OI_PROXY_FALLBACK_PORTS": "7890,7891",
            "OI_PROXY_CACHE_TTL_SEC": "30",
            "OI_PROXY_CACHE_TTL_DEAD_SEC": "5",
        }
    )
    base.update(extra)
    return base


class _Clock:
    def __init__(self, start: float = 1_000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t


class _FakeSession:
    def __init__(self, proxy: str | None) -> None:
        self.proxy = proxy
        self.closed = False

    async def close(self) -> None:
        self.closed = True


def _tcp(open_ports: set[int]):
    def _reach(host: str, port: int, timeout: float = 1.2) -> bool:
        return int(port) in open_ports

    return _reach


class ProxyResolveTests(unittest.TestCase):
    def setUp(self) -> None:
        invalidate_proxy_cache()

    def tearDown(self) -> None:
        invalidate_proxy_cache()

    def test_dead_7891_uses_live_7890(self) -> None:
        with mock.patch.dict(os.environ, _env(HTTPS_PROXY="http://127.0.0.1:7891"), clear=False):
            with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", _tcp({7890})):
                picked = resolve_effective_proxy_url(force_refresh=True)
        self.assertEqual(picked, "http://127.0.0.1:7890")
        self.assertTrue(proxy_endpoint_verified())

    def test_configured_port_wins_when_it_is_open(self) -> None:
        with mock.patch.dict(os.environ, _env(HTTPS_PROXY="http://127.0.0.1:7891"), clear=False):
            with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", _tcp({7890, 7891})):
                picked = resolve_effective_proxy_url(force_refresh=True)
        self.assertEqual(picked, "http://127.0.0.1:7891")
        self.assertTrue(proxy_endpoint_verified())

    def test_ok_cache_holds_then_expires(self) -> None:
        clock = _Clock()
        probes = {"n": 0}

        def reach(host: str, port: int, timeout: float = 1.2) -> bool:
            probes["n"] += 1
            return int(port) == 7890

        with mock.patch.dict(os.environ, _env(HTTPS_PROXY="http://127.0.0.1:7891"), clear=False):
            with mock.patch("oi_mornitor.proxy_resolve.time.monotonic", clock):
                with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", reach):
                    self.assertEqual(resolve_effective_proxy_url(force_refresh=True), "http://127.0.0.1:7890")
                    probed = probes["n"]
                    self.assertGreater(probed, 0)
                    self.assertEqual(resolve_effective_proxy_url(), "http://127.0.0.1:7890")
                    self.assertEqual(probes["n"], probed)
                    clock.t += 30.1

                    def only_7891(host: str, port: int, timeout: float = 1.2) -> bool:
                        return int(port) == 7891

                    with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", only_7891):
                        self.assertEqual(resolve_effective_proxy_url(), "http://127.0.0.1:7891")
                        self.assertTrue(proxy_endpoint_verified())

    def test_dead_cache_is_short_and_picks_up_7890(self) -> None:
        clock = _Clock()
        with mock.patch.dict(os.environ, _env(HTTPS_PROXY="http://127.0.0.1:7891"), clear=False):
            with mock.patch("oi_mornitor.proxy_resolve.time.monotonic", clock):
                with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", _tcp(set())):
                    self.assertEqual(
                        resolve_effective_proxy_url(force_refresh=True),
                        "http://127.0.0.1:7891",
                    )
                    self.assertFalse(proxy_endpoint_verified())
                with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", _tcp({7890})):
                    # 短 TTL 内仍返回上次的死地址，避免每个请求都做 TCP 探测。
                    self.assertEqual(resolve_effective_proxy_url(), "http://127.0.0.1:7891")
                    clock.t += 5.1
                    self.assertEqual(resolve_effective_proxy_url(), "http://127.0.0.1:7890")
                    self.assertTrue(proxy_endpoint_verified())

    def test_invalidate_forces_reprobe(self) -> None:
        with mock.patch.dict(os.environ, _env(HTTPS_PROXY="http://127.0.0.1:7891"), clear=False):
            with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", _tcp({7890})):
                self.assertEqual(resolve_effective_proxy_url(force_refresh=True), "http://127.0.0.1:7890")
            invalidate_proxy_cache()
            with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", _tcp({7891})):
                self.assertEqual(resolve_effective_proxy_url(), "http://127.0.0.1:7891")

    def test_mark_proxy_down_keeps_proxy_when_fallback_is_up(self) -> None:
        radar = BinanceOIRadar()
        with mock.patch.dict(os.environ, _env(HTTPS_PROXY="http://127.0.0.1:7891"), clear=False):
            with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", _tcp({7890})):
                radar.mark_proxy_down("pool_empty")
                self.assertFalse(radar.proxy_disabled())
                self.assertEqual(resolve_effective_proxy_url(), "http://127.0.0.1:7890")
            with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", _tcp(set())):
                radar.mark_proxy_down("pool_empty", cooldown_sec=120)
                self.assertTrue(radar.proxy_disabled())
                self.assertGreater(radar._proxy_disabled_until, time.time())


class _RadarProxyHarness(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        invalidate_proxy_cache()

    def tearDown(self) -> None:
        invalidate_proxy_cache()

    def _service(self) -> RadarService:
        svc = RadarService.__new__(RadarService)
        svc._session = None
        svc._session_proxy = None
        svc.radar = BinanceOIRadar()
        return svc

    async def test_direct_cooldown_resumes_when_fallback_is_up(self) -> None:
        svc = self._service()
        svc.radar._proxy_disabled_until = time.time() + 600

        def make(*, trust_env: bool = False, default_proxy: str | None = None) -> _FakeSession:
            return _FakeSession(default_proxy)

        with mock.patch.dict(
            os.environ,
            _env(HTTPS_PROXY="http://127.0.0.1:7891", OI_PROXY_CACHE_TTL_DEAD_SEC="60"),
            clear=False,
        ):
            with mock.patch("oi_mornitor.http_session.make_http_session", make):
                with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", _tcp(set())):
                    direct = await svc._ensure_session()
                self.assertIsNone(direct.proxy)
                self.assertTrue(svc.radar.proxy_disabled())
                with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", _tcp({7890})):
                    # 死缓存还在 TTL 内时不会误判端口已恢复。
                    still = await svc._ensure_session()
                    self.assertIs(still, direct)
                    invalidate_proxy_cache()
                    resumed = await svc._ensure_session()
        self.assertFalse(svc.radar.proxy_disabled())
        self.assertEqual(resumed.proxy, "http://127.0.0.1:7890")
        self.assertTrue(direct.closed)

    async def test_session_rebuilds_when_proxy_url_changes(self) -> None:
        svc = self._service()
        created: list[_FakeSession] = []

        def make(*, trust_env: bool = False, default_proxy: str | None = None) -> _FakeSession:
            sess = _FakeSession(default_proxy)
            created.append(sess)
            return sess

        urls = [
            "http://127.0.0.1:7891",
            "http://127.0.0.1:7891",
            "http://127.0.0.1:7890",
        ]
        with mock.patch("oi_mornitor.http_session.make_http_session", make):
            with mock.patch("oi_mornitor.radar.proxy_url", side_effect=urls):
                first = await svc._ensure_session()
                second = await svc._ensure_session()
                third = await svc._ensure_session()
        self.assertIs(first, second)
        self.assertEqual(first.proxy, "http://127.0.0.1:7891")
        self.assertIsNot(third, first)
        self.assertTrue(first.closed)
        self.assertEqual(third.proxy, "http://127.0.0.1:7890")
        self.assertEqual(svc._session_proxy, "http://127.0.0.1:7890")

    async def test_open_session_refreshes_before_connect(self) -> None:
        """缓存里若还是死 7891，启动必须先探测再连，不能先建 7891 session。"""
        svc = self._service()
        svc.radar._proxy_disabled_until = time.time() + 600
        stale = _FakeSession("http://127.0.0.1:7891")
        svc._session = stale
        svc._session_proxy = stale.proxy
        created: list[_FakeSession] = []

        def make(*, trust_env: bool = False, default_proxy: str | None = None) -> _FakeSession:
            sess = _FakeSession(default_proxy)
            created.append(sess)
            return sess

        ports = {7891}

        def reach(host: str, port: int, timeout: float = 1.2) -> bool:
            return int(port) in ports

        with mock.patch.dict(os.environ, _env(HTTPS_PROXY="http://127.0.0.1:7891"), clear=False):
            with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", reach):
                self.assertEqual(resolve_effective_proxy_url(force_refresh=True), "http://127.0.0.1:7891")
                ports.clear()
                ports.add(7890)
                with mock.patch("oi_mornitor.http_session.make_http_session", make):
                    await svc._open_session_with_fresh_proxy()
        self.assertEqual([item.proxy for item in created], ["http://127.0.0.1:7890"])
        self.assertTrue(stale.closed)
        self.assertFalse(svc.radar.proxy_disabled())
        self.assertEqual(svc._session_proxy, "http://127.0.0.1:7890")

    async def test_scan_once_recovers_when_session_closed(self) -> None:
        svc = self._service()

        async def boom(_session: object) -> list[dict]:
            raise RuntimeError("Session is closed")

        svc.radar.scan = boom  # type: ignore[method-assign]
        svc._ensure_session = mock.AsyncMock(return_value=object())  # type: ignore[method-assign]
        reasons: list[str] = []

        async def recover(reason: str) -> None:
            reasons.append(reason)

        svc._recover_after_stuck_scan = recover  # type: ignore[method-assign]
        out = await svc.scan_once()
        self.assertEqual(out, [])
        self.assertEqual(reasons, ["Session is closed"])

    async def test_scan_once_times_out_and_recovers(self) -> None:
        svc = self._service()

        async def hang(_session: object) -> list[dict]:
            await asyncio.sleep(30)

        svc.radar.scan = hang  # type: ignore[method-assign]
        svc._ensure_session = mock.AsyncMock(return_value=object())  # type: ignore[method-assign]
        svc._radar_scan_timeout_sec = lambda: 0.05  # type: ignore[method-assign]
        reasons: list[str] = []

        async def recover(reason: str) -> None:
            reasons.append(reason)

        svc._recover_after_stuck_scan = recover  # type: ignore[method-assign]
        out = await svc.scan_once()
        self.assertEqual(out, [])
        self.assertTrue(reasons and "超时" in reasons[0])

    async def test_background_loop_survives_hung_scan_and_closed_session(self) -> None:
        svc = self._service()
        svc._running = True
        svc._scan_timeout_sec = lambda: 0.05  # type: ignore[method-assign]
        reasons: list[str] = []

        async def recover(reason: str) -> None:
            reasons.append(reason)

        svc._recover_after_stuck_scan = recover  # type: ignore[method-assign]
        state = {"n": 0}

        async def scan_once() -> list[dict]:
            state["n"] += 1
            if state["n"] == 1:
                await asyncio.sleep(30)
            if state["n"] == 2:
                raise RuntimeError("Session is closed")
            svc._running = False
            return []

        svc.scan_once = scan_once  # type: ignore[method-assign]
        with mock.patch("oi_mornitor.radar._SCAN_RETRY_SLEEP_SEC", 0):
            await svc._loop(0)
        self.assertEqual(state["n"], 3)
        self.assertEqual(len(reasons), 2)
        self.assertIn("超时", reasons[0])
        self.assertIn("Session is closed", reasons[1])

    async def test_background_loop_does_not_drop_session_on_unrelated_error(self) -> None:
        svc = self._service()
        svc._running = True
        reasons: list[str] = []

        async def recover(reason: str) -> None:
            reasons.append(reason)

        svc._recover_after_stuck_scan = recover  # type: ignore[method-assign]
        state = {"n": 0}

        async def scan_once() -> list[dict]:
            state["n"] += 1
            if state["n"] == 1:
                raise RuntimeError("pool parse failed")
            svc._running = False
            return []

        svc.scan_once = scan_once  # type: ignore[method-assign]
        with mock.patch("oi_mornitor.radar._SCAN_RETRY_SLEEP_SEC", 0):
            await svc._loop(0)
        self.assertEqual(state["n"], 2)
        self.assertEqual(reasons, [])
