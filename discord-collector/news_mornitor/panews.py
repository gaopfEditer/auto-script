"""PANews 事件日历（universal-api，免费公开）。"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from news_mornitor.settings import (
    HTTP_TIMEOUT,
    MACRO_AHEAD_HOURS,
    MACRO_BEHIND_HOURS,
    PANEWS_API_BASE,
    PANEWS_CALENDAR_URL,
    proxy_url,
)

logger = logging.getLogger("news.panews")
TZ = ZoneInfo("Asia/Shanghai")

# 无官方星级：按事件类型映射到 3–5，便于与金十 min_star 过滤对齐
_STAR_BY_CATEGORY = {
    "特别关注": 5,
    "政策&宏观": 5,
    "科技巨头财报": 4,
    "代币解锁": 4,
    "CEX & TGE": 4,
    "项目动态": 3,
    "活动": 3,
    "空投": 3,
    "其他": 3,
}


def _now() -> datetime:
    return datetime.now(TZ)


def _to_utc_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _eid(*parts: str) -> str:
    return hashlib.md5("|".join(parts).encode()).hexdigest()[:16]


def _pick_lang(translations: list[dict[str, Any]] | None, *, field: str = "title") -> str:
    rows = [t for t in (translations or []) if isinstance(t, dict)]
    for lang in ("zh", "zh-hans", "zh-cn", "en"):
        for t in rows:
            if str(t.get("lang") or "").lower() == lang and t.get(field):
                return str(t[field]).strip()
    for t in rows:
        if t.get(field):
            return str(t[field]).strip()
    return ""


def _bias(title: str, category: str) -> tuple[str, str]:
    rules = [
        (["降息", "鸽派", "QE", "宽松"], "bullish", "宽松预期"),
        (["加息", "鹰派", "缩表", "QT", "下架", "关停", "暂停"], "bearish", "紧缩/风险"),
        (["CPI", "PCE", "通胀", "非农"], "neutral", "宏观数据"),
        (["解锁"], "bearish", "代币解锁"),
        (["空投"], "bullish", "空投"),
    ]
    for keys, b, reason in rules:
        if any(k in title for k in keys):
            return b, reason
    if category in ("政策&宏观", "特别关注"):
        return "neutral", category
    if category == "代币解锁":
        return "bearish", "代币解锁"
    return "neutral", category or ""


def _label(b: str) -> str:
    return {"bullish": "利好", "bearish": "利空"}.get(b, "中性")


def _parse_start(raw: Any) -> datetime | None:
    if not raw:
        return None
    s = str(raw).strip()
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(TZ)
    except ValueError:
        return None


def _event_url(row: dict[str, Any]) -> str:
    url = (row.get("url") or "").strip()
    if url.startswith("http"):
        return url
    article_id = row.get("articleId")
    if article_id:
        return f"https://www.panewslab.com/zh/articles/{article_id}"
    return PANEWS_CALENDAR_URL


async def _http_json(path: str, params: dict[str, Any] | None = None) -> Any:
    import aiohttp

    q = urlencode({k: str(v) for k, v in (params or {}).items()}, safe=",:")
    url = f"{PANEWS_API_BASE.rstrip('/')}{path}"
    if q:
        url = f"{url}?{q}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": PANEWS_CALENDAR_URL,
        "Origin": "https://www.panewslab.com",
    }
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT)
    async with aiohttp.ClientSession(headers=headers, trust_env=True) as sess:
        async with sess.get(url, timeout=timeout, proxy=proxy_url()) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise RuntimeError(f"PANews {path} HTTP {resp.status}: {text[:160]}")
            return await resp.json(content_type=None)


async def _categories() -> dict[str, str]:
    data = await _http_json("/calendar/categories")
    out: dict[str, str] = {}
    if not isinstance(data, list):
        return out
    for row in data:
        if not isinstance(row, dict):
            continue
        cid = str(row.get("id") or "")
        name = _pick_lang(row.get("translations"), field="name")
        if cid and name:
            out[cid] = name
    return out


async def _events_between(start_utc: str, end_utc: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    skip = 0
    take = 100
    while True:
        batch = await _http_json(
            "/calendar/events",
            {
                "take": take,
                "skip": skip,
                "startAt": f"between,{start_utc},{end_utc}",
            },
        )
        if not isinstance(batch, list) or not batch:
            break
        out.extend(row for row in batch if isinstance(row, dict))
        if len(batch) < take:
            break
        skip += take
        if skip >= 500:
            break
    return out


def _to_macro_item(row: dict[str, Any], cats: dict[str, str]) -> dict[str, Any] | None:
    title = _pick_lang(row.get("translations"), field="title")
    if not title:
        return None
    dt = _parse_start(row.get("startAt"))
    if not dt:
        return None
    cat = cats.get(str(row.get("categoryId") or ""), "") or "其他"
    star = _STAR_BY_CATEGORY.get(cat, 3)
    bias, reason = _bias(title, cat)
    publish_at = _to_utc_iso(dt)
    phase = "past" if dt < _now() else "upcoming"
    return {
        "id": _eid("panews", str(row.get("id") or ""), publish_at, title),
        "title": title[:200],
        "country": cat,
        "star": star,
        "publish_at": publish_at,
        "publish_at_beijing": dt.isoformat(timespec="minutes"),
        "previous": None,
        "consensus": None,
        "actual": None,
        "bias": bias,
        "bias_label": _label(bias),
        "bias_reason": reason,
        "phase": phase,
        "source": "panews",
        "source_url": _event_url(row),
        "ignore_time": bool(row.get("ignoreTime")),
        "category": cat,
    }


async def fetch_panews_macro(
    *,
    ahead: int = MACRO_AHEAD_HOURS,
    behind: int = MACRO_BEHIND_HOURS,
) -> list[dict[str, Any]]:
    start = (_now() - timedelta(hours=max(behind, 0))).astimezone(timezone.utc)
    end = (_now() + timedelta(hours=max(ahead, 0))).astimezone(timezone.utc)
    start_s = start.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    end_s = end.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    try:
        cats = await _categories()
        rows = await _events_between(start_s, end_s)
    except Exception as e:
        logger.warning("PANews 日历失败: %s", e)
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        item = _to_macro_item(row, cats)
        if not item or item["id"] in seen:
            continue
        seen.add(item["id"])
        out.append(item)
    logger.info("PANews 日历 %d 条", len(out))
    return out
