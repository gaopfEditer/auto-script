"""Telegram Bot API 兜底必须走解析后的代理，而不是环境里已经关掉的 7891。"""
from __future__ import annotations

import os
import unittest
import urllib.error
from unittest import mock

from oi_mornitor import notify_telegram
from oi_mornitor.proxy_resolve import invalidate_proxy_cache

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

_TOKEN = "unit-test-token-not-real"
_CHAT = "5550011223344"


def _env(**extra: str) -> dict[str, str]:
    base = {key: "" for key in _PROXY_KEYS}
    base.update({"OI_PROXY_FALLBACK_PORTS": "7890,7891"})
    base.update(extra)
    return base


def _proxy_map(handlers: tuple) -> dict[str, str]:
    for handler in handlers:
        proxies = getattr(handler, "proxies", None)
        if isinstance(proxies, dict):
            return dict(proxies)
    return {}


class _OpenerPlan:
    def __init__(self, responses: list) -> None:
        self.responses = list(responses)
        self.handlers: list[tuple] = []

    def build_opener(self, *handlers: object):
        self.handlers.append(tuple(handlers))
        opener = mock.Mock()

        def _open(req: object, timeout: float | None = None):
            item = self.responses.pop(0)
            if isinstance(item, Exception):
                raise item
            status, body = item
            resp = mock.Mock()
            resp.status = status
            resp.read.return_value = body.encode("utf-8")
            resp.__enter__ = lambda s=resp: s
            resp.__exit__ = lambda *args: False
            return resp

        opener.open.side_effect = _open
        return opener


class TelegramProxySendTests(unittest.TestCase):
    def setUp(self) -> None:
        invalidate_proxy_cache()

    def tearDown(self) -> None:
        invalidate_proxy_cache()

    def _patch_identity(self, *, send_url: str):
        return mock.patch.multiple(
            notify_telegram,
            TELEGRAM_BOT_TOKEN=_TOKEN,
            TELEGRAM_SEND_URL=send_url,
            TELEGRAM_CHAT_ID="",
            CANDLE_CARD_TELEGRAM_CHAT_ID="",
        )

    def test_bot_api_uses_resolved_7890_not_env_7891(self) -> None:
        plan = _OpenerPlan([(200, '{"ok": true}')])
        ports = {7890}

        def reach(host: str, port: int, timeout: float = 1.2) -> bool:
            return int(port) in ports

        with mock.patch.dict(
            os.environ,
            _env(
                HTTPS_PROXY="http://127.0.0.1:7891",
                HTTP_PROXY="http://127.0.0.1:7891",
            ),
            clear=False,
        ):
            with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", reach):
                with mock.patch("urllib.request.build_opener", plan.build_opener):
                    with self._patch_identity(send_url=""):
                        ok = notify_telegram._send_via_bot_api("hello", _CHAT)
        self.assertTrue(ok)
        self.assertEqual(len(plan.handlers), 1)
        proxies = _proxy_map(plan.handlers[0])
        self.assertEqual(proxies.get("https"), "http://127.0.0.1:7890")
        self.assertNotIn("7891", str(proxies))

    def test_bot_api_retries_with_live_port_after_dead_proxy(self) -> None:
        ports: set[int] = set()

        def reach(host: str, port: int, timeout: float = 1.2) -> bool:
            return int(port) in ports

        def fail_then_ok(req: object, timeout: float | None = None):
            if not ports:
                ports.add(7890)
                raise urllib.error.URLError(
                    f"Connection refused https://api.telegram.org/bot{_TOKEN}/sendMessage {_CHAT}"
                )
            resp = mock.Mock()
            resp.status = 200
            resp.read.return_value = b'{"ok": true}'
            resp.__enter__ = lambda s=resp: s
            resp.__exit__ = lambda *args: False
            return resp

        seen: list[dict[str, str]] = []

        def build_opener(*handlers: object):
            seen.append(_proxy_map(tuple(handlers)))
            opener = mock.Mock()
            opener.open.side_effect = fail_then_ok
            return opener

        with mock.patch.dict(
            os.environ,
            _env(HTTPS_PROXY="http://127.0.0.1:7891", HTTP_PROXY="http://127.0.0.1:7891"),
            clear=False,
        ):
            with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", reach):
                with mock.patch("urllib.request.build_opener", build_opener):
                    with self._patch_identity(send_url=""):
                        ok = notify_telegram._send_via_bot_api("hello", _CHAT)
        self.assertTrue(ok)
        self.assertEqual(seen[0].get("https"), "http://127.0.0.1:7891")
        self.assertEqual(seen[1].get("https"), "http://127.0.0.1:7890")

    def test_failure_log_redacts_token_and_chat(self) -> None:
        def reach(host: str, port: int, timeout: float = 1.2) -> bool:
            return False

        def build_opener(*handlers: object):
            opener = mock.Mock()

            def _open(req: object, timeout: float | None = None):
                raise urllib.error.URLError(
                    f"Connection refused https://api.telegram.org/bot{_TOKEN}/sendMessage {_CHAT}"
                )

            opener.open.side_effect = _open
            return opener

        with mock.patch.dict(os.environ, _env(HTTPS_PROXY="http://127.0.0.1:7891"), clear=False):
            with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", reach):
                with mock.patch("urllib.request.build_opener", build_opener):
                    with self._patch_identity(send_url=""):
                        with self.assertLogs(notify_telegram.logger, level="WARNING") as logs:
                            ok = notify_telegram._send_via_bot_api("hello", _CHAT)
        self.assertFalse(ok)
        blob = "\n".join(logs.output)
        self.assertNotIn(_TOKEN, blob)
        self.assertNotIn(_CHAT, blob)
        self.assertIn("***", blob)

    def test_local_gateway_ignores_dead_env_proxy_then_bot_uses_7890(self) -> None:
        plan = _OpenerPlan(
            [
                (502, f"Bad Request: chat not found {_CHAT}"),
                (200, '{"ok": true}'),
            ]
        )

        def reach(host: str, port: int, timeout: float = 1.2) -> bool:
            return int(port) == 7890

        gateway = "http://127.0.0.1:8000/api/telegram/send"
        with mock.patch.dict(
            os.environ,
            _env(HTTPS_PROXY="http://127.0.0.1:7891", HTTP_PROXY="http://127.0.0.1:7891"),
            clear=False,
        ):
            with mock.patch("oi_mornitor.proxy_resolve._tcp_reachable", reach):
                with mock.patch("urllib.request.build_opener", plan.build_opener):
                    with self._patch_identity(send_url=gateway):
                        with self.assertLogs(notify_telegram.logger, level="WARNING") as logs:
                            ok = notify_telegram.send_telegram_text("card", chat_id=_CHAT)
        self.assertTrue(ok)
        self.assertEqual(len(plan.handlers), 2)
        self.assertEqual(_proxy_map(plan.handlers[0]), {})
        self.assertEqual(_proxy_map(plan.handlers[1]).get("https"), "http://127.0.0.1:7890")
        blob = "\n".join(logs.output)
        self.assertNotIn(_TOKEN, blob)
        self.assertNotIn(_CHAT, blob)
        self.assertNotIn("7891", blob)

    def test_missing_sender_does_not_log_chat_id(self) -> None:
        with self._patch_identity(send_url=""):
            with mock.patch.object(notify_telegram, "TELEGRAM_BOT_TOKEN", ""):
                with self.assertLogs(notify_telegram.logger, level="WARNING") as logs:
                    ok = notify_telegram.send_telegram_text("card", chat_id=_CHAT)
        self.assertFalse(ok)
        blob = "\n".join(logs.output)
        self.assertNotIn(_CHAT, blob)
        self.assertIn("chat_configured=True", blob)
