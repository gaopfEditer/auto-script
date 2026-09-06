"""
HTTP 层 429 / 418 退避：读 Retry-After 精确解封秒数；币安冷却与其它所隔离。

供雷达 REST、K 线批量、Taker 流等统一调用，避免硬封后继续连打。
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlparse

import aiohttp

logger = logging.getLogger("OI_HTTP")

# 无 Retry-After 时：60s 起跳，指数加倍，封顶
BACKOFF_BASE_SEC = float(os.getenv("OI_HTTP_BACKOFF_BASE_SEC", "60"))
BACKOFF_MAX_SEC = float(os.getenv("OI_HTTP_BACKOFF_MAX_SEC", "900"))
# Retry-After 有值时按精确秒数；安全上限防异常超大头（默认 2h）
RETRY_AFTER_MAX_SEC = float(os.getenv("OI_HTTP_RETRY_AFTER_MAX_SEC", str(2 * 3600)))
BACKOFF_MAX_ATTEMPTS = int(os.getenv("OI_HTTP_BACKOFF_MAX_ATTEMPTS", "4"))
# 限频后额外请求间隔上限（降低获取频率）
THROTTLE_INTERVAL_MAX_SEC = float(os.getenv("OI_HTTP_THROTTLE_INTERVAL_MAX_SEC", "2.0"))

_lock = asyncio.Lock()
# scope → until_ts / reason
_cooldown_until: dict[str, float] = {}
_cooldown_reason: dict[str, str] = {}
_consec_throttle = 0
_extra_interval = 0.0
_last_retry_after_sec: float | None = None


def is_binance_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return "binance.com" in host or "binancefuture" in host


def parse_retry_after(headers: Any) -> float | None:
    """解析 Retry-After：秒数或 HTTP-date → 休眠秒数。"""
    if headers is None:
        return None
    try:
        raw = headers.get("Retry-After") or headers.get("retry-after")
    except Exception:  # noqa: BLE001
        return None
    if raw is None or raw == "":
        return None
    s = str(raw).strip()
    try:
        sec = float(s)
        if sec >= 0:
            return sec
    except (TypeError, ValueError):
        pass
    try:
        dt = parsedate_to_datetime(s)
        if dt is None:
            return None
        if dt.tzinfo is None:
            return max(0.0, dt.timestamp() - time.time())
        return max(0.0, dt.timestamp() - time.time())
    except (TypeError, ValueError, OverflowError):
        return None


def compute_backoff_sec(
    attempt: int,
    retry_after: float | None = None,
    *,
    honor_retry_after_exact: bool = True,
) -> float:
    """
    attempt 从 0 起。
    有 Retry-After：默认按精确秒数（只做安全上限夹紧，不再压到 900）。
    无 Retry-After：BASE * 2^attempt，夹在 [BASE, BACKOFF_MAX]。
    """
    if retry_after is not None and retry_after > 0:
        sec = max(float(retry_after), 1.0)
        if honor_retry_after_exact:
            return min(sec, RETRY_AFTER_MAX_SEC)
        return min(sec, BACKOFF_MAX_SEC)
    exp = BACKOFF_BASE_SEC * (2 ** max(0, int(attempt)))
    return min(max(exp, BACKOFF_BASE_SEC), BACKOFF_MAX_SEC)


def throttle_extra_interval() -> float:
    return _extra_interval


def last_retry_after_sec() -> float | None:
    """最近一次从响应头读到的 Retry-After（秒）。"""
    return _last_retry_after_sec


def cooldown_remaining(scope: str = "binance") -> float:
    until = _cooldown_until.get(scope, 0.0)
    return max(0.0, until - time.time())


def is_cooling(scope: str = "binance") -> bool:
    return cooldown_remaining(scope) > 0


async def wait_global_cooldown(*, label: str = "", scope: str = "binance") -> float:
    """若该 scope 冷却中则阻塞到结束。返回实际等待秒数。"""
    rem = cooldown_remaining(scope)
    if rem <= 0:
        return 0.0
    tag = f" · {label}" if label else ""
    logger.warning(
        "HTTP 冷却[%s] 中，精确等待 %.0fs（%s）%s",
        scope,
        rem,
        _cooldown_reason.get(scope) or "throttle",
        tag,
    )
    await asyncio.sleep(rem)
    return rem


async def mark_cooldown(delay_sec: float, reason: str, *, scope: str = "binance") -> None:
    """延长指定 scope 冷却，并抬高后续请求间隔。"""
    global _consec_throttle, _extra_interval
    delay = max(1.0, float(delay_sec))
    async with _lock:
        until = time.time() + delay
        cur = _cooldown_until.get(scope, 0.0)
        if until > cur:
            _cooldown_until[scope] = until
            _cooldown_reason[scope] = reason
        _consec_throttle += 1
        _extra_interval = min(
            THROTTLE_INTERVAL_MAX_SEC,
            0.15 * _consec_throttle,
        )
    logger.warning(
        "HTTP 退避[%s] %.0fs（≈%.1f min）（%s）· 连续限频 %d · 额外间隔 +%.2fs",
        scope,
        delay,
        delay / 60.0,
        reason,
        _consec_throttle,
        _extra_interval,
    )


async def note_success() -> None:
    """成功响应后缓慢恢复频率。"""
    global _consec_throttle, _extra_interval
    async with _lock:
        if _consec_throttle > 0:
            _consec_throttle = max(0, _consec_throttle - 1)
        _extra_interval = min(
            THROTTLE_INTERVAL_MAX_SEC,
            0.15 * _consec_throttle,
        )


async def get_json(
    session: aiohttp.ClientSession,
    url: str,
    *,
    timeout: aiohttp.ClientTimeout | None = None,
    max_attempts: int | None = None,
    label: str = "",
    respect_cooldown: bool = True,
) -> tuple[int, Any | None]:
    """
    GET JSON，捕获 429/418：
    - 读取 Retry-After 作为精确解封秒数（写入币安 scope 冷却）
    - 无头则指数退避（默认 60s 起）
    - 币安冷却不阻塞 Bybit/OKX 等其它所

    返回 (http_status, data)；网络失败 status=0。
    """
    global _last_retry_after_sec
    attempts = max(1, int(max_attempts if max_attempts is not None else BACKOFF_MAX_ATTEMPTS))
    to = timeout or aiohttp.ClientTimeout(total=30)
    tag = label or url.split("?", 1)[0][-48:]
    scope = "binance" if is_binance_url(url) else "other"
    last_status = 0

    for attempt in range(attempts):
        # 仅币安请求遵守币安冷却；其它所互不阻塞
        if respect_cooldown and scope == "binance":
            await wait_global_cooldown(label=tag, scope="binance")

        try:
            async with session.get(url, timeout=to) as resp:
                last_status = int(resp.status)
                if resp.status == 200:
                    try:
                        data = await resp.json(content_type=None)
                    except (aiohttp.ContentTypeError, ValueError, TypeError):
                        await resp.read()
                        logger.warning("HTTP JSON 解析失败 %s", tag)
                        return last_status, None
                    await note_success()
                    return last_status, data

                if resp.status in (429, 418):
                    ra = parse_retry_after(resp.headers)
                    if ra is not None:
                        _last_retry_after_sec = float(ra)
                    delay = compute_backoff_sec(attempt, ra, honor_retry_after_exact=True)
                    try:
                        await resp.read()
                    except Exception:  # noqa: BLE001
                        pass
                    reason = f"{resp.status}:{tag}"
                    if ra is not None:
                        logger.warning(
                            "HTTP %s %s · Retry-After=%.0fs（精确解封）→ 冷却 %.0fs≈%.1fmin（尝试 %d/%d）",
                            resp.status,
                            tag,
                            ra,
                            delay,
                            delay / 60.0,
                            attempt + 1,
                            attempts,
                        )
                    else:
                        logger.warning(
                            "HTTP %s %s · 无 Retry-After → 指数退避 %.0fs（尝试 %d/%d）",
                            resp.status,
                            tag,
                            delay,
                            attempt + 1,
                            attempts,
                        )
                    # 418 硬封：按精确秒数冷却后本请求直接放弃，避免同窗空重试
                    await mark_cooldown(delay, reason, scope=scope)
                    if resp.status == 418 or attempt + 1 >= attempts:
                        return last_status, None
                    await asyncio.sleep(delay)
                    continue

                body = await resp.text()
                logger.warning("HTTP %s %s — %s", resp.status, tag, body[:160])
                return last_status, None

        except asyncio.TimeoutError:
            logger.warning("HTTP 超时 %s（尝试 %d/%d）", tag, attempt + 1, attempts)
            last_status = 0
        except aiohttp.ClientError as exc:
            logger.warning("HTTP 网络异常 %s: %s（尝试 %d/%d）", tag, exc, attempt + 1, attempts)
            last_status = 0

        if attempt + 1 < attempts:
            delay = min(compute_backoff_sec(attempt, None), BACKOFF_BASE_SEC)
            await asyncio.sleep(delay)

    return last_status, None
