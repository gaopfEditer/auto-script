"""精简 CDP：页内 fetch / evaluate（需 Chrome --remote-allow-origins=*）。

选页策略（/news 抓取）：
- 优先复用**已打开且与源站同域**的标签，不在当前前台页上强行 navigate 到其它源站；
- 若无匹配标签，在后台新建标签打开源站 URL，避免挤占用户正在用的页签（如 Discord）。
"""
from __future__ import annotations

import json
import logging
import time
import urllib.parse
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


def _normalize_host(url: str) -> str:
    try:
        host = urllib.parse.urlparse(str(url or "").strip()).netloc.lower()
        if host.startswith("www."):
            host = host[4:]
        return host
    except Exception:
        return ""


def url_matches_source(page_url: str, source_url: str) -> bool:
    """页签 URL 与源站是否同域（可复用该页做页内 fetch）。"""
    page = str(page_url or "").strip()
    if not page or page.startswith("chrome://") or page.startswith("about:"):
        return False
    src_host = _normalize_host(source_url)
    if not src_host:
        return False
    return _normalize_host(page) == src_host


def list_page_targets(port: int) -> list[dict[str, Any]]:
    raw = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=5))
    if not isinstance(raw, list):
        return []
    return [
        p
        for p in raw
        if isinstance(p, dict)
        and p.get("type") == "page"
        and p.get("webSocketDebuggerUrl")
    ]


def _browser_ws_url(port: int) -> str:
    ver = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=3))
    return str(ver["webSocketDebuggerUrl"]).replace("localhost", "127.0.0.1")


def _ws_call(ws_url: str, method: str, params: dict | None = None, *, timeout: float = 25) -> dict:
    if websocket is None:
        raise CdpError("缺少 websocket-client")
    ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
    try:
        mid = 1
        ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            data = json.loads(ws.recv())
            if data.get("id") != mid:
                continue
            if "error" in data:
                raise CdpError(str(data["error"]))
            return data.get("result") or {}
        raise CdpError(f"CDP 超时 {method}")
    finally:
        ws.close()


def _page_has_focus(port: int, target: dict[str, Any]) -> bool:
    ws_url = str(target.get("webSocketDebuggerUrl") or "").replace("localhost", "127.0.0.1")
    if not ws_url:
        return False
    try:
        ws = websocket.create_connection(ws_url, timeout=8, suppress_origin=True)
    except Exception:
        return False
    try:
        ws.send(json.dumps({"id": 1, "method": "Runtime.enable", "params": {}}))
        ws.send(
            json.dumps(
                {
                    "id": 2,
                    "method": "Runtime.evaluate",
                    "params": {"expression": "document.hasFocus()", "returnByValue": True},
                }
            )
        )
        deadline = time.time() + 6
        focus = False
        while time.time() < deadline:
            data = json.loads(ws.recv())
            if data.get("id") == 2:
                focus = bool(((data.get("result") or {}).get("value")))
                break
        return focus
    except Exception:
        return False
    finally:
        try:
            ws.close()
        except Exception:
            pass


def _create_background_page(port: int, url: str) -> dict[str, Any]:
    """新建标签打开源站；尽量 background，避免抢走当前前台页。"""
    target_url = str(url or "").strip()
    if not target_url:
        raise CdpError("empty url")
    try:
        browser_ws = _browser_ws_url(port)
        created = _ws_call(
            browser_ws,
            "Target.createTarget",
            {"url": target_url, "newWindow": False, "background": True},
            timeout=30,
        )
        target_id = str(created.get("targetId") or "").strip()
        if target_id:
            time.sleep(0.35)
            for p in list_page_targets(port):
                if str(p.get("id") or "") == target_id:
                    logger.info("[news.cdp] 新建后台标签 %s", target_url[:120])
                    return p
    except Exception as e:
        logger.debug("Target.createTarget 失败，回退 /json/new: %s", e)

    quoted = urllib.parse.quote(target_url, safe=":/?#[]@!$&'()*+,;=")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/json/new?{quoted}",
        method="PUT",
        headers={"Content-Length": "0"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        page = json.load(r)
    if not isinstance(page, dict) or not page.get("webSocketDebuggerUrl"):
        raise CdpError("无法新建 Chrome 标签")
    logger.info("[news.cdp] 新建标签 %s", target_url[:120])
    return page


def resolve_page_for_source(port: int, source_url: str) -> dict[str, Any]:
    """为源站 URL 挑选页签：同域复用；否则新建后台标签。绝不 navigate 无关的前台页。"""
    pages = list_page_targets(port)
    matches = [p for p in pages if url_matches_source(str(p.get("url") or ""), source_url)]
    if matches:
        focused = [p for p in matches if _page_has_focus(port, p)]
        unfocused = [p for p in matches if p not in focused]
        chosen = unfocused[0] if unfocused else matches[0]
        logger.info(
            "[news.cdp] 复用同域标签 url=%s title=%s",
            str(chosen.get("url") or "")[:100],
            str(chosen.get("title") or "")[:60],
        )
        return chosen
    return _create_background_page(port, source_url)


class PageSession:
    def __init__(self, port: int, *, source_url: str | None = None, page_target: dict | None = None) -> None:
        if websocket is None:
            raise CdpError("缺少 websocket-client")
        self._port = port
        self._source_url = str(source_url or "").strip()
        page = page_target
        if not page:
            if not self._source_url:
                raise CdpError("需要 source_url 或 page_target")
            page = resolve_page_for_source(port, self._source_url)
        ws_url = str(page.get("webSocketDebuggerUrl") or "").replace("localhost", "127.0.0.1")
        if not ws_url:
            raise CdpError("Chrome 无可用 page target")
        self.page_url = str(page.get("url") or "")
        self.target_id = str(page.get("id") or "")
        try:
            self.ws = websocket.create_connection(ws_url, timeout=15, suppress_origin=True)
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
        target = str(url or "").strip()
        if target and url_matches_source(self.page_url, target):
            return
        if target and self._source_url and url_matches_source(self.page_url, self._source_url):
            return
        self.call("Page.navigate", {"url": target}, timeout=45)
        time.sleep(wait)
        self.page_url = target

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
    """上下文：在匹配源站的标签上执行（或新建后台标签），yield session。"""

    class _Ctx:
        def __enter__(self_inner):
            self_inner.s = PageSession(port, source_url=url)
            self_inner.s.navigate(url, wait=wait)
            return self_inner.s

        def __exit__(self_inner, *exc):
            self_inner.s.close()
            return False

    return _Ctx()
