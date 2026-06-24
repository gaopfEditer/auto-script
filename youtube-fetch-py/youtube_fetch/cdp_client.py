"""通过 Playwright connect_over_cdp 在 youtube-transcript.ai 页面拉取文稿."""

from __future__ import annotations

import asyncio
import logging

from playwright.async_api import Browser, Page, async_playwright


class CdpTranscriptClient:
    def __init__(self, cdp_url: str, site_url: str, timeout_ms: int, log: logging.Logger) -> None:
        self.cdp_url = cdp_url
        self.site_url = site_url.rstrip("/")
        self.timeout_ms = timeout_ms
        self.log = log
        self._playwright = None
        self.browser: Browser | None = None
        self.page: Page | None = None
        self.ready = False
        self._serial = asyncio.Lock()

    async def connect(self) -> None:
        self.log.info("connect_over_cdp → %s", self.cdp_url)
        self._playwright = await async_playwright().start()
        self.browser = await self._playwright.chromium.connect_over_cdp(
            self.cdp_url, timeout=30_000
        )
        contexts = self.browser.contexts
        if not contexts:
            raise RuntimeError("CDP 浏览器无可用 context")
        ctx = contexts[0]

        existing = None
        for p in ctx.pages:
            try:
                if "youtube-transcript.ai" in p.url:
                    existing = p
                    break
            except Exception:
                continue

        self.page = existing or await ctx.new_page()
        if not existing:
            self.log.info("打开 %s", self.site_url)
            await self.page.goto(
                self.site_url,
                wait_until="domcontentloaded",
                timeout=self.timeout_ms,
            )
        else:
            self.log.info("复用已打开标签: %s", self.page.url[:120])

        self.ready = True
        self.log.info("CDP 文稿客户端就绪")

    async def fetch_transcript_text(self, video_id: str, lang: str | None = None) -> str:
        if not self.page or not self.ready:
            raise RuntimeError("CDP 尚未连接，请先调用 connect()")
        async with self._serial:
            return await self._fetch_once(video_id, lang)

    async def _fetch_once(self, video_id: str, lang: str | None) -> str:
        page = self.page
        if not page:
            raise RuntimeError("无可用 page")

        path = (
            f"/transcript/{video_id}.txt?lang={lang}"
            if lang
            else f"/transcript/{video_id}.txt"
        )
        url = f"{self.site_url}{path}"
        self.log.debug("goto %s", url)

        try:
            resp = await page.goto(url, wait_until="commit", timeout=self.timeout_ms)
            if not resp:
                raise RuntimeError("page.goto 无响应")
            status = resp.status
            text = await resp.text()
            if status < 200 or status >= 300:
                hint = f" — {text[:300]}" if text else ""
                raise RuntimeError(f"youtube-transcript.ai HTTP {status}{hint}")
            if not text.strip():
                raise RuntimeError("返回正文为空")
            return text
        except Exception as e:
            msg = str(e)
            if "Target closed" in msg or "has been closed" in msg:
                self.ready = False
                raise RuntimeError(f"CDP 页面已关闭: {msg}") from e
            raise

    async def close(self) -> None:
        self.ready = False
        self.page = None
        if self.browser:
            try:
                await self.browser.close()
            except Exception:
                pass
            self.browser = None
        if self._playwright:
            try:
                await self._playwright.stop()
            except Exception:
                pass
            self._playwright = None
        self.log.info("已断开 CDP（未关闭你的 Chrome）")
