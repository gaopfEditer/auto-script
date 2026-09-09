"""币安广场 / OKX / Foresight / CoinDesk / BlockBeats 热榜。"""
from __future__ import annotations

import base64
import json
import logging
import re
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

from news_mornitor.settings import (
    BINANCE_TRENDS_URL,
    BLOCKBEATS_FLASH_URL,
    CDP_ENABLED,
    CHROME_DEBUG_PORT,
    COINDESK_LATEST_URL,
    FORESIGHT_FEED_URL,
    FORESIGHT_HOME_URL,
    HTTP_TIMEOUT,
    OKX_TOPICS_URL,
    proxy_url,
)

logger = logging.getLogger("news.hotlists")

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)

_BINANCE_API_CANDIDATES = [
    "https://www.binance.com/bapi/composite/v1/friendly/pgc/topic/hot/list?page=1&pageSize=30",
    "https://www.binance.com/bapi/composite/v1/public/pgc/topic/hot/list?page=1&pageSize=30",
    "https://www.binance.com/bapi/composite/v1/friendly/pgc/content/square/hotRank?page=1&pageSize=30",
    "https://www.binance.com/bapi/composite/v1/public/pgc/content/square/hotRank?page=1&pageSize=30",
    "https://www.binance.com/bapi/composite/v1/friendly/pgc/content/square/trend/list?page=1&pageSize=30",
    "https://www.binance.com/bapi/composite/v1/friendly/pgc/content/home/squareList?page=1&rows=30",
]

_OKX_API_CANDIDATES = [
    "https://www.okx.com/priapi/v5/eco/topic/hot?page=1&size=30",
    "https://www.okx.com/priapi/v5/eco/community/topic/hot?page=1&size=30",
    "https://www.okx.com/priapi/v5/eco/orbit/topic/list?page=1&size=30",
    "https://www.okx.com/priapi/v1/social/topic/hot?page=1&size=30",
]


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _item(
    *,
    platform: str,
    rank: int,
    title: str,
    url: str,
    summary: str = "",
    heat: str | None = None,
    tags: list[str] | None = None,
    published_at: str | None = None,
) -> dict[str, Any]:
    return {
        "platform": platform,
        "rank": rank,
        "title": title.strip(),
        "url": url,
        "summary": (summary or "").strip(),
        "heat": heat,
        "tags": tags or [],
        "published_at": published_at,
    }


def _pick_published_at(row: dict) -> str | None:
    """尝试从 row 中提取发布时间，返回 ISO 字符串或 None。"""
    for k in (
        "publishTime",
        "publishedAt",
        "published_at",
        "createTime",
        "createdAt",
        "ctime",
        "ctimeMs",
        "pubTime",
        "time",
        "date",
        "updatedAt",
        "updateTime",
    ):
        v = row.get(k)
        if v is None:
            continue
        # 毫秒时间戳
        if isinstance(v, (int, float)):
            try:
                ts = float(v)
                if ts < 1e12:  # 秒转毫秒
                    ts *= 1000
                dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
                return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            except Exception:
                continue
        # ISO 字符串
        if isinstance(v, str) and len(v) >= 10:
            try:
                # 尝试直接解析常见格式
                for fmt in (
                    "%Y-%m-%dT%H:%M:%SZ",
                    "%Y-%m-%dT%H:%M:%S.%fZ",
                    "%Y-%m-%dT%H:%M:%S+08:00",
                    "%Y-%m-%dT%H:%M:%S",
                    "%Y-%m-%d %H:%M:%S",
                ):
                    try:
                        dt = datetime.strptime(v[:19], fmt).replace(tzinfo=timezone.utc)
                        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
                    except ValueError:
                        continue
            except Exception:
                continue
    return None


async def _http_get(url: str, *, headers: dict[str, str] | None = None) -> tuple[int, str]:
    import aiohttp

    h = {
        "User-Agent": UA,
        "Accept": "application/json,text/html,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    if headers:
        h.update(headers)
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT)
    async with aiohttp.ClientSession(headers=h, trust_env=True) as sess:
        async with sess.get(url, timeout=timeout, proxy=proxy_url()) as resp:
            return resp.status, await resp.text()


def _walk_lists(obj: Any, depth: int = 0) -> list[list]:
    if depth > 6:
        return []
    found: list[list] = []
    if isinstance(obj, list) and obj and isinstance(obj[0], dict):
        found.append(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            found.extend(_walk_lists(v, depth + 1))
    return found


def _pick_title(row: dict) -> str:
    for k in (
        "title",
        "topicTitle",
        "topicName",
        "name",
        "content",
        "body",
        "summary",
        "hotTitle",
    ):
        v = row.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
        if isinstance(v, dict):
            t = _pick_title(v)
            if t:
                return t
    return ""


def _pick_url(row: dict, *, platform: str) -> str:
    for k in ("url", "link", "shareLink", "webLink", "href", "topicUrl"):
        v = row.get(k)
        if isinstance(v, str) and v.startswith("http"):
            return v
    eid = str(
        row.get("id")
        or row.get("topicId")
        or row.get("contentId")
        or row.get("squareTopicId")
        or ""
    ).strip()
    slug = str(row.get("slug") or row.get("topicSlug") or row.get("seoUrl") or "").strip()
    if platform == "binance":
        if slug or row.get("topicId") or row.get("squareTopicId"):
            return f"https://www.binance.com/zh-CN/square/topic/{slug or eid}"
        if eid:
            return f"https://www.binance.com/zh-CN/square/post/{eid}"
    if platform == "okx":
        if slug and eid and not slug.endswith(str(eid)):
            return f"https://www.okx.com/zh-hans/orbit/topic/{slug}-{eid}"
        if slug:
            return f"https://www.okx.com/zh-hans/orbit/topic/{slug}"
        if eid:
            return f"https://www.okx.com/zh-hans/orbit/topic/{eid}"
    return ""


def _parse_api_rows(data: Any, *, platform: str, limit: int = 30) -> list[dict[str, Any]]:
    best: list[dict[str, Any]] = []
    for lst in _walk_lists(data):
        items: list[dict[str, Any]] = []
        for i, row in enumerate(lst[:limit], start=1):
            if not isinstance(row, dict):
                continue
            title = _pick_title(row)
            if not title or len(title) < 2:
                continue
            url = _pick_url(row, platform=platform)
            heat = None
            for k in ("hotScore", "heat", "viewCount", "participantCount", "discussCount"):
                if row.get(k) is not None:
                    heat = str(row.get(k))
                    break
            items.append(
                _item(
                    platform=platform,
                    rank=i,
                    title=re.sub(r"^#\s*", "", title),
                    url=url or (
                        BINANCE_TRENDS_URL if platform == "binance" else OKX_TOPICS_URL
                    ),
                    summary=str(row.get("summary") or row.get("desc") or row.get("description") or "")[
                        :240
                    ],
                    heat=heat,
                    published_at=_pick_published_at(row),
                )
            )
        if len(items) > len(best):
            best = items
    return best


async def _fetch_binance_http() -> list[dict[str, Any]]:
    headers = {
        "clienttype": "web",
        "lang": "zh-CN",
        "Referer": BINANCE_TRENDS_URL,
        "Origin": "https://www.binance.com",
    }
    for url in _BINANCE_API_CANDIDATES:
        try:
            status, text = await _http_get(url, headers=headers)
            if status != 200 or not text.strip().startswith(("{", "[")):
                continue
            data = json.loads(text)
            items = _parse_api_rows(data, platform="binance")
            if items:
                logger.info("币安 API 命中 %s → %d", url.split("/bapi/", 1)[-1][:60], len(items))
                return items
        except Exception as e:
            logger.debug("币安 API 失败 %s: %s", url, e)
    return []


async def _fetch_okx_http() -> list[dict[str, Any]]:
    headers = {
        "Referer": OKX_TOPICS_URL,
        "Origin": "https://www.okx.com",
    }
    for url in _OKX_API_CANDIDATES:
        try:
            status, text = await _http_get(url, headers=headers)
            if status != 200 or not text.strip().startswith(("{", "[")):
                continue
            data = json.loads(text)
            items = _parse_api_rows(data, platform="okx")
            if items:
                logger.info("OKX API 命中 %s → %d", url.split(".com", 1)[-1][:60], len(items))
                return items
        except Exception as e:
            logger.debug("OKX API 失败 %s: %s", url, e)

    # HTML 页解析（今日市场热议链接）
    try:
        status, html = await _http_get(OKX_TOPICS_URL, headers=headers)
        if status == 200 and html:
            items = _parse_okx_html(html)
            if items:
                logger.info("OKX HTML 解析 %d 条", len(items))
                return items
    except Exception as e:
        logger.debug("OKX HTML 失败: %s", e)
    return []


def _decode_foresight_list(payload: Any) -> list[dict[str, Any]]:
    """Foresight API data.list 多为 base64+zlib 的 JSON 数组。"""
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        inner = payload.get("list")
        if isinstance(inner, list):
            return [x for x in inner if isinstance(x, dict)]
        if isinstance(inner, str) and inner.strip():
            payload = inner
        else:
            return []
    if not isinstance(payload, str) or not payload.strip():
        return []
    try:
        raw = base64.b64decode(payload)
        text = zlib.decompress(raw).decode("utf-8", errors="replace")
        data = json.loads(text)
    except Exception as e:
        logger.debug("Foresight 解压失败: %s", e)
        return []
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    return []


def _foresight_url(source_type: str, source_id: Any) -> str:
    sid = str(source_id or "").strip()
    if not sid:
        return FORESIGHT_HOME_URL
    if source_type == "article":
        return f"https://foresightnews.pro/article/detail/{sid}"
    return f"https://foresightnews.pro/news/detail/{sid}"


def _parse_foresight_feed(rows: list[dict[str, Any]], *, limit: int = 30) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        st = str(row.get("source_type") or "").strip().lower()
        body = row.get(st) if st in row and isinstance(row.get(st), dict) else None
        if body is None:
            for key in ("news", "article", "column"):
                if isinstance(row.get(key), dict):
                    body = row[key]
                    st = key
                    break
        if not isinstance(body, dict):
            continue
        title = str(body.get("title") or "").strip()
        if not title:
            continue
        brief = str(body.get("brief") or "").strip()
        if not brief:
            # strip html content briefly
            brief = re.sub(r"<[^>]+>", "", str(body.get("content") or ""))[:200].strip()
        tags: list[str] = []
        for t in body.get("tags") or []:
            if isinstance(t, dict) and t.get("name"):
                tags.append(str(t["name"]))
        important = body.get("important_tag")
        if isinstance(important, dict) and important.get("name"):
            tags.insert(0, str(important["name"]))
        source_id = body.get("id") or row.get("source_id") or row.get("id")
        out.append(
            _item(
                platform="foresight",
                rank=len(out) + 1,
                title=title[:180],
                url=_foresight_url(st or "news", source_id),
                summary=brief[:240],
                heat="重要" if body.get("is_important") else None,
                tags=tags[:6],
                published_at=_utc_now(),
            )
        )
        if len(out) >= limit:
            break
    return out


def _parse_foresight_html(html: str) -> list[dict[str, Any]]:
    pat = re.compile(
        r'href="(https://foresightnews\.pro/(?:news|article)/detail/\d+|/?(?:news|article)/detail/\d+)"[^>]*>(.*?)</a>',
        re.I | re.S,
    )
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for m in pat.finditer(html):
        href = m.group(1)
        if not href.startswith("http"):
            href = urljoin("https://foresightnews.pro/", href)
        if href in seen:
            continue
        title = re.sub(r"<[^>]+>", " ", m.group(2))
        title = re.sub(r"\s+", " ", title).strip()
        if len(title) < 4:
            continue
        seen.add(href)
        out.append(
            _item(
                platform="foresight",
                rank=len(out) + 1,
                title=title[:180],
                url=href,
                published_at=_utc_now(),
            )
        )
        if len(out) >= 30:
            break
    return out


async def _fetch_foresight_http() -> list[dict[str, Any]]:
    headers = {
        "Referer": FORESIGHT_HOME_URL,
        "Origin": "https://foresightnews.pro",
        "Accept": "application/json, text/plain, */*",
    }
    try:
        status, text = await _http_get(FORESIGHT_FEED_URL, headers=headers)
        if status == 200 and text.strip().startswith("{"):
            data = json.loads(text)
            rows = _decode_foresight_list(data.get("data"))
            items = _parse_foresight_feed(rows)
            if items:
                logger.info("Foresight API 命中 %d 条", len(items))
                return items
    except Exception as e:
        logger.debug("Foresight API 失败: %s", e)

    try:
        status, html = await _http_get(FORESIGHT_HOME_URL, headers=headers)
        if status == 200 and html:
            items = _parse_foresight_html(html)
            if items:
                logger.info("Foresight HTML 解析 %d 条", len(items))
                return items
    except Exception as e:
        logger.debug("Foresight HTML 失败: %s", e)
    return []


_COINDESK_SECTION = (
    "business|markets|policy|tech|daybook-us|consensus-magazine|opinion|"
    "finance|web3|research|layer2s|sports|ai-crypto"
)
_COINDESK_HREF_RE = re.compile(
    rf'href="((?:https://www\.coindesk\.com)?/zh/(?:{_COINDESK_SECTION})/'
    rf'[0-9]{{4}}/[0-9]{{2}}/[0-9]{{2}}/[^"?#]+)"',
    re.I,
)
_COINDESK_ANCHOR_RE = re.compile(
    rf'<a[^>]+href="((?:https://www\.coindesk\.com)?/zh/(?:{_COINDESK_SECTION})/'
    rf'[0-9]{{4}}/[0-9]{{2}}/[0-9]{{2}}/[^"?#]+)"[^>]*>(.*?)</a>',
    re.I | re.S,
)


def _parse_coindesk_html(html: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for m in _COINDESK_ANCHOR_RE.finditer(html):
        href = m.group(1)
        if not href.startswith("http"):
            href = urljoin("https://www.coindesk.com", href)
        title = re.sub(r"<[^>]+>", " ", m.group(2))
        title = re.sub(r"\s+", " ", title).strip()
        if href in seen or len(title) < 8:
            continue
        if re.fullmatch(r"[\d\s分钟小时天前昨天今天广告积极消极中性]+", title):
            continue
        seen.add(href)
        # 从 slug 旁或后续短文案里尽量取摘要：下一截纯文本
        out.append(
            _item(
                platform="coindesk",
                rank=len(out) + 1,
                title=title[:180],
                url=href,
                published_at=_utc_now(),
            )
        )
        if len(out) >= 30:
            break
    if out:
        return out
    # 仅有链接时用 slug 生成标题兜底
    for m in _COINDESK_HREF_RE.finditer(html):
        href = m.group(1)
        if not href.startswith("http"):
            href = urljoin("https://www.coindesk.com", href)
        if href in seen:
            continue
        slug = href.rstrip("/").split("/")[-1].replace("-", " ")
        seen.add(href)
        out.append(
            _item(platform="coindesk", rank=len(out) + 1, title=slug[:180], url=href, published_at=_utc_now())
        )
        if len(out) >= 30:
            break
    return out


def _strip_html(text: str) -> str:
    import html as html_lib

    s = re.sub(r"<br\s*/?>", "\n", text or "", flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html_lib.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def _parse_blockbeats_html(html: str, *, limit: int = 30) -> list[dict[str, Any]]:
    """解析 BlockBeats 快讯 SSR HTML（标题 + 摘要 + /flash/{id}）。"""
    from urllib.parse import unquote

    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    shares: list[tuple[str, str]] = []
    for m in re.finditer(
        r"twitter\.com/share\?text=([^&]+)&amp;url=https://www\.theblockbeats\.info/*flash/(\d+)",
        html,
    ):
        title = unquote(m.group(1).replace("+", " ")).strip()
        aid = m.group(2)
        if not title or aid in seen:
            continue
        seen.add(aid)
        shares.append((aid, title))

    contents = [
        _strip_html(c)
        for c in re.findall(
            r'class="news-flash-item-content"[^>]*>(.*?)</div>',
            html,
            flags=re.S | re.I,
        )
    ]
    times = re.findall(
        r'class="news-flash-title"[^>]*>\s*(\d{1,2}:\d{2})\s*<',
        html,
        flags=re.S | re.I,
    )
    if not times:
        times = re.findall(r">\s*(\d{1,2}:\d{2})\s*<img[^>]*home-first", html)

    if shares:
        for i, (aid, title) in enumerate(shares[:limit]):
            summary = contents[i] if i < len(contents) else ""
            time_bit = times[i] if i < len(times) else ""
            tags = [time_bit] if time_bit else []
            out.append(
                _item(
                    platform="blockbeats",
                    rank=len(out) + 1,
                    title=title[:180],
                    url=f"https://www.theblockbeats.info/flash/{aid}",
                    summary=summary[:280],
                    tags=tags,
                    published_at=_utc_now(),
                )
            )
        return out

    for m in re.finditer(
        r'class="news-flash-title-text[^"]*"[^>]*>(.*?)</(?:div|span|a|p|h\d)>'
        r'.*?class="news-flash-item-content"[^>]*>(.*?)</div>',
        html,
        flags=re.S | re.I,
    ):
        title = _strip_html(m.group(1))
        summary = _strip_html(m.group(2))
        if len(title) < 4:
            continue
        start = max(0, m.start() - 400)
        chunk = html[start : m.end()]
        ids = re.findall(r"/flash/(\d+)", chunk)
        aid = ids[-1] if ids else str(len(out) + 1)
        out.append(
            _item(
                platform="blockbeats",
                rank=len(out) + 1,
                title=title[:180],
                url=f"https://www.theblockbeats.info/flash/{aid}",
                summary=summary[:280],
                published_at=_utc_now(),
            )
        )
        if len(out) >= limit:
            break
    return out


async def _fetch_blockbeats_http() -> list[dict[str, Any]]:
    try:
        status, html = await _http_get(
            BLOCKBEATS_FLASH_URL,
            headers={
                "Referer": "https://www.theblockbeats.info/",
                "Accept": "text/html,application/xhtml+xml",
            },
        )
        if status == 200 and html:
            items = _parse_blockbeats_html(html)
            if items:
                logger.info("BlockBeats HTML 解析 %d 条", len(items))
                return items
            logger.warning("BlockBeats HTML 未解析到快讯")
        else:
            logger.warning("BlockBeats HTTP %s", status)
    except Exception as e:
        logger.warning("BlockBeats 抓取失败: %s", e)
    return []


async def _fetch_coindesk_http() -> list[dict[str, Any]]:
    headers = {
        "Referer": "https://www.coindesk.com/",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    try:
        status, html = await _http_get(COINDESK_LATEST_URL, headers=headers)
        if status == 200 and html:
            items = _parse_coindesk_html(html)
            if items:
                logger.info("CoinDesk HTML 解析 %d 条", len(items))
                return items
    except Exception as e:
        logger.debug("CoinDesk HTML 失败: %s", e)
    return []


def _parse_okx_html(html: str) -> list[dict[str, Any]]:
    # <a href="/zh-hans/orbit/topic/slug-123">...</a>
    pat = re.compile(
        r'href="(/zh-hans/orbit/topic/[^"]+)"[^>]*>(.*?)</a>',
        re.I | re.S,
    )
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for m in pat.finditer(html):
        path = m.group(1)
        if path in seen:
            continue
        raw = re.sub(r"<[^>]+>", " ", m.group(2))
        raw = re.sub(r"\s+", " ", raw).strip()
        title = re.sub(r"^\d+\s*", "", raw)
        title = re.sub(r"^#\s*", "", title)
        title = re.sub(
            r"(?:\s*[xX]?[A-Za-z]{2,12}\s*[+\-]?\d+(?:\.\d+)?%?)+\s*$",
            "",
            title,
        ).strip()
        title = re.sub(r"\s+热\s*$", "", title).strip()
        if len(title) < 4:
            continue
        seen.add(path)
        out.append(
            _item(
                platform="okx",
                rank=len(out) + 1,
                title=title[:160],
                url=urljoin("https://www.okx.com", path),
                published_at=_utc_now(),
            )
        )
        if len(out) >= 30:
            break
    return out


def _parse_binance_html(html: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for pat in (
        re.compile(
            r'<a[^>]+href="((?:https://www\.binance\.com)?/zh-CN/square/hashtag/[^"]+)"[^>]*>(.*?)</a>',
            re.I | re.S,
        ),
        re.compile(
            r'<a[^>]+href="((?:https://www\.binance\.com)?/zh-CN/square/(?:topic|post)/[^"]+)"[^>]*>(.*?)</a>',
            re.I | re.S,
        ),
    ):
        for m in pat.finditer(html):
            href = m.group(1)
            if not href.startswith("http"):
                href = urljoin("https://www.binance.com", href)
            if href in seen:
                continue
            title = re.sub(r"<[^>]+>", " ", m.group(2))
            title = re.sub(r"\s+", " ", title).strip()
            title = re.sub(r"^\d+\s*", "", title)
            title = re.sub(r"\s*[\d,]+\s*人讨论中\s*$", "", title).strip()
            title = re.sub(r"[,，.\s]+$", "", title).strip()
            if len(title) < 2:
                continue
            seen.add(href)
            out.append(
                _item(platform="binance", rank=len(out) + 1, title=title[:160], url=href, published_at=_utc_now())
            )
            if len(out) >= 30:
                return out
    return out


def _cdp_hotlists() -> dict[str, list[dict[str, Any]]]:
    if not CDP_ENABLED:
        return {"binance": [], "okx": []}
    try:
        from news_mornitor.cdp import chrome_alive, with_page

        if not chrome_alive(CHROME_DEBUG_PORT):
            logger.warning("热榜 CDP：Chrome :%s 未就绪", CHROME_DEBUG_PORT)
            return {"binance": [], "okx": []}
    except Exception as e:
        logger.warning("热榜 CDP 不可用: %s", e)
        return {"binance": [], "okx": []}

    result = {"binance": [], "okx": []}

    binance_js = r"""
(async () => {
  const paths = [
    '/bapi/composite/v1/friendly/pgc/topic/hot/list?page=1&pageSize=30',
    '/bapi/composite/v1/public/pgc/topic/hot/list?page=1&pageSize=30',
    '/bapi/composite/v1/friendly/pgc/content/square/hotRank?page=1&pageSize=30',
    '/bapi/composite/v1/friendly/pgc/content/home/squareList?page=1&rows=30',
  ];
  for (const p of paths) {
    try {
      const r = await fetch('https://www.binance.com' + p, {
        credentials: 'include',
        headers: { clienttype: 'web', lang: 'zh-CN', Accept: 'application/json' },
      });
      if (!r.ok) continue;
      const j = await r.json();
      return { via: 'api', path: p, json: j };
    } catch (e) {}
  }
  const pick = (sel) => Array.from(document.querySelectorAll(sel))
    .map(a => ({ href: a.href, text: (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 180) }))
    .filter(x => x.text && x.text.length > 2);
  let links = pick('a[href*="/square/hashtag/"]');
  if (links.length < 5) {
    links = pick('a[href*="/square/"]');
  }
  // 去重保序
  const seen = new Set();
  links = links.filter(x => {
    if (seen.has(x.href)) return false;
    seen.add(x.href);
    return true;
  }).slice(0, 40);
  return { via: 'dom', links };
})()
"""
    okx_js = r"""
(async () => {
  const paths = [
    '/priapi/v5/eco/topic/hot?page=1&size=30',
    '/priapi/v5/eco/community/topic/hot?page=1&size=30',
    '/priapi/v1/social/topic/hot?page=1&size=30',
  ];
  for (const p of paths) {
    try {
      const r = await fetch('https://www.okx.com' + p, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) continue;
      const j = await r.json();
      return { via: 'api', path: p, json: j };
    } catch (e) {}
  }
  const links = Array.from(document.querySelectorAll('a[href*="/orbit/topic/"]'))
    .map(a => ({ href: a.href, text: (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160) }))
    .filter(x => x.text && x.text.length > 2)
    .slice(0, 40);
  return { via: 'dom', links };
})()
"""

    try:
        with with_page(CHROME_DEBUG_PORT, BINANCE_TRENDS_URL, wait=5) as s:
            raw = s.evaluate(binance_js, await_promise=True)
        if isinstance(raw, dict):
            if raw.get("via") == "api" and raw.get("json") is not None:
                result["binance"] = _parse_api_rows(raw["json"], platform="binance")
            elif raw.get("links"):
                for i, row in enumerate(raw["links"][:30], start=1):
                    title = str(row.get("text") or "")
                    title = re.sub(r"^\d+\s*", "", title)
                    title = re.sub(r"\s*[\d,]+\s*人讨论中\s*$", "", title).strip()
                    title = re.sub(r"[,，.\s]+$", "", title).strip()
                    title = re.sub(r"^#+\s*", "#", title)
                    if len(title) < 2:
                        continue
                    result["binance"].append(
                        _item(
                            platform="binance",
                            rank=len(result["binance"]) + 1,
                            title=title[:160],
                            url=str(row.get("href") or BINANCE_TRENDS_URL),
                            published_at=_utc_now(),
                        )
                    )
            logger.info("币安 CDP %d 条", len(result["binance"]))
    except Exception as e:
        logger.warning("币安 CDP 失败: %s", e)

    try:
        with with_page(CHROME_DEBUG_PORT, OKX_TOPICS_URL, wait=5) as s:
            raw = s.evaluate(okx_js, await_promise=True)
        if isinstance(raw, dict):
            if raw.get("via") == "api" and raw.get("json") is not None:
                result["okx"] = _parse_api_rows(raw["json"], platform="okx")
            elif raw.get("links"):
                for i, row in enumerate(raw["links"][:30], start=1):
                    text = str(row.get("text") or "")
                    text = re.sub(r"^\d+\s*", "", text)
                    text = re.sub(r"^#\s*", "", text).strip()
                    result["okx"].append(
                        _item(
                            platform="okx",
                            rank=i,
                            title=text[:160],
                            url=str(row.get("href") or OKX_TOPICS_URL),
                            published_at=_utc_now(),
                        )
                    )
            logger.info("OKX CDP %d 条", len(result["okx"]))
    except Exception as e:
        logger.warning("OKX CDP 失败: %s", e)

    return result


_PUBLISHED_AT_FILE = Path(__file__).resolve().parent / "data" / "hot_published_at.json"


def _load_published_at_map() -> dict[str, str]:
    """URL → published_at (ISO UTC) 的持久化缓存。"""
    try:
        if _PUBLISHED_AT_FILE.is_file():
            raw = json.loads(_PUBLISHED_AT_FILE.read_text(encoding="utf-8"))
            return {str(k): str(v) for k, v in raw.items() if v}
    except Exception:
        pass
    return {}


def _save_published_at_map(m: dict[str, str]) -> None:
    try:
        _PUBLISHED_AT_FILE.parent.mkdir(parents=True, exist_ok=True)
        _PUBLISHED_AT_FILE.write_text(
            json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:
        pass


_RElATIVE_TIME_RE = re.compile(
    r"(\d+)\s*(分钟?|小时?|小时|天|日|周|秒|秒?)前"
    r"|刚才|(半[小时天日])前"
    r"|今天|昨天|前天",
    re.I,
)


def _parse_relative_time(text: str, *, now: datetime) -> datetime | None:
    """把「36分钟前」「2小时前」「昨天」等中文相对时间转 UTC datetime。"""
    t = text.strip()
    m = _RElATIVE_TIME_RE.search(t)
    if not m:
        return None
    span = m.group(0).lower()

    if "秒" in span:
        n = re.search(r"(\d+)", t)
        return now - timedelta(seconds=int(n.group(1) if n else 0))
    if "分钟" in span or "分" in span:
        n = re.search(r"(\d+)", t)
        return now - timedelta(minutes=int(n.group(1) if n else 0))
    if "小时" in span or "小时" in span or "时" in span:
        n = re.search(r"(\d+)", t)
        return now - timedelta(hours=int(n.group(1) if n else 0))
    if "天" in span or "日" in span:
        n = re.search(r"(\d+)", t)
        days = int(n.group(1) if n else 0)
        # 昨天/前天特殊处理
        if "昨天" in t:
            return now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)
        if "前天" in t:
            return now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=2)
        return now - timedelta(days=days)
    if "周" in span:
        n = re.search(r"(\d+)", t)
        return now - timedelta(weeks=int(n.group(1) if n else 0))
    if "半" in span:
        for unit, delta in [("小时", 0.5), ("天", 0.5), ("日", 0.5)]:
            if unit in span:
                return now - timedelta(hours=delta * 24 if "天" in unit else delta)
    if "刚才" in t:
        return now
    if "今天" in t:
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    if "昨天" in t:
        return now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)
    if "前天" in t:
        return now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=2)
    return None


def _blockbeats_time_to_iso(time_str: str, *, now: datetime) -> str:
    """BlockBeats HH:mm → ISO UTC（如 "14:32" → 今日 UTC 14:32）。"""
    try:
        h, m = time_str.strip().split(":")
        dt = now.replace(hour=int(h), minute=int(m), second=0, microsecond=0, tzinfo=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return ""


def _merge_published_at(
    items: list[dict[str, Any]],
    stored: dict[str, str],
    now_ts: int,
) -> list[dict[str, Any]]:
    """
    Merge persisted published_at:
    - Has real published_at → keep
    - None → look up by URL from stored cache
    - Still none → use now_ts
    """
    out = []
    for item in items:
        url = str(item.get("url") or "")
        ts = item.get("published_at")
        if not ts or ts.startswith("1970") or ts.startswith("1969"):
            ts = stored.get(url) or ""
        if not ts:
            ts = datetime.fromtimestamp(now_ts / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        out.append({**item, "published_at": ts})
    return out


async def fetch_hotlists() -> dict[str, Any]:
    import asyncio

    now_ts = int(time.time() * 1000)
    # 加载历史 published_at，按 URL 持久化（热榜帖子跨请求保留发布时间）
    stored = _load_published_at_map()

    binance_t = asyncio.create_task(_fetch_binance_http())
    okx_t = asyncio.create_task(_fetch_okx_http())
    foresight_t = asyncio.create_task(_fetch_foresight_http())
    coindesk_t = asyncio.create_task(_fetch_coindesk_http())
    blockbeats_t = asyncio.create_task(_fetch_blockbeats_http())
    binance, okx, foresight, coindesk, blockbeats = await asyncio.gather(
        binance_t, okx_t, foresight_t, coindesk_t, blockbeats_t
    )

    if not binance or not okx:
        cdp = await asyncio.to_thread(_cdp_hotlists)
        if not binance:
            binance = cdp.get("binance") or []
        if not okx:
            okx = cdp.get("okx") or []

    # 币安再试 HTML
    if not binance:
        try:
            status, html = await _http_get(
                BINANCE_TRENDS_URL,
                headers={"Referer": "https://www.binance.com/", "clienttype": "web"},
            )
            if status == 200:
                binance = _parse_binance_html(html)
        except Exception:
            pass

    # BlockBeats: tags[0] 可能是 HH:mm 相对时间，转 ISO
    now_dt = datetime.fromtimestamp(now_ts / 1000, tz=timezone.utc)
    for item in blockbeats:
        tags = item.get("tags") or []
        for tag in tags:
            if re.fullmatch(r"\d{1,2}:\d{2}", str(tag)):
                iso = _blockbeats_time_to_iso(tag, now=now_dt)
                if iso:
                    item["published_at"] = iso
                    break

    # 对各平台合并历史 published_at
    for board_items in [binance, okx, foresight, coindesk, blockbeats]:
        merged = _merge_published_at(board_items, stored, now_ts)
        # 回写：本次发现新 URL 时更新缓存
        for item in merged:
            url = str(item.get("url") or "")
            ts = item.get("published_at") or ""
            if url and ts and url not in stored:
                stored[url] = ts
        board_items.clear()
        board_items.extend(merged)

    # 持久化新发现的 URL→published_at
    _save_published_at_map(stored)

    payload = {
        "updated_at": _utc_now(),
        "boards": [
            {
                "platform": "binance",
                "label": "币安广场热榜",
                "source_url": BINANCE_TRENDS_URL,
                "items": binance,
            },
            {
                "platform": "okx",
                "label": "OKX 星球热门",
                "source_url": OKX_TOPICS_URL,
                "items": okx,
            },
            {
                "platform": "foresight",
                "label": "Foresight News",
                "source_url": FORESIGHT_HOME_URL,
                "items": foresight,
            },
            {
                "platform": "coindesk",
                "label": "CoinDesk 最新",
                "source_url": COINDESK_LATEST_URL,
                "items": coindesk,
            },
            {
                "platform": "blockbeats",
                "label": "BlockBeats 快讯",
                "source_url": BLOCKBEATS_FLASH_URL,
                "items": blockbeats,
            },
        ],
    }
    logger.info(
        "热榜 binance=%d okx=%d foresight=%d coindesk=%d blockbeats=%d",
        len(binance),
        len(okx),
        len(foresight),
        len(coindesk),
        len(blockbeats),
    )
    return payload
