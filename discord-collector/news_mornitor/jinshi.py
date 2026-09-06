"""金十财经日历。"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from news_mornitor.settings import (
    CDP_ENABLED,
    CHROME_DEBUG_PORT,
    HTTP_TIMEOUT,
    JINSHI_CDN,
    MACRO_AHEAD_HOURS,
    MACRO_BEHIND_HOURS,
    MACRO_MIN_STAR,
    proxy_url,
)

logger = logging.getLogger("news.jinshi")
TZ = ZoneInfo("Asia/Shanghai")

_WEEKDAY = {"周一": 0, "周二": 1, "周三": 2, "周四": 3, "周五": 4, "周六": 5, "周日": 6}
_COUNTRY = (
    "美国",
    "中国",
    "欧元区",
    "欧央行",
    "英国",
    "德国",
    "法国",
    "瑞士",
    "日本",
    "韩国",
    "加拿大",
    "澳大利亚",
    "新西兰",
)


def _now() -> datetime:
    return datetime.now(TZ)


def _to_utc_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _eid(*parts: str) -> str:
    return hashlib.md5("|".join(parts).encode()).hexdigest()[:16]


def _s(v: Any) -> str | None:
    if v is None:
        return None
    t = str(v).strip()
    if not t or t.lower() in ("nan", "none", "-", "—", "--", "null"):
        return None
    return t


def _parse_dt(raw: Any) -> datetime | None:
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        ts = float(raw)
        if ts > 1e12:
            ts /= 1000
        return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(TZ)
    s = str(raw).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s[:19], fmt).replace(tzinfo=TZ)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(TZ)
    except ValueError:
        return None


def _bias(title: str) -> tuple[str, str]:
    rules = [
        (["降息", "鸽派", "QE"], "bullish", "宽松预期"),
        (["加息", "鹰派", "缩表", "QT"], "bearish", "紧缩预期"),
        (["CPI", "PCE", "通胀"], "bearish", "通胀相关"),
        (["非农", "失业", "就业"], "neutral", "就业数据"),
        (["利率", "FOMC", "美联储", "央行"], "neutral", "政策节点"),
    ]
    for keys, b, reason in rules:
        if any(k in title for k in keys):
            return b, reason
    return "neutral", ""


def _label(b: str) -> str:
    return {"bullish": "利好", "bearish": "利空"}.get(b, "中性")


def _event_dict(
    *,
    title: str,
    country: str,
    star: int,
    publish_at: str,
    previous: str | None = None,
    consensus: str | None = None,
    actual: str | None = None,
    source: str = "jinshi",
    source_url: str = "https://rili.jin10.com/",
) -> dict[str, Any]:
    bias, reason = _bias(title)
    try:
        ts = datetime.fromisoformat(publish_at.replace("Z", "+00:00")).astimezone(TZ)
        phase = "past" if ts < _now() else "upcoming"
        beijing = ts.isoformat(timespec="minutes")
    except ValueError:
        phase, beijing = "upcoming", publish_at
    return {
        "id": _eid(source, country, publish_at, title),
        "title": title,
        "country": country,
        "star": star,
        "publish_at": publish_at,
        "publish_at_beijing": beijing,
        "previous": previous,
        "consensus": consensus,
        "actual": actual,
        "bias": bias,
        "bias_label": _label(bias),
        "bias_reason": reason,
        "phase": phase,
        "source": source,
        "source_url": source_url,
    }


def filter_window(
    items: list[dict[str, Any]],
    *,
    min_star: int = MACRO_MIN_STAR,
    ahead: int = MACRO_AHEAD_HOURS,
    behind: int = MACRO_BEHIND_HOURS,
) -> list[dict[str, Any]]:
    start = _now() - timedelta(hours=max(behind, 0))
    end = _now() + timedelta(hours=max(ahead, 0))
    out = []
    for e in items:
        if int(e.get("star") or 0) < min_star:
            continue
        try:
            ts = datetime.fromisoformat(str(e["publish_at"]).replace("Z", "+00:00")).astimezone(TZ)
        except Exception:
            continue
        if ts < start or ts > end:
            continue
        out.append(e)
    out.sort(key=lambda x: x.get("publish_at") or "")
    return out


def _rows(data: Any) -> list[dict]:
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for k in ("data", "list", "result"):
            v = data.get(k)
            if isinstance(v, list):
                return [x for x in v if isinstance(x, dict)]
            if isinstance(v, dict) and isinstance(v.get("list"), list):
                return [x for x in v["list"] if isinstance(x, dict)]
    return []


def _parse_json_payload(data: Any, *, is_event: bool) -> list[dict[str, Any]]:
    out = []
    for row in _rows(data):
        if is_event:
            title = _s(row.get("event_content") or row.get("name") or row.get("title")) or ""
        else:
            country = _s(row.get("country") or row.get("country_name")) or ""
            period = _s(row.get("time_period")) or ""
            name = _s(row.get("name") or row.get("indicator_name") or row.get("title")) or ""
            title = f"{country}{period}{name}".strip() or name
        if not title:
            continue
        try:
            star = int(float(row.get("star") or row.get("importance") or 0))
        except (TypeError, ValueError):
            star = 0
        country = _s(row.get("country") or row.get("country_name")) or ""
        dt = _parse_dt(
            row.get("pub_time") or row.get("event_time") or row.get("time") or row.get("date")
        )
        if not dt:
            continue
        out.append(
            _event_dict(
                title=title,
                country=country,
                star=max(0, min(5, star)),
                publish_at=_to_utc_iso(dt),
                previous=_s(row.get("previous")),
                consensus=_s(row.get("consensus")),
                actual=_s(row.get("actual")),
                source="jinshi",
            )
        )
    return out


def _cdn_urls(ahead: int, behind: int) -> list[tuple[str, bool]]:
    start = (_now() - timedelta(hours=behind)).date()
    end = (_now() + timedelta(hours=ahead)).date()
    months: list[tuple[int, int]] = []
    cur = date(start.year, start.month, 1)
    last = date(end.year, end.month, 1)
    while cur <= last:
        months.append((cur.year, cur.month))
        cur = date(cur.year + (1 if cur.month == 12 else 0), 1 if cur.month == 12 else cur.month + 1, 1)
    weeks: list[tuple[int, int]] = []
    d = start
    seen: set[tuple[int, int]] = set()
    while d <= end:
        iso = d.isocalendar()
        key = (int(iso.year), int(iso.week))
        if key not in seen:
            seen.add(key)
            weeks.append(key)
        d += timedelta(days=1)
    urls: list[tuple[str, bool]] = []
    for y, m in months:
        urls.append((f"{JINSHI_CDN}/{y}/month/{m}/economics.json", False))
        urls.append((f"{JINSHI_CDN}/{y}/month/{m}/event.json", True))
    for y, w in weeks:
        urls.append((f"{JINSHI_CDN}/{y}/week/{w}/economics.json", False))
        urls.append((f"{JINSHI_CDN}/{y}/week/{w}/event.json", True))
    return urls


async def _http_get(url: str) -> str | None:
    import aiohttp

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json,*/*",
        "Referer": "https://rili.jin10.com/",
        "Origin": "https://rili.jin10.com",
    }
    try:
        timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT)
        async with aiohttp.ClientSession(headers=headers, trust_env=True) as sess:
            async with sess.get(url, timeout=timeout, proxy=proxy_url()) as resp:
                if resp.status != 200:
                    return None
                text = await resp.text()
                return text if text.strip()[:1] in "{[" else None
    except Exception as e:
        logger.debug("jinshi http fail %s: %s", url, e)
        return None


async def _fetch_cdn() -> list[dict[str, Any]]:
    by_id: dict[str, dict] = {}
    for url, is_event in _cdn_urls(MACRO_AHEAD_HOURS, MACRO_BEHIND_HOURS):
        text = await _http_get(url)
        if not text:
            continue
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            continue
        for e in _parse_json_payload(data, is_event=is_event):
            by_id[e["id"]] = e
        logger.info("金十 CDN %s → ok", url.split("/web_data/", 1)[-1])
    return list(by_id.values())


def _guess_country(title: str) -> str:
    for c in _COUNTRY:
        if title.startswith(c) or c in title[:6]:
            return "欧元区" if c == "欧央行" else c
    return ""


def _parse_week_text(text: str) -> list[dict[str, Any]]:
    m = re.search(
        r"(\d{4})年(\d{1,2})月(\d{1,2})日\s*[-–—]\s*(\d{4})年(\d{1,2})月(\d{1,2})日",
        text,
    )
    if m:
        week_start = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    else:
        today = _now().date()
        week_start = today - timedelta(days=today.weekday())

    mm = re.search(r"(周一|Mon\.?)", text)
    body = text[mm.start() :] if mm else text
    body = re.split(r"重要事件壁纸|各国/地区央行|声明：", body, maxsplit=1)[0]
    lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
    day_off = None
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    i = 0
    while i < len(lines):
        line = lines[i]
        hit = next((off for k, off in _WEEKDAY.items() if line.startswith(k)), None)
        if hit is not None:
            day_off = hit
            i += 1
            continue
        tm = re.match(r"^(\d{1,2}):(\d{2})$", line)
        if tm and day_off is not None:
            title = ""
            if i + 1 < len(lines) and not re.match(r"^\d{1,2}:\d{2}$", lines[i + 1]):
                nxt = lines[i + 1]
                if not any(nxt.startswith(k) for k in _WEEKDAY):
                    title = nxt
                    i += 1
            i += 1
            if not title:
                continue
            d = week_start + timedelta(days=day_off)
            dt = datetime(d.year, d.month, d.day, int(tm.group(1)), int(tm.group(2)), tzinfo=TZ)
            star = 5 if any(k in title for k in ("非农", "利率", "FOMC", "CPI", "央行")) else 3
            ev = _event_dict(
                title=title,
                country=_guess_country(title),
                star=star,
                publish_at=_to_utc_iso(dt),
                source="jinshi_week",
            )
            if ev["id"] not in seen:
                seen.add(ev["id"])
                out.append(ev)
            continue
        i += 1
    return out


def _fetch_week_dom() -> list[dict[str, Any]]:
    if not CDP_ENABLED:
        return []
    try:
        from news_mornitor.cdp import CdpError, chrome_alive, with_page

        if not chrome_alive(CHROME_DEBUG_PORT):
            logger.warning("金十 DOM：Chrome :%s 未就绪", CHROME_DEBUG_PORT)
            return []
        js = """
(() => {
  const el = document.querySelector('.desktop-setup')
    || document.querySelector('.desktop-card')
    || document.querySelector('.jin-layout-content__right');
  return (el && el.innerText) || document.body.innerText || '';
})()
"""
        with with_page(CHROME_DEBUG_PORT, "https://rili.jin10.com/", wait=3.5) as s:
            text = s.evaluate(js) or ""
        items = _parse_week_text(str(text))
        if items:
            logger.info("金十周历 DOM %d 条", len(items))
        return items
    except Exception as e:
        logger.warning("金十 DOM 失败: %s", e)
        return []


async def fetch_macro(
    *,
    min_star: int | None = None,
    ahead: int | None = None,
    behind: int | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """分别抓取经济日历（金十）与币圈事件（PANews），不混排。"""
    import asyncio

    from news_mornitor.panews import fetch_panews_macro

    star = MACRO_MIN_STAR if min_star is None else min_star
    ah = MACRO_AHEAD_HOURS if ahead is None else ahead
    bh = MACRO_BEHIND_HOURS if behind is None else behind

    jinshi_t = asyncio.create_task(_fetch_cdn())
    panews_t = asyncio.create_task(fetch_panews_macro(ahead=ah, behind=bh))
    raw, panews = await asyncio.gather(jinshi_t, panews_t)
    if not raw:
        raw = await asyncio.to_thread(_fetch_week_dom)

    economy = filter_window(raw, min_star=star, ahead=ah, behind=bh)
    # 币圈事件：已按类别映射星级，仍走同一时间窗；不过滤掉低星以免日历过空
    crypto = filter_window(panews, min_star=1, ahead=ah, behind=bh)
    logger.info(
        "宏观日历 经济=%d 币圈=%d（经济≥%s★）",
        len(economy),
        len(crypto),
        star,
    )
    return {"economy": economy, "crypto": crypto}
