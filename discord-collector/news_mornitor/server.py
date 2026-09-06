"""FastAPI：宏观日历 + 热榜 + 统一热点事件 API。

⚠️  对外文档在 news_mornitor/docs/api.md，修改接口时请同步更新文档。

路由一览（FastAPI 自动注册）：
  /api/v1/health
  /api/v1/macro/timeline
  /api/v1/hotlists
  /api/v1/events          ← 核心：合并宏观+币圈+热榜，统一父子类目标签
  /api/v1/events/categories ← 类目文档（含完整 desc / star / keywords）
  /api/v1/events/tags    ← 废弃，请用 /events/categories
  /api/v1/refresh
  /api/v1/boards          ← 兼容旧前端，请用 /hotlists
  /api/v1/tickers/trending
  /api/v1/fetch/status
  /api/v1/fetch/start
  /api/v1/fetch/stop
  /api/v1/fetch/now
  /
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from news_mornitor import store
from news_mornitor.hotlists import fetch_hotlists
from news_mornitor.jinshi import fetch_macro, filter_window
from news_mornitor.settings import (
    HOST,
    HOT_REFRESH_SEC,
    MACRO_AHEAD_HOURS,
    MACRO_BEHIND_HOURS,
    MACRO_MIN_STAR,
    MACRO_REFRESH_SEC,
    PORT,
    REFRESH_ALLOW_REMOTE,
    REFRESH_SEC,
)

logger = logging.getLogger("news.server")
STATIC = Path(__file__).resolve().parent / "frontend" / "public"

_refresh_lock = asyncio.Lock()
_task: asyncio.Task | None = None
_LOCAL_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


def _client_is_local(request: Request) -> bool:
    """是否允许触发抓取：直连本机，或显式允许远程。"""
    if REFRESH_ALLOW_REMOTE:
        return True
    host = ""
    if request.client and request.client.host:
        host = str(request.client.host).strip().lower()
    # 去掉 IPv4-mapped IPv6 前缀
    if host.startswith("::ffff:"):
        host = host[7:]
    return host in _LOCAL_HOSTS


def _can_fetch(request: Request, *, refresh: bool, empty: bool) -> bool:
    """本机可 refresh / 冷启动补缓存；远程只读已落盘数据。"""
    if not _client_is_local(request):
        return False
    return bool(refresh or empty)


def _hot_stats(hot: dict[str, Any]) -> dict[str, int]:
    boards = hot.get("boards") or []
    by_plat = {
        str(b.get("platform")): len(b.get("items") or [])
        for b in boards
        if isinstance(b, dict)
    }
    return {
        "binance": by_plat.get("binance", 0),
        "okx": by_plat.get("okx", 0),
        "foresight": by_plat.get("foresight", 0),
        "coindesk": by_plat.get("coindesk", 0),
        "blockbeats": by_plat.get("blockbeats", 0),
    }


async def refresh_macro(*, force: bool = False) -> dict[str, Any]:
    _ = force
    async with _refresh_lock:
        macro = await fetch_macro()
        store.save_macro(macro)
        eco = len(macro.get("economy") or [])
        cry = len(macro.get("crypto") or [])
        return {"macro": eco + cry, "economy": eco, "crypto": cry}


async def refresh_hot(*, force: bool = False) -> dict[str, Any]:
    _ = force
    async with _refresh_lock:
        hot = await fetch_hotlists()
        store.save_hot(hot)
        return _hot_stats(hot)


async def refresh_all(*, force: bool = False) -> dict[str, Any]:
    macro = await refresh_macro(force=force)
    hot = await refresh_hot(force=force)
    return {**macro, **hot}


async def _loop() -> None:
    # 启动稍等再抓，先让 health / 静态页可用
    await asyncio.sleep(2)
    last_macro = 0.0
    last_hot = 0.0
    while True:
        now = time.time()
        try:
            if last_macro <= 0 or now - last_macro >= max(MACRO_REFRESH_SEC, 60):
                stats = await refresh_macro()
                last_macro = time.time()
                logger.info(
                    "宏观定时刷新完成（间隔 %ds）%s",
                    MACRO_REFRESH_SEC,
                    stats,
                )
            if last_hot <= 0 or now - last_hot >= max(HOT_REFRESH_SEC, 60):
                stats = await refresh_hot()
                last_hot = time.time()
                logger.info(
                    "热榜定时刷新完成（间隔 %ds）%s",
                    HOT_REFRESH_SEC,
                    stats,
                )
        except Exception:
            logger.exception("定时刷新失败")
        # 按分钟检查到期；实际抓取按 MACRO/HOT 间隔
        await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _task
    _task = asyncio.create_task(_loop())
    yield
    if _task:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="News Hot", version="2.0.0", lifespan=lifespan)


@app.middleware("http")
async def no_cache_html(request: Request, call_next):
    resp = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith(".html"):
        resp.headers["Cache-Control"] = "no-store, max-age=0"
    elif path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/api/v1/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "status": "ok",
        # 与 auto-deal-eth CryptoPulse 区分；supervisor 凭此识别正确实例
        "service": "news_mornitor",
        "edition": "collector",
        "macro": "jinshi_panews",
        "macro_refresh_sec": MACRO_REFRESH_SEC,
        "hot_refresh_sec": HOT_REFRESH_SEC,
    }


@app.get("/api/v1/macro/timeline")
async def macro_timeline(
    request: Request,
    min_star: int | None = Query(None, ge=1, le=5),
    ahead_hours: int | None = Query(None, ge=1, le=168),
    behind_hours: int | None = Query(None, ge=0, le=168),
    refresh: bool = Query(False),
    channel: str = Query("all", description="economy | crypto | all"),
) -> dict[str, Any]:
    star = MACRO_MIN_STAR if min_star is None else min_star
    ahead = MACRO_AHEAD_HOURS if ahead_hours is None else ahead_hours
    behind = MACRO_BEHIND_HOURS if behind_hours is None else behind_hours
    ch = (channel or "all").strip().lower()
    if ch not in ("economy", "crypto", "all"):
        ch = "all"

    buckets = store.load_macro()
    empty = not buckets.get("economy") and not buckets.get("crypto")
    if _can_fetch(request, refresh=refresh, empty=empty):
        try:
            buckets = await fetch_macro(min_star=star, ahead=ahead, behind=behind)
            store.save_macro(buckets)
        except Exception as e:
            logger.exception("宏观刷新失败")
            return {
                "ok": False,
                "error": str(e),
                "channel": ch,
                "economy": [],
                "crypto": [],
                "items": [],
            }
    elif refresh and not _client_is_local(request):
        logger.info("忽略远程 refresh=1（宏观只读缓存）")

    economy = filter_window(
        list(buckets.get("economy") or []),
        min_star=star,
        ahead=ahead,
        behind=behind,
    )
    crypto = filter_window(
        list(buckets.get("crypto") or []),
        min_star=1,
        ahead=ahead,
        behind=behind,
    )
    if ch == "economy":
        items = economy
    elif ch == "crypto":
        items = crypto
    else:
        items = []  # 默认接口不混排；前端用分桶字段
    return {
        "ok": True,
        "min_star": star,
        "ahead_hours": ahead,
        "behind_hours": behind,
        "timezone": "Asia/Shanghai",
        "channel": ch,
        "economy": economy,
        "crypto": crypto,
        "items": items if ch != "all" else economy,  # 兼容旧前端：默认经济
    }


@app.get("/api/v1/hotlists")
async def hotlists(
    request: Request,
    refresh: bool = Query(False),
) -> dict[str, Any]:
    data = store.load_hot()
    empty = not data.get("boards")
    if _can_fetch(request, refresh=refresh, empty=empty):
        try:
            data = await fetch_hotlists()
            store.save_hot(data)
        except Exception as e:
            logger.exception("热榜刷新失败")
            return {"ok": False, "error": str(e), "boards": []}
    elif refresh and not _client_is_local(request):
        logger.info("忽略远程 refresh=1（热榜只读缓存）")
    return {"ok": True, **data}


@app.post("/api/v1/refresh")
async def refresh_now(request: Request) -> dict[str, Any]:
    if not _client_is_local(request):
        return JSONResponse(
            {
                "ok": False,
                "error": "refresh only on local operator",
                "hint": "CDP/抓取仅本机；生产端请 GET 缓存",
            },
            status_code=403,
        )
    try:
        stats = await refresh_all(force=True)
        return {"ok": True, **stats}
    except Exception as e:
        logger.exception("立即刷新失败")
        return {"ok": False, "error": str(e)}


def _hot_as_legacy_boards(data: dict[str, Any]) -> dict[str, Any]:
    """旧前端 /api/v1/boards 兼容：把热榜映射成可渲染的帖结构。"""
    boards = []
    for b in data.get("boards") or []:
        items = []
        for it in b.get("items") or []:
            items.append(
                {
                    "id": _event_id(it.get("platform") or b.get("platform") or "", it.get("title") or ""),
                    "platform": it.get("platform"),
                    "title": it.get("title"),
                    "summary": it.get("summary") or "",
                    "source_url": it.get("url"),
                    "url": it.get("url"),
                    "author": b.get("label") or it.get("platform"),
                    "likes": 0,
                    "comments": 0,
                    "shares": 0,
                    "rank": it.get("rank"),
                }
            )
        boards.append(
            {
                "platform": b.get("platform"),
                "label": b.get("label"),
                "items": items,
            }
        )
    return {
        "ok": True,
        "boards": boards,
        "time_range": "3d",
        "influential_only": False,
        "min_likes": 0,
        "min_comments": 0,
        "use_mock": False,
        "updated_at": data.get("updated_at"),
    }


# ── 热点事件统一标签映射（父子类目标签）──────────────────────────────────────────
#
# 结构说明：
#   parent_id   : 父类目标签 ID（全局唯一，英文，API 稳定标识）
#   parent_name : 父类目中文名（展示用）
#   parent_desc : 父类目说明（文档用）
#   child_id    : 子类目标签 ID（英文，API 稳定标识）
#   child_name  : 子类目中文名（展示用）
#   child_desc  : 子类目说明（文档用）
#   star        : 推荐星级（0=最低，5=最高）
#   keywords    : 匹配关键词（任一命中即打此标签）
#
# 使用方式：
#   /api/v1/events/categories  → 获取所有类目文档
#   /api/v1/events/tags        → 获取所有标签（兼容旧接口）
#   /api/v1/events            → items[*] 含 category_id（父类目标签 ID）
#

_TAG_CATALOG: list[dict[str, Any]] = [
    # ═══════════════════════════════════════════════════════════
    # 宏观 ──────────────────────────────────────────────────────
    # ═══════════════════════════════════════════════════════════
    {
        "category_id": "macro_fomc",
        "parent": {
            "id": "macro_fomc",
            "name": "美联储议息会议",
            "desc": (
                "FOMC 决议 & 鲍威尔讲话。直接决定全局资金的借贷成本（利息）。"
                "加息或维持高利率（鹰派）→ 抽干市场流动性，引发大跌；"
                "降息或暂停加息（鸽派）→ 释放巨量资金，推升牛市。"
                "会议配套点阵图（对未来几年利率预测）及鲍威尔发布会语气，"
                "往往比利率决定本身引起的盘面波动更大。"
            ),
            "star": 5,
            "keywords": ["FOMC", "美联储", "利率决议", "鲍威尔", "点阵图", "联邦基金利率"],
        },
        "child": {
            "id": "macro_fomc_decision",
            "name": "FOMC 利率决议",
            "desc": "联邦公开市场委员会宣布加息/降息/维持不变的官方决定，即时冲击全球风险资产。",
        },
    },
    {
        "category_id": "macro_cpi",
        "parent": {
            "id": "macro_cpi",
            "name": "美国 CPI（消费者物价指数）",
            "desc": (
                "衡量美国通胀水平的最核心指标。每月月中公布，"
                "公布瞬间 BTC/ETH 经常出现几百甚至上千点的剧烈上下插针。"
                "低于预期（通胀降温）→ 利好币圈，美联储有了降息和放水空间；"
                "高于预期（通胀反弹）→ 利空币圈，美联储可能延缓降息或继续紧缩。"
            ),
            "star": 5,
            "keywords": ["CPI", "PCE", "PPI", "消费者物价", "通胀"],
        },
        "child": {
            "id": "macro_cpi_us",
            "name": "美国 CPI 数据",
            "desc": "美国居民消费价格指数，同比/环比；市场最关注的通胀晴雨表。",
        },
    },
    {
        "category_id": "macro_nfp",
        "parent": {
            "id": "macro_nfp",
            "name": "美国非农就业数据（NFP）",
            "desc": (
                "反映美国劳动力市场强弱，每月第一个周五公布。"
                "新增就业大超预期 → 市场担心美联储维持高利率，短线下挫；"
                "就业极度疲软 → 引发市场对美联储急救式降息预期，但衰退严重也可能短暂带崩风险资产。"
            ),
            "star": 4,
            "keywords": ["非农", "NFP", "就业", "失业率", "大非农", "ADP"],
        },
        "child": {
            "id": "macro_nfp_us",
            "name": "非农就业与失业率",
            "desc": "美国非农新增就业人数 & 失业率；月度最重要劳动力市场数据。",
        },
    },
    {
        "category_id": "macro_qt",
        "parent": {
            "id": "macro_qt",
            "name": "美联储资产负债表政策（QE / QT）",
            "desc": (
                "量化宽松（QE/扩表/放水）是比特币历史性大牛市（如 2020-2021 年）的根本驱动力；"
                "量化紧缩（QT/缩表/抽水）是熊市流动性枯竭的罪魁祸首。"
                "直接影响全球市场资金水位。"
            ),
            "star": 4,
            "keywords": ["QE", "QT", "量化宽松", "量化紧缩", "缩表", "扩表", "美联储资产负债表"],
        },
        "child": {
            "id": "macro_qe_qt",
            "name": "QE / QT 扩表与缩表",
            "desc": "美联储资产规模变动（扩表=放水，缩表=抽水），决定市场整体流动性。",
        },
    },
    {
        "category_id": "macro_economic",
        "parent": {
            "id": "macro_economic",
            "name": "重要经济数据",
            "desc": "GDP、PMI、零售销售等反映经济健康度的指标，影响市场对美联储政策路径的预期。",
            "star": 3,
            "keywords": ["GDP", "国内生产总值", "ISM", "PMI", "零售"],
        },
        "child": {
            "id": "macro_gdp_pmi",
            "name": "GDP / PMI / 零售",
            "desc": "美国 GDP、ISM制造业/非制造业PMI、零售销售等核心经济指标。",
        },
    },
    {
        "category_id": "macro_centralbank",
        "parent": {
            "id": "macro_centralbank",
            "name": "其他央行决议",
            "desc": "欧央行、英格兰银行、日本央行、加拿大央行、澳联储等利率决议与政策声明。",
            "star": 3,
            "keywords": ["欧央行", "英格兰银行", "日本央行", "加拿大央行", "澳联储"],
        },
        "child": {
            "id": "macro_centralbank_other",
            "name": "欧央行 / 英格兰银行 / 日本央行等",
            "desc": "非美联储央行的利率决议、政策声明、行长讲话。",
        },
    },
    # ═══════════════════════════════════════════════════════════
    # 币圈 ──────────────────────────────────────────────────────
    # ═══════════════════════════════════════════════════════════
    {
        "category_id": "crypto_cex_listing",
        "parent": {
            "id": "crypto_cex_listing",
            "name": "交易所上线与爆款标的",
            "desc": (
                "TOP1 币圈热点。头部 CEX（币安 / OKX 等）上线新合约直接带来巨量杠杆流动性，"
                "属于短线暴涨暴跌、资金费率套利与高振幅交易的最核心刺激源。"
                "交易所上币往往伴随社区 FOMO，短期内资金聚集效应最强。"
            ),
            "star": 5,
            "keywords": ["永续合约", "上线", "上市", "币安上线", "OKX上线", "合约", "上新"],
        },
        "child": {
            "id": "crypto_cex_listing_binane_okx",
            "name": "币安 / OKX 上线新合约",
            "desc": "币安或 OKX 上线某币种的永续合约或上市公告，直接带来巨量流动性和关注度。",
        },
    },
    {
        "category_id": "crypto_macro_fomc",
        "parent": {
            "id": "crypto_macro_fomc",
            "name": "顶级宏观经济与美联储决策",
            "desc": (
                "TOP2 币圈热点。决定大盘多空方向与资金水龙头。"
                "FOMC 决议、降息预期、点阵图变化均直接影响加密市场整体风险偏好。"
                "此类事件在 OKX 热榜及社区关注度居高不下。"
            ),
            "star": 5,
            "keywords": ["FOMC", "美联储", "降息", "加息", "鲍威尔", "利率决议"],
        },
        "child": {
            "id": "crypto_fomc_sentiment",
            "name": "FOMC 与美联储决策（影响币圈）",
            "desc": "FOMC 决议及美联储官员表态对加密市场风险偏好的即时影响。",
        },
    },
    {
        "category_id": "crypto_btc_milestone",
        "parent": {
            "id": "crypto_btc_milestone",
            "name": "比特币大盘关口与主流清算",
            "desc": (
                "TOP3 币圈热点。BTC 关键心理关口（整数关口、ETF 数据、爆仓清算额）"
                "决定市场整体风险偏好。突破时全网空单爆仓/清算金额常达数亿美元。"
            ),
            "star": 4,
            "keywords": ["BTC", "比特币", "ETF", "ETH", "以太坊", "山寨", "牛市", "熊市", "爆仓", "清算"],
        },
        "child": {
            "id": "crypto_btc_etf_liquidation",
            "name": "BTC 关口 / ETF / 爆仓清算",
            "desc": "比特币整数关口突破、ETF 净流入流出、大额爆仓清算事件。",
        },
    },
    {
        "category_id": "crypto_eco_meme",
        "parent": {
            "id": "crypto_eco_meme",
            "name": "生态与山寨 Meme 动向",
            "desc": (
                "TOP4 币圈热点。热钱聚集地，包括 DeFi 协议动态、L2 进展、"
                "Meme 币极速造富现象（链上土狗），以及 Robinhood / CEX 资金转移趋势。"
            ),
            "star": 3,
            "keywords": ["Hyperliquid", "HYPE", "生态", "DeFi", "L2", "Layer2", "NFT", "RWA", "Memecoin", "Meme"],
        },
        "child": {
            "id": "crypto_defi_l2_meme",
            "name": "DeFi / L2 / Meme 生态",
            "desc": "DeFi 协议爆发、L2 进展、Meme 币造富现象、链上土狗动态。",
        },
    },
    {
        "category_id": "crypto_fund_flow",
        "parent": {
            "id": "crypto_fund_flow",
            "name": "资金与链上数据",
            "desc": "交易所净流入/流出、比特币 ETF 资金流向、资金费率、合约持仓量等资金面数据。",
            "star": 2,
            "keywords": ["净流入", "净流出", "灰度", "机构", "资金费率", "合约持仓", "链上"],
        },
        "child": {
            "id": "crypto_fund_flow_exchange",
            "name": "资金流向与链上数据",
            "desc": "CEX 净流入流出、ETF 资金流、链上巨鲸动向、资金费率等。",
        },
    },
    # ═══════════════════════════════════════════════════════════
    # 平台（来源平台标签，无星）──────────────────────────────────
    # ═══════════════════════════════════════════════════════════
    {
        "category_id": "platform_binance",
        "parent": {
            "id": "platform_binance",
            "name": "平台-币安",
            "desc": "币安广场热榜（Binance Square Trends）。",
            "star": 0,
            "keywords": ["binance", "币安"],
        },
        "child": {
            "id": "platform_binance",
            "name": "币安广场",
            "desc": "币安广场热榜来源。",
        },
    },
    {
        "category_id": "platform_okx",
        "parent": {
            "id": "platform_okx",
            "name": "平台-OKX",
            "desc": "OKX 星球热门（OKX Orbit Topics）。",
            "star": 0,
            "keywords": ["okx", "OKX"],
        },
        "child": {
            "id": "platform_okx",
            "name": "OKX 星球",
            "desc": "OKX 星球热榜来源。",
        },
    },
    {
        "category_id": "platform_foresight",
        "parent": {
            "id": "platform_foresight",
            "name": "平台-Foresight",
            "desc": "Foresight News 新闻源。",
            "star": 0,
            "keywords": ["foresight", "Foresight"],
        },
        "child": {
            "id": "platform_foresight",
            "name": "Foresight News",
            "desc": "Foresight News 新闻来源。",
        },
    },
    {
        "category_id": "platform_coindesk",
        "parent": {
            "id": "platform_coindesk",
            "name": "平台-CoinDesk",
            "desc": "CoinDesk 最新新闻源。",
            "star": 0,
            "keywords": ["coindesk", "CoinDesk"],
        },
        "child": {
            "id": "platform_coindesk",
            "name": "CoinDesk 最新",
            "desc": "CoinDesk 新闻来源。",
        },
    },
    {
        "category_id": "platform_blockbeats",
        "parent": {
            "id": "platform_blockbeats",
            "name": "平台-BlockBeats",
            "desc": "The BlockBeats 快讯（BlockBeats Flash News）。",
            "star": 0,
            "keywords": ["blockbeats", "BlockBeats", "theblockbeats"],
        },
        "child": {
            "id": "platform_blockbeats",
            "name": "BlockBeats 快讯",
            "desc": "The BlockBeats 快讯来源。",
        },
    },
]

# 快速查找：keyword → category_id
_KEYWORD_TO_CATEGORY: dict[str, str] = {}
for cat in _TAG_CATALOG:
    for kw in cat["parent"].get("keywords") or []:
        _KEYWORD_TO_CATEGORY[kw.lower()] = cat["category_id"]


def _classify(text: str) -> dict[str, Any] | None:
    """对文本做关键词匹配，返回命中的第一个类目标签（category_id）。"""
    text_lower = text.lower()
    for kw, cat_id in _KEYWORD_TO_CATEGORY.items():
        if kw in text_lower:
            for cat in _TAG_CATALOG:
                if cat["category_id"] == cat_id:
                    return cat
    return None


def _event_id(source: str, title: str, publish_at: str | None = None) -> str:
    """生成稳定的事件 ID（防重复请求）。"""
    parts = [source, title]
    if publish_at:
        parts.append(publish_at)
    return hashlib.md5("|".join(parts).encode()).hexdigest()[:16]


def _normalize_event(item: dict[str, Any], *, source: str) -> dict[str, Any] | None:
    """将宏观日历 / 热榜条目规范化为统一事件结构。"""
    title = str(item.get("title") or item.get("name") or "").strip()
    if not title or len(title) < 3:
        return None

    publish_at = str(item.get("publish_at") or item.get("pub_time") or item.get("event_time") or "")
    url = str(item.get("url") or item.get("source_url") or item.get("link") or "")
    description = str(
        item.get("summary")
        or item.get("brief")
        or item.get("desc")
        or item.get("description")
        or ""
    ).strip()

    # 优先用宏观已有的 bias 字段，其次靠关键词自动推断
    bias = str(item.get("bias") or "neutral")
    bias_label = str(item.get("bias_label") or "中性")

    # 按标题+描述做关键词分类，命中第一个即打标签
    text_to_match = f"{title} {description}"
    matched = _classify(text_to_match)
    if matched:
        category_id = matched["category_id"]
        category = matched["parent"]
        child = matched["child"]
    else:
        # 未命中任何类目，按来源平台打标签
        category_id = ""
        category = {}
        child = {}

    return {
        "id": _event_id(source, title, publish_at or None),
        "title": title[:200],
        "description": description[:500],
        # 分类：category_id = 父类目标签 ID（外部筛选用），category = 父类目详情，child = 子类目详情
        "category_id": category_id,
        "category": category,
        "child": child,
        "source": source,
        "url": url,
        "publish_at": publish_at or None,
        # 宏观特有字段（热榜条目可能为空）
        "star": item.get("star") or 0,
        "country": item.get("country") or "",
        "phase": item.get("phase") or "",
        "bias": bias,
        "bias_label": bias_label,
        # 热榜特有字段
        "platform": item.get("platform") or "",
    }


@app.get("/api/v1/events")
async def events(
    request: Request,
    channel: str = Query("all", description="all | economy | crypto | hot"),
    min_star: int = Query(1, ge=0, le=5),
    limit: int = Query(50, ge=1, le=200),
    refresh: bool = Query(False),
    category_id: str = Query("", description="按 category_id 过滤（如 macro_fomc, crypto_cex_listing）"),
) -> dict[str, Any]:
    """
    统一热点事件 API，合并宏观日历 + 币圈事件 + 热榜，统一打标签。

    返回字段说明：
      - id          : 稳定哈希 ID，外部可凭此去重
      - title       : 事件标题
      - description : 事件描述
      - category_id : 父类目标签 ID（筛选用，如 macro_fomc / crypto_cex_listing）
      - category    : 父类目详情 { id, name, desc, star }
      - child       : 子类目详情 { id, name, desc }
      - source      : 数据来源（jinshi / panews / hotlist-{platform}）
      - url         : 原始链接
      - publish_at  : 发布时间（UTC ISO）
      - star        : 星级（0-5）
      - country     : 国家
      - phase       : past | upcoming
      - bias        : bullish | bearish | neutral
      - bias_label  : 利好 | 利空 | 中性
    """
    ch = (channel or "all").strip().lower()
    cat_filter = category_id.strip().lower()

    # ── 1. 宏观日历 ──────────────────────────────────────────────────────────────
    economy_events: list[dict] = []
    if ch in ("all", "economy"):
        macro = store.load_macro()
        empty = not macro.get("economy") and not macro.get("crypto")
        if _can_fetch(request, refresh=refresh, empty=empty):
            try:
                macro = await fetch_macro()
                store.save_macro(macro)
            except Exception:
                pass
        for item in macro.get("economy") or []:
            ev = _normalize_event(item, source="jinshi")
            if ev:
                economy_events.append(ev)

    # ── 2. 币圈事件（PANews） ───────────────────────────────────────────────────
    crypto_events: list[dict] = []
    if ch in ("all", "crypto"):
        macro = store.load_macro()
        for item in macro.get("crypto") or []:
            ev = _normalize_event(item, source="panews")
            if ev:
                crypto_events.append(ev)

    # ── 3. 热榜 ─────────────────────────────────────────────────────────────────
    hot_events: list[dict] = []
    if ch in ("all", "hot"):
        hot = store.load_hot()
        empty = not hot.get("boards")
        if _can_fetch(request, refresh=refresh, empty=empty):
            try:
                hot = await fetch_hotlists()
                store.save_hot(hot)
            except Exception:
                pass
        for board in hot.get("boards") or []:
            plat = str(board.get("platform") or "")
            for item in board.get("items") or []:
                ev = _normalize_event({**item, "platform": plat}, source=f"hotlist-{plat}")
                if ev:
                    hot_events.append(ev)

    # ── 4. 合并 + 过滤星级 + 按 category_id 过滤 ────────────────────────────────
    all_events = economy_events + crypto_events + hot_events
    if min_star > 0:
        all_events = [e for e in all_events if int(e.get("star") or 0) >= min_star]
    if cat_filter:
        all_events = [e for e in all_events if e.get("category_id") == cat_filter]

    # 优先展示宏观事件，其次按星级+时间倒序
    def _sort_key(e: dict) -> tuple:
        star = int(e.get("star") or 0)
        is_macro = e["source"] in ("jinshi", "panews")
        t = e.get("publish_at") or ""
        try:
            ts = int(t.replace("-", "").replace(":", "").replace("T", "")[:12])
        except Exception:
            ts = 0
        return (not is_macro, -star, -ts)

    all_events.sort(key=_sort_key)
    total = len(all_events)
    items = all_events[:limit]

    # 类目统计（按 category_id 计数）
    category_counts: dict[str, int] = {}
    for e in all_events:
        cid = e.get("category_id") or ""
        if cid:
            category_counts[cid] = category_counts.get(cid, 0) + 1

    return {
        "ok": True,
        "total": total,
        "limit": limit,
        "channel": ch,
        "min_star": min_star,
        "category_id_filter": cat_filter or None,
        "economy_count": len(economy_events),
        "crypto_count": len(crypto_events),
        "hot_count": len(hot_events),
        "category_counts": dict(sorted(category_counts.items(), key=lambda x: -x[1])),
        "items": items,
    }


@app.get("/api/v1/events/categories")
async def events_categories() -> dict[str, Any]:
    """
    类目文档 API：返回所有类目标签及其说明。

    结构说明：
      - category_id : 全局唯一标识符，GET /events?category_id=xxx 筛选用
      - parent      : 父类目
        - id         : 同 category_id
        - name       : 中文展示名
        - desc       : 完整说明（影响逻辑、市场含义）
        - star       : 推荐星级（0-5，5为最重要）
        - keywords    : 内部匹配关键词（勿用于外部逻辑）
      - child       : 子类目
        - id         : 子类目标签 ID
        - name       : 中文展示名
        - desc       : 子类目说明

    调用方使用建议：
      1. 启动时调一次 /events/categories 缓存类目表
      2. 用 parent.name 渲染下拉选项
      3. 用 category_id 作为筛选参数传给 /events
    """
    categories = []
    for cat in _TAG_CATALOG:
        parent = cat["parent"]
        child = cat["child"]
        categories.append(
            {
                "category_id": cat["category_id"],
                "parent": {
                    "id": parent["id"],
                    "name": parent["name"],
                    "desc": parent["desc"],
                    "star": parent["star"],
                    "keywords": parent.get("keywords") or [],
                },
                "child": {
                    "id": child["id"],
                    "name": child["name"],
                    "desc": child["desc"],
                },
            }
        )
    return {"ok": True, "total": len(categories), "categories": categories}


# 兼容旧接口（保留但废弃）
@app.get("/api/v1/events/tags")
async def events_tags() -> dict[str, Any]:
    """废弃接口：请改用 GET /events/categories。"""
    return await events_categories()


# ── 原有兼容接口 ────────────────────────────────────────────────────────────────

@app.get("/api/v1/boards")
async def boards_compat(
    request: Request,
    refresh: bool = Query(False),
    limit: int = Query(20, ge=1, le=50),
    time_range: str = Query("3d"),
) -> dict[str, Any]:
    """兼容旧缓存前端；新前端请用 /api/v1/hotlists。"""
    _ = limit, time_range
    data = store.load_hot()
    empty = not data.get("boards")
    if _can_fetch(request, refresh=refresh, empty=empty):
        try:
            data = await fetch_hotlists()
            store.save_hot(data)
        except Exception as e:
            return {"ok": False, "error": str(e), "boards": []}
    return _hot_as_legacy_boards(data)


@app.get("/api/v1/tickers/trending")
def tickers_compat(limit: int = Query(10, ge=1, le=50)) -> dict[str, Any]:
    _ = limit
    return {"ok": True, "items": []}


@app.get("/api/v1/fetch/status")
def fetch_status_compat() -> dict[str, Any]:
    return {
        "ok": True,
        "enabled": True,
        "running": False,
        "interval_sec": REFRESH_SEC,
        "macro_refresh_sec": MACRO_REFRESH_SEC,
        "hot_refresh_sec": HOT_REFRESH_SEC,
        "remain_sec": 0,
    }


@app.post("/api/v1/fetch/start")
@app.post("/api/v1/fetch/stop")
@app.post("/api/v1/fetch/now")
async def fetch_control_compat(request: Request) -> dict[str, Any]:
    if not _client_is_local(request):
        return JSONResponse(
            {"ok": False, "error": "refresh only on local operator"},
            status_code=403,
        )
    try:
        stats = await refresh_all(force=True)
        return {"ok": True, **stats}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(
        STATIC / "index.html",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


if STATIC.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


def main(host: str | None = None, port: int | None = None) -> None:
    import uvicorn

    uvicorn.run(
        "news_mornitor.server:app",
        host=host or HOST,
        port=port or PORT,
        reload=False,
        log_level="info",
    )
