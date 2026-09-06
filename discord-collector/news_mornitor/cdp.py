"""精简 CDP：页内 fetch / evaluate（需 Chrome --remote-allow-origins=*）。"""
from __future__ import annotations

import json
import logging
import time
import urllib.request
from typing import Any

logger = logging.getLogger("news.cdp")

try:
    import websocket
except ImportError:  # pragma: no cover
    websocket = None  # type: ignore


class CdpError(RuntimeError):
    pass


def chrome_alive(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


class PageSession:
    def __init__(self, port: int) -> None:
        if websocket is None:
            raise CdpError("缺少 websocket-client")
        pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=3))
        page = next(
            (p for p in pages if p.get("type") == "page" and p.get("webSocketDebuggerUrl")),
            None,
        )
        if not page:
            raise CdpError("Chrome 无可用 page target")
        url = str(page["webSocketDebuggerUrl"]).replace("localhost", "127.0.0.1")
        try:
            # Chrome 未加 --remote-allow-origins=* 时，默认 Origin 会被拒；去掉 Origin 即可握手
            self.ws = websocket.create_connection(url, timeout=15, suppress_origin=True)
        except Exception as e:
            raise CdpError(
                f"CDP 握手失败（需 Chrome --remote-allow-origins=*）: {e}"
            ) from e
        self._id = 0
        self.call("Page.enable")
        self.call("Runtime.enable")

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:
            pass

    def call(self, method: str, params: dict | None = None, *, timeout: float = 40) -> dict:
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            data = json.loads(self.ws.recv())
            if data.get("id") != mid:
                continue
            if "error" in data:
                raise CdpError(str(data["error"]))
            return data.get("result") or {}
        raise CdpError(f"CDP 超时 {method}")

    def navigate(self, url: str, *, wait: float = 4.0) -> None:
        self.call("Page.navigate", {"url": url}, timeout=45)
        time.sleep(wait)

    def evaluate(self, expression: str, *, await_promise: bool = False) -> Any:
        res = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
            },
            timeout=90,
        )
        if res.get("exceptionDetails"):
            raise CdpError(str(res["exceptionDetails"])[:400])
        return (res.get("result") or {}).get("value")


def with_page(port: int, url: str, *, wait: float = 4.0):
    """上下文：打开 url，yield session。"""

    class _Ctx:
        def __enter__(self_inner):
            self_inner.s = PageSession(port)
            self_inner.s.navigate(url, wait=wait)
            return self_inner.s

        def __exit__(self_inner, *exc):
            self_inner.s.close()
            return False

    return _Ctx()
