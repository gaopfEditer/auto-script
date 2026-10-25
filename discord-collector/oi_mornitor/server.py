"""aiohttp Web 服务：动态雷达 API + React 构建产物 + SSE 推送。"""

from __future__ import annotations



import asyncio

import json

import logging

from pathlib import Path

from typing import Any



from aiohttp import web



from oi_mornitor.config import PATTERN_CHART_DEFAULT_LIMIT, SCAN_INTERVAL_SEC, WEB_HOST, WEB_PORT
from oi_mornitor.derivatives_metrics import build_derivatives_context, fetch_premium_index
from oi_mornitor.pattern_monitor import fetch_open_interest_hist, fetch_pattern_klines
from oi_mornitor.radar import get_service
from oi_mornitor.cards.card_ws import register_card_routes



logger = logging.getLogger("OI_Web")

# 静态文件路径（按优先级）：
# 1. public/oi-dist/   — npm run build 产物，与 Vue 前端一起 rsync 部署
# 2. static/dist/       — 开发模式（build 产物在别处或为空）
_OI_ROOT = Path(__file__).resolve().parent
_PUBLIC_OI_DIST = _OI_ROOT / "public" / "oi-dist"
_STATIC_DIST = _OI_ROOT / "static" / "dist"
STATIC_DIST = _PUBLIC_OI_DIST if _PUBLIC_OI_DIST.exists() else _STATIC_DIST





def _json_response(data: Any, status: int = 200) -> web.Response:

    return web.Response(

        text=json.dumps(data, ensure_ascii=False, default=str),

        content_type="application/json",

        status=status,

    )





async def handle_index(_request: web.Request) -> web.FileResponse:

    index = STATIC_DIST / "index.html"

    if not index.exists():

        raise web.HTTPNotFound(

            text="前端未构建。请运行: cd oi_mornitor/frontend && npm install && npm run build"

        )

    resp = web.FileResponse(index)
    # 避免浏览器缓存旧 index，导致刷新仍指向过期 hash 资源
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    return resp





async def handle_health(_request: web.Request) -> web.Response:
    """轻量探活（供 collect:ui / supervisor 使用；勿用 /api/snapshot）。"""
    root = str(Path(__file__).resolve().parent)
    index = STATIC_DIST / "index.html"
    ui_build = ""
    try:
        if index.exists():
            # mtime + size：oi:ui:build 后 iframe 可据此强制重载
            st = index.stat()
            ui_build = f"{int(st.st_mtime)}-{st.st_size}"
    except OSError:
        ui_build = ""
    return _json_response(
        {
            "ok": True,
            "service": "oi_mornitor",
            "package_root": root,
            "ui_build": ui_build,
        }
    )


async def handle_snapshot(_request: web.Request) -> web.Response:

    snap = get_service().get_snapshot()

    return _json_response(snap)





async def handle_hot(_request: web.Request) -> web.Response:

    snap = get_service().get_snapshot()

    return _json_response({"hot_tickers": snap["hot_tickers"], "scan_ts": snap["scan_ts"]})





async def handle_matrix(_request: web.Request) -> web.Response:

    matrix = await get_service().get_market_matrix()

    return _json_response(matrix)


async def handle_dormant_funnel(_request: web.Request) -> web.Response:
    """顶栏「沉寂拉盘」：三阶段漏斗候选 + 近期点火。"""
    from oi_mornitor.dormant_funnel_store import get_funnel_payload

    return _json_response(get_funnel_payload())


async def handle_potential_discovery(_request: web.Request) -> web.Response:
    """形态页「潜力发现」：多模型共振列表。"""
    from oi_mornitor.potential_discovery_runner import get_potential_scan_diagnostics
    from oi_mornitor.potential_discovery_store import get_discovery_payload
    from oi_mornitor.potential_models_config import load_potential_config

    from oi_mornitor.potential_discovery_config import POTENTIAL_SOFT_EXPORT_MIN

    payload = get_discovery_payload()
    exp = load_potential_config().get("export") or {}
    payload["score_list_min"] = exp.get("score_list_min")
    payload["soft_export_min"] = POTENTIAL_SOFT_EXPORT_MIN
    payload["scan_diagnostics"] = get_potential_scan_diagnostics()
    return _json_response(payload)


async def handle_binance_leaderboards(request: web.Request) -> web.Response:
    """顶栏榜单：币安 U 本位永续 24h 涨跌幅 / 成交 / 持仓 / 热门。"""
    from oi_mornitor.binance_leaderboards import get_binance_leaderboards

    force = str(request.query.get("force") or "").lower() in ("1", "true", "yes")
    snap = get_service().get_snapshot()
    payload = await get_binance_leaderboards(
        force=force,
        radar_fallback={
            "all_tickers": snap.get("all_tickers") or [],
            "hot_tickers": snap.get("hot_tickers") or [],
        },
    )
    return _json_response(payload)





async def handle_patterns(_request: web.Request) -> web.Response:
    svc = get_service()
    return _json_response(
        svc.pattern_engine.get_payload(
            pool_meta=svc.radar.last_pool_meta,
            fallback_symbols=svc.radar.heavyweight_symbol_list,
        )
    )




async def handle_patterns_watch_post(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return _json_response({"ok": False, "error": "invalid json"}, status=400)

    symbol = str(body.get("symbol", "")).strip().upper()
    if not symbol:
        return _json_response({"ok": False, "error": "symbol required"}, status=400)

    # 默认视为手动输入（形态页输入框 / 图表「添加到列表」）；auto=1 走普通加池（满则失败）
    mode = str(body.get("mode") or body.get("slot") or "").strip().lower()
    auto_flag = body.get("auto")
    is_manual = True
    if mode in ("auto", "hot", "system"):
        is_manual = False
    elif auto_flag is True or str(auto_flag).lower() in ("1", "true", "yes", "on"):
        is_manual = False
    elif body.get("manual") is False:
        is_manual = False

    eng = get_service().pattern_engine
    if is_manual:
        result = eng.add_manual_symbol(symbol)
        if not result.get("ok"):
            return _json_response(
                {
                    "ok": False,
                    "error": result.get("error") or "add failed or watchlist full",
                    "replaced": result.get("replaced"),
                },
                status=400,
            )
        return _json_response(
            {
                "ok": True,
                "symbol": result.get("symbol"),
                "replaced": result.get("replaced"),
                "already": bool(result.get("already")),
                "manual": True,
                "watchlist": eng.get_watchlist(),
                "manual_slot_symbol": eng.tracker.get_manual_slot_symbol(),
            }
        )

    ok = eng.add_symbol(symbol)
    if not ok:
        return _json_response({"ok": False, "error": "add failed or watchlist full"}, status=400)
    return _json_response({"ok": True, "watchlist": eng.get_watchlist()})


async def handle_patterns_watch_delete(request: web.Request) -> web.Response:

    symbol = request.query.get("symbol", "").strip().upper()

    if not symbol:

        return _json_response({"ok": False, "error": "symbol required"}, status=400)

    ok = get_service().pattern_engine.remove_symbol(symbol)

    return _json_response({"ok": ok, "watchlist": get_service().pattern_engine.get_watchlist()})


async def handle_patterns_watch_pin(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return _json_response({"ok": False, "error": "invalid json"}, status=400)
    symbol = str(body.get("symbol", "")).strip().upper()
    if not symbol:
        return _json_response({"ok": False, "error": "symbol required"}, status=400)
    # pinned=false / action=unpin → 取消置顶；默认置顶一天
    action = str(body.get("action", "")).strip().lower()
    pinned_flag = body.get("pinned")
    want_unpin = action in ("unpin", "clear", "cancel") or pinned_flag is False
    svc = get_service()
    if want_unpin:
        ok = svc.pattern_engine.unpin_symbol(symbol)
        if not ok:
            return _json_response(
                {"ok": False, "error": "symbol not pinned or not in watchlist"},
                status=404,
            )
    else:
        ok = svc.pattern_engine.pin_symbol_to_top(symbol)
        if not ok:
            return _json_response({"ok": False, "error": "symbol not in watchlist"}, status=404)
    return _json_response({"ok": True, "watchlist": svc.pattern_engine.get_watchlist()})


async def handle_focus_symbols_get(_request: web.Request) -> web.Response:
    from oi_mornitor.config import MAIN_CARD_TELEGRAM_CHAT_ID
    from oi_mornitor.focus_symbols import focus_payload_for_api

    return _json_response({
        "ok": True,
        **focus_payload_for_api(),
        "main_chat_id": MAIN_CARD_TELEGRAM_CHAT_ID or "",
    })


async def handle_pattern_alert_stats_get(request: web.Request) -> web.Response:
    """多端共享的形态信号胜率列表（长期保存；默认分页每页 100）。"""
    from oi_mornitor.pattern_alert_stats import list_alert_stats_page

    q = request.query
    page_raw = str(q.get("page") or "1").strip()
    size_raw = str(q.get("pageSize") or q.get("limit") or "100").strip()
    page = int(page_raw) if page_raw.isdigit() else 1
    page_size = int(size_raw) if size_raw.isdigit() else 100
    time_filter = str(q.get("time") or q.get("timeFilter") or "all").strip() or "all"
    session_filter = str(q.get("session") or q.get("sessionFilter") or "all").strip() or "all"
    daytype_filter = str(q.get("daytype") or q.get("dayTypeFilter") or "all").strip() or "all"
    type_label = str(q.get("type") or q.get("typeLabel") or "all").strip() or "all"
    interval = str(q.get("interval") or q.get("iv") or "all").strip() or "all"
    symbol = str(q.get("symbol") or q.get("sym") or "").strip()
    asset_class = str(q.get("assetClass") or q.get("asset_class") or "all").strip() or "all"
    mtf_raw = str(q.get("mtfResonance") or q.get("mtf") or "").strip().lower()
    show_all_raw = str(q.get("showAll") or q.get("allMtf") or "").strip().lower()
    if mtf_raw in ("1", "true", "yes", "on"):
        mtf_resonance_only = True
    elif show_all_raw in ("1", "true", "yes", "on"):
        mtf_resonance_only = False
    elif mtf_raw in ("0", "false", "no", "off"):
        mtf_resonance_only = False
    else:
        # 与前端默认一致：未勾选「仅多周期共振」时展示全量
        mtf_resonance_only = False
    conf_tier = str(q.get("confluenceTier") or q.get("confluenceMinTier") or "all").strip() or "all"
    mcap_tier = str(q.get("mcapTier") or q.get("mcapTierFilter") or "all").strip() or "all"
    payload = list_alert_stats_page(
        page=page,
        page_size=page_size,
        time_filter=time_filter,
        session_filter=session_filter,
        daytype_filter=daytype_filter,
        type_label=type_label,
        interval=interval,
        symbol=symbol or None,
        asset_class=asset_class,
        mtf_resonance_only=mtf_resonance_only,
        confluence_min_tier=conf_tier,
        mcap_tier_filter=mcap_tier,
    )
    return _json_response({"ok": True, **payload})


async def handle_pattern_alert_stats_record_card(request: web.Request) -> web.Response:
    """Telegram 交易卡片归档后登记胜率库。body: { card: {...} }"""
    from oi_mornitor.pattern_alert_stats import record_card_from_archive

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return _json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return _json_response({"ok": False, "error": "body must be object"}, status=400)
    card = body.get("card")
    if not isinstance(card, dict):
        return _json_response({"ok": False, "error": "card must be object"}, status=400)
    rec = record_card_from_archive(card)
    if rec is None:
        return _json_response({"ok": False, "error": "card not eligible for stats"}, status=400)
    return _json_response({"ok": True, "record": rec})


async def handle_pattern_alert_stats_recalculate_v2(request: web.Request) -> web.Response:
    """全库按 V2 规则重算 outcome（operator 用；可能较慢）。"""
    from oi_mornitor.pattern_settle_recalc import recalculate_all_settlements_v2

    limit: int | None = None
    try:
        if request.body_exists:
            body = await request.json()
            if isinstance(body, dict) and body.get("limit") is not None:
                limit = int(body["limit"])
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    try:
        payload = await recalculate_all_settlements_v2(limit=limit)
    except Exception as exc:
        logger.exception("recalculate-v2 failed")
        return _json_response({"ok": False, "error": str(exc)}, status=500)
    return _json_response(payload)


async def handle_pattern_alert_stats_post(request: web.Request) -> web.Response:
    """结算结果回写 / 补登记。body: { updates: AlertStatsRecord[] }"""
    from oi_mornitor.pattern_alert_stats import apply_settle_updates, summarize

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return _json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return _json_response({"ok": False, "error": "body must be object"}, status=400)
    raw = body.get("updates")
    if raw is None and isinstance(body.get("items"), list):
        raw = body.get("items")
    if not isinstance(raw, list):
        return _json_response({"ok": False, "error": "updates must be list"}, status=400)
    items = apply_settle_updates(raw)
    # 不回传全量 items，避免长期库过大时响应膨胀
    return _json_response({"ok": True, "updated": len(raw), "summary": summarize(items)})


async def handle_backtest_structure_options(_request: web.Request) -> web.Response:
    """结构回测：可选形态 / 周期 / 核算说明。"""
    from oi_mornitor.backtest_kline_store import storage_stats
    from oi_mornitor.backtest_universe import load_latest_universe
    from oi_mornitor.mcap_tier import tier_catalog_for_api
    from oi_mornitor.structure_backtest import DEFAULT_KINDS, list_kind_options
    from oi_mornitor.strategy.structure_signals import STRUCTURE_CARD_INTERVALS

    stats = storage_stats()
    mb = stats.get("mb")
    size_hint = f"本地约 {mb} MB" if mb else "本地库为空，首次回测会分页拉取"
    return _json_response(
        {
            "ok": True,
            "kindOptions": list_kind_options(),
            "defaultKinds": DEFAULT_KINDS,
            "intervals": sorted(STRUCTURE_CARD_INTERVALS),
            "symbolScopes": [
                {"id": "top200", "label": "Top200 流动性（推荐）"},
                {"id": "pool", "label": "雷达池（当前监控）"},
                {"id": "majors", "label": "主流 BTC/ETH/SOL"},
                {"id": "all", "label": "全市场 USDT 永续"},
            ],
            "defaultSymbolScope": "top200",
            "defaultMaxSymbols": 200,
            "defaultMaxDays": 730,
            "settleRules": (
                "BTC/ETH/SOL 100x · 山寨 20x · V2：invalid/ATR SL · R 倍数 TP · "
                "核实窗按周期×市值梯队 · 观察档默认不计胜率"
            ),
            "confluenceTiers": [
                {"id": "all", "label": "全部信号（未筛综合分）"},
                {"id": "A", "label": "A 档（训练分布 Top 20%）"},
                {"id": "B", "label": "B 档及以上（≥60 分 / 60–80%）"},
                {"id": "C", "label": "C 档及以上（其余）"},
            ],
            "confluenceNote": (
                "V2 加性共振分：特征权重来自 pattern_alert_stats R 倍校准（confluence_weights.json）；"
                "推送默认 B 及以上（OI_CONFLUENCE_PUSH_MIN_TIER）。"
            ),
            "mcapTiers": tier_catalog_for_api(),
            "mcapTierNote": (
                "市值梯队与胜率弹窗同源；未在白名单的币默认为第三梯队（其他山寨）。"
                "回测默认 Live 漏斗，与实时形态卡片一致。"
            ),
            "klineSource": "bybit_v5_parquet",
            "klineSourceNote": (
                f"K 线：Bybit V5 分页 → Parquet（{size_hint}）；"
                "先「拉取 K 线」分段入库，再「开始回测」只读本地。"
                "200 币 × 15m/1h/4h × 3 年约 4～10 GB。"
            ),
            "defaultChunkDays": 30,
            "universeNote": (
                "Top200 按 Bybit linear 24h 成交额 + 上市≥14 天 + BTC/ETH/SOL 必含；"
                "为当前截面名单，近 1～2 年可接受，更长区间注意存活者偏差。"
            ),
            "latestUniverse": load_latest_universe(),
            "storageStats": stats,
        }
    )


async def handle_backtest_structure_start(request: web.Request) -> web.Response:
    """启动结构形态全市场回测（异步任务）。"""
    from oi_mornitor.radar import get_service
    from oi_mornitor.structure_backtest import job_to_dict, start_structure_backtest

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return _json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        body = {}
    try:
        job = await start_structure_backtest(
            body,
            get_pool_rows=lambda: get_service().radar.last_all_rows,
        )
    except ValueError as exc:
        return _json_response({"ok": False, "error": str(exc)}, status=400)
    except Exception as exc:  # noqa: BLE001
        logger.exception("回测启动失败")
        return _json_response({"ok": False, "error": str(exc)}, status=500)
    return _json_response({"ok": True, **job_to_dict(job, page=1, page_size=100)})


async def handle_backtest_structure_get(request: web.Request) -> web.Response:
    """查询回测任务进度与结果（分页）。"""
    from oi_mornitor.structure_backtest import get_backtest_job, job_to_dict

    job_id = str(request.match_info.get("job_id") or "").strip()
    if not job_id:
        return _json_response({"ok": False, "error": "missing job_id"}, status=400)
    job = get_backtest_job(job_id)
    if job is None:
        return _json_response({"ok": False, "error": "job not found"}, status=404)
    q = request.query
    page = int(q.get("page") or "1") if str(q.get("page") or "1").isdigit() else 1
    page_size = int(q.get("pageSize") or "100") if str(q.get("pageSize") or "100").isdigit() else 100
    kind_filter = str(q.get("kind") or q.get("kindFilter") or "all").strip() or "all"
    type_filter = str(q.get("type") or q.get("typeLabel") or "all").strip() or "all"
    interval_filter = str(q.get("interval") or q.get("intervalFilter") or "all").strip() or "all"
    conf_tier = str(q.get("confluenceTier") or q.get("confluenceMinTier") or "all").strip() or "all"
    mtf_only = str(q.get("mtfResonance") or q.get("mtf") or "0").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    mcap_tier = str(q.get("mcapTier") or q.get("mcapTierFilter") or "all").strip() or "all"
    return _json_response(
        {
            "ok": True,
            **job_to_dict(
                job,
                page=page,
                page_size=page_size,
                kind_filter=kind_filter,
                interval_filter=interval_filter,
                type_label_filter=type_filter,
                confluence_min_tier=conf_tier,
                mtf_resonance_only=mtf_only,
                mcap_tier_filter=mcap_tier,
            ),
        }
    )


async def handle_backtest_structure_latest(_request: web.Request) -> web.Response:
    """最近一次形态回测任务（刷新后恢复用）。"""
    from oi_mornitor.structure_backtest import get_latest_backtest_job, job_to_dict

    job = get_latest_backtest_job()
    if job is None:
        return _json_response({"ok": True, "job": None})
    return _json_response({"ok": True, "job": job_to_dict(job, page=1, page_size=100)})


async def handle_backtest_structure_jobs(request: web.Request) -> web.Response:
    """回测历史列表（开始时间 + 回测区间）。"""
    from oi_mornitor.structure_backtest import list_backtest_jobs

    q = request.query
    limit = int(q.get("limit") or "40") if str(q.get("limit") or "40").isdigit() else 40
    return _json_response({"ok": True, "jobs": list_backtest_jobs(limit)})


async def handle_backtest_kline_prefetch_start(request: web.Request) -> web.Response:
    """分段拉取 K 线到本地 Parquet。"""
    from oi_mornitor.backtest_prefetch import prefetch_job_to_dict, start_kline_prefetch
    from oi_mornitor.radar import get_service

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return _json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        body = {}
    try:
        job = await start_kline_prefetch(body, get_pool_rows=lambda: get_service().radar.last_all_rows)
    except ValueError as exc:
        return _json_response({"ok": False, "error": str(exc)}, status=400)
    except Exception as exc:  # noqa: BLE001
        logger.exception("K 线拉取启动失败")
        return _json_response({"ok": False, "error": str(exc)}, status=500)
    return _json_response({"ok": True, **prefetch_job_to_dict(job)})


async def handle_backtest_kline_prefetch_get(request: web.Request) -> web.Response:
    from oi_mornitor.backtest_prefetch import (
        get_prefetch_job,
        maybe_resume_prefetch_job,
        prefetch_job_to_dict,
    )
    from oi_mornitor.radar import get_service

    job_id = str(request.match_info.get("job_id") or "").strip()
    if not job_id:
        return _json_response({"ok": False, "error": "missing job_id"}, status=400)
    job = get_prefetch_job(job_id)
    if job is None:
        return _json_response({"ok": False, "error": "job not found"}, status=404)
    job = await maybe_resume_prefetch_job(job, lambda: get_service().radar.last_all_rows)
    return _json_response({"ok": True, **prefetch_job_to_dict(job)})


async def handle_backtest_kline_prefetch_latest(_request: web.Request) -> web.Response:
    """最近一次 K 线拉取任务。"""
    from oi_mornitor.backtest_prefetch import (
        get_latest_prefetch_job,
        maybe_resume_prefetch_job,
        prefetch_job_to_dict,
    )
    from oi_mornitor.radar import get_service

    job = get_latest_prefetch_job()
    if job is None:
        return _json_response({"ok": True, "job": None})
    job = await maybe_resume_prefetch_job(job, lambda: get_service().radar.last_all_rows)
    return _json_response({"ok": True, "job": prefetch_job_to_dict(job)})


async def handle_backtest_kline_coverage(request: web.Request) -> web.Response:
    """检查本地 K 线覆盖率（不回测）。"""
    from oi_mornitor.backtest_prefetch import check_kline_coverage
    from oi_mornitor.radar import get_service

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return _json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        body = {}
    try:
        data = await check_kline_coverage(body, get_pool_rows=lambda: get_service().radar.last_all_rows)
    except ValueError as exc:
        return _json_response({"ok": False, "error": str(exc)}, status=400)
    return _json_response({"ok": True, **data})


async def handle_pattern_alert_ticker_get(_request: web.Request) -> web.Response:
    """形态 ticker 滚动条（本机写入，生产只读）。"""
    from oi_mornitor.pattern_alert_ticker import list_ticker

    items = list_ticker()
    return _json_response({"ok": True, "items": items})


async def handle_pattern_alert_ticker_post(request: web.Request) -> web.Response:
    """本机前端合并后推送 ticker。body: { items: TickerItem[] }"""
    from oi_mornitor.pattern_alert_ticker import list_ticker, upsert_ticker

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return _json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return _json_response({"ok": False, "error": "body must be object"}, status=400)
    raw = body.get("items")
    if not isinstance(raw, list):
        return _json_response({"ok": False, "error": "items must be list"}, status=400)
    items = upsert_ticker(raw) if raw else list_ticker()
    return _json_response({"ok": True, "items": items})


async def handle_telegram_push_toggles_get(_request: web.Request) -> web.Response:
    from oi_mornitor.telegram_push_toggles import get_telegram_push_toggles

    return _json_response(get_telegram_push_toggles())


async def handle_telegram_push_toggles_post(request: web.Request) -> web.Response:
    from oi_mornitor.telegram_push_toggles import set_telegram_push_toggles

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return _json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return _json_response({"ok": False, "error": "body must be object"}, status=400)
    partial = body.get("toggles") if isinstance(body.get("toggles"), dict) else body
    return _json_response(set_telegram_push_toggles(partial if isinstance(partial, dict) else {}))


async def handle_telegram_push_test(request: web.Request) -> web.Response:
    """Debug：向 candle / main 群发一条测试消息。"""
    from oi_mornitor.config import CANDLE_CARD_TELEGRAM_CHAT_ID, MAIN_CARD_TELEGRAM_CHAT_ID
    from oi_mornitor.notify_telegram import send_telegram_text

    try:
        body = await request.json()
    except json.JSONDecodeError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    target = str(body.get("target") or "candle").strip().lower()
    text = str(body.get("text") or "").strip() or (
        f"[OI Debug] telegram push test · target={target}"
    )
    if target == "main":
        chat = MAIN_CARD_TELEGRAM_CHAT_ID
    else:
        chat = CANDLE_CARD_TELEGRAM_CHAT_ID
    if not chat:
        return _json_response(
            {"ok": False, "error": f"chat id 未配置（target={target}）", "target": target},
            status=400,
        )
    ok = send_telegram_text(text, chat_id=chat)
    return _json_response({"ok": ok, "target": target, "chatId": chat})


async def handle_focus_symbols_put(request: web.Request) -> web.Response:
    from oi_mornitor.focus_symbols import (
        add_focus_symbol,
        list_focus_symbols,
        remove_focus_symbol,
        set_focus_symbols,
    )

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return _json_response({"ok": False, "error": "invalid json"}, status=400)

    action = str(body.get("action") or "").strip().lower()
    symbol = str(body.get("symbol") or "").strip().upper()
    if action == "add":
        if not symbol:
            return _json_response({"ok": False, "error": "symbol required"}, status=400)
        symbols = add_focus_symbol(symbol)
    elif action in ("remove", "delete"):
        if not symbol:
            return _json_response({"ok": False, "error": "symbol required"}, status=400)
        symbols = remove_focus_symbol(symbol)
    elif "symbols" in body:
        raw = body.get("symbols")
        if not isinstance(raw, list):
            return _json_response({"ok": False, "error": "symbols must be list"}, status=400)
        symbols = set_focus_symbols([str(x) for x in raw])
    else:
        return _json_response(
            {"ok": False, "error": "action=add|remove or symbols=[] required"},
            status=400,
        )
    return _json_response({"ok": True, "symbols": symbols})


async def handle_patterns_random(_request: web.Request) -> web.Response:
    svc = get_service()
    rows = svc.radar.last_all_rows
    fallback = svc.radar.heavyweight_symbol_list
    if not rows and not fallback:
        return _json_response({"ok": False, "error": "雷达池未就绪，请稍后重试"}, status=503)
    picked = svc.pattern_engine.random_pick_heavyweight(rows, fallback_symbols=fallback)
    if not picked:
        return _json_response({"ok": False, "error": "大象池为空"}, status=400)
    return _json_response({
        "ok": True,
        "picked": picked,
        "watchlist": svc.pattern_engine.get_watchlist(),
    })


async def handle_patterns_chart_candles(request: web.Request) -> web.Response:
    """轻量接口：只拉 K 线 + BB/MACD/Vegas，不等待 OI 历史/资金费率/多周期。
    图表渲染走这个，侧边栏形态分析走 /chart 独立补。
    """
    symbol = request.query.get("symbol", "").strip().upper()
    if not symbol:
        return _json_response({"ok": False, "error": "symbol required"}, status=400)
    interval = request.query.get("interval", "").strip() or None
    limit_raw = request.query.get("limit", "").strip()
    end_raw = request.query.get("endTime", "").strip()
    limit = int(limit_raw) if limit_raw.isdigit() else None
    end_time = int(end_raw) if end_raw.isdigit() else None
    svc = get_service()
    session = await svc._ensure_session()
    try:
        data = await asyncio.wait_for(
            asyncio.shield(
                svc.pattern_engine.get_chart_candles(
                    session,
                    symbol,
                    base_url=svc.radar.base_url,
                    interval=interval,
                    limit=limit,
                    end_time=end_time,
                )
            ),
            timeout=15,
        )
    except asyncio.TimeoutError:
        logger.warning("K 线轻量请求超时（15s）：%s %s", symbol, interval)
        return _json_response({"ok": False, "error": "K 线加载超时（15s）"}, status=504)
    except Exception as exc:
        logger.exception("K 线轻量请求失败 %s", symbol)
        return _json_response({"ok": False, "error": str(exc)}, status=500)
    if not data.get("candles"):
        return _json_response({"ok": False, "error": "K线数据为空"}, status=404)
    return _json_response({"ok": True, **data})


async def handle_patterns_chart(request: web.Request) -> web.Response:
    symbol = request.query.get("symbol", "").strip().upper()
    if not symbol:
        return _json_response({"ok": False, "error": "symbol required"}, status=400)
    interval = request.query.get("interval", "").strip() or None
    limit_raw = request.query.get("limit", "").strip()
    end_raw = request.query.get("endTime", "").strip()
    limit = int(limit_raw) if limit_raw.isdigit() else None
    end_time = int(end_raw) if end_raw.isdigit() else None
    svc = get_service()
    session = await svc._ensure_session()
    try:
        # 30s 请求超时：避免 Binance 418 时备选所卡死导致图表挂起
        data = await asyncio.wait_for(
            asyncio.shield(
                svc.pattern_engine.get_chart_data(
                    session,
                    symbol,
                    base_url=svc.radar.base_url,
                    pool_rows=svc.radar.last_all_rows,
                    interval=interval,
                    limit=limit,
                    end_time=end_time,
                )
            ),
            timeout=30,
        )
    except asyncio.TimeoutError:
        logger.warning("形态图表请求超时（30s）：%s %s — Binance 可能 418 且备选所卡住", symbol, interval)
        return _json_response({"ok": False, "error": "图表加载超时（30s），Binance 可能被限流，请稍后重试"}, status=504)
    except Exception as exc:
        logger.exception("形态图表拉取失败 %s", symbol)
        return _json_response({"ok": False, "error": str(exc)}, status=500)
    if not data.get("candles"):
        return _json_response({"ok": False, "error": "K线数据为空"}, status=404)
    return _json_response({"ok": True, **data})


async def handle_patterns_chart_meta(request: web.Request) -> web.Response:
    """轻量元数据：形态状态 + 衍生品/多周期（供浏览器直连 K 线时叠加）。"""
    symbol = request.query.get("symbol", "").strip().upper()
    if not symbol:
        return _json_response({"ok": False, "error": "symbol required"}, status=400)
    interval = request.query.get("interval", "").strip() or "15m"
    svc = get_service()
    row = svc.pattern_engine.tracker.get_state(symbol)
    state: dict[str, Any] = {}
    if row:
        from oi_mornitor.pattern_detector import STATUS_LABELS

        state = {
            "status": row.status,
            "status_label": STATUS_LABELS.get(row.status, row.status),
            "h_max": row.h_max,
            "lh_price": row.lh_price,
            "l1": row.l1,
            "hl": row.hl,
            "trigger_price": row.trigger_price,
            "hh_price": row.hh_price,
            "message": row.message,
        }
    ticker: dict[str, Any] = {}
    for r in svc.radar.last_all_rows or []:
        if str(r.get("symbol") or "").upper() == symbol:
            ticker = {
                "last_price": r.get("last_price"),
                "price_change_pct_24h": r.get("price_change_pct_24h"),
                "current_oi_usd": r.get("current_oi_usd"),
                "quote_volume": r.get("quote_volume"),
                "oi_tier": r.get("oi_tier"),
            }
            break
    derivatives: dict[str, Any] = {}
    session = await svc._ensure_session()
    try:
        klines = await fetch_pattern_klines(
            session,
            base_url=svc.radar.base_url,
            symbol=symbol,
            interval=interval,
            limit=min(120, PATTERN_CHART_DEFAULT_LIMIT),
        )
        oi_by_time = await fetch_open_interest_hist(
            session,
            base_url=svc.radar.base_url,
            symbol=symbol,
            interval=interval,
            limit=120,
        )
        funding, mtf = await asyncio.gather(
            fetch_premium_index(session, base_url=svc.radar.base_url, symbol=symbol),
            svc.pattern_engine._fetch_mtf_context(
                session, base_url=svc.radar.base_url, symbol=symbol
            ),
        )
        if klines:
            derivatives = build_derivatives_context(
                klines=klines,
                oi_by_time=oi_by_time or None,
                funding=funding,
                mtf=mtf,
                structure=state,
            )
    except Exception as exc:
        logger.debug("chart-meta 衍生品 %s: %s", symbol, exc)

    from oi_mornitor.mcap_market_quote import attach_live_market_cap
    from oi_mornitor.mcap_tier import symbol_mcap_tier_for_api

    mcap_tier = symbol_mcap_tier_for_api(symbol)
    try:
        await attach_live_market_cap(session, mcap_tier, symbol)
    except Exception as exc:
        logger.debug("chart-meta 市值 %s: %s", symbol, exc)

    return _json_response({
        "ok": True,
        "symbol": symbol,
        "interval": interval,
        "state": state,
        "ticker": ticker,
        "mcapTier": mcap_tier,
        "price_lines": [],
        "derivatives": derivatives,
        "analysis": {"derivatives": derivatives} if derivatives else {},
    })


async def handle_patterns_oi_hist(request: web.Request) -> web.Response:
    """浏览器 CORS 受限时，由服务端代拉 openInterestHist。"""
    from oi_mornitor.pattern_monitor import fetch_open_interest_hist

    symbol = request.query.get("symbol", "").strip().upper()
    if not symbol:
        return _json_response({"ok": False, "error": "symbol required"}, status=400)
    interval = request.query.get("interval", "").strip() or "15m"
    limit_raw = request.query.get("limit", "").strip()
    limit = int(limit_raw) if limit_raw.isdigit() else 500
    svc = get_service()
    session = await svc._ensure_session()
    try:
        oi_map = await fetch_open_interest_hist(
            session,
            base_url=svc.radar.base_url,
            symbol=symbol,
            interval=interval,
            limit=limit,
        )
    except Exception as exc:
        logger.exception("OI hist 代拉失败 %s", symbol)
        return _json_response({"ok": False, "error": str(exc)}, status=500)
    points = [{"time": t, "value": v} for t, v in sorted(oi_map.items())]
    return _json_response({"ok": True, "symbol": symbol, "interval": interval, "points": points})


async def handle_patterns_spot_net(request: web.Request) -> web.Response:
    """浏览器 CORS 受限时，由服务端代拉现货净主动买入。"""
    from oi_mornitor.chart_deriv_hist import fetch_spot_net_taker_hist

    symbol = request.query.get("symbol", "").strip().upper()
    if not symbol:
        return _json_response({"ok": False, "error": "symbol required"}, status=400)
    interval = request.query.get("interval", "").strip() or "15m"
    limit_raw = request.query.get("limit", "").strip()
    limit = int(limit_raw) if limit_raw.isdigit() else 500
    svc = get_service()
    session = await svc._ensure_session()
    try:
        points = await fetch_spot_net_taker_hist(
            session,
            symbol=symbol,
            interval=interval,
            limit=limit,
        )
    except Exception as exc:
        logger.exception("现货净买入代拉失败 %s", symbol)
        return _json_response({"ok": False, "error": str(exc)}, status=500)
    return _json_response(
        {"ok": True, "symbol": symbol, "interval": interval, "points": points}
    )


async def handle_patterns_futures_net(request: web.Request) -> web.Response:
    """浏览器 CORS 受限时，由服务端代拉合约 taker 净买入。"""
    from oi_mornitor.chart_deriv_hist import fetch_futures_net_taker_hist

    symbol = request.query.get("symbol", "").strip().upper()
    if not symbol:
        return _json_response({"ok": False, "error": "symbol required"}, status=400)
    interval = request.query.get("interval", "").strip() or "15m"
    limit_raw = request.query.get("limit", "").strip()
    limit = int(limit_raw) if limit_raw.isdigit() else 500
    svc = get_service()
    session = await svc._ensure_session()
    try:
        points = await fetch_futures_net_taker_hist(
            session,
            base_url=svc.radar.base_url,
            symbol=symbol,
            interval=interval,
            limit=limit,
        )
    except Exception as exc:
        logger.exception("合约净买入代拉失败 %s", symbol)
        return _json_response({"ok": False, "error": str(exc)}, status=500)
    return _json_response(
        {"ok": True, "symbol": symbol, "interval": interval, "points": points}
    )


async def handle_patterns_klines(request: web.Request) -> web.Response:
    """浏览器无法直连币安时，由服务端代拉 K 线（走代理 + 跨所兜底）。"""
    from oi_mornitor.pattern_monitor import fetch_pattern_klines_with_source
    from oi_mornitor.symbol_aliases import is_stablecoin_symbol

    symbol = request.query.get("symbol", "").strip().upper()
    if not symbol:
        return _json_response({"ok": False, "error": "symbol required"}, status=400)
    if is_stablecoin_symbol(symbol):
        return _json_response({"ok": False, "error": f"稳定币已排除回溯 ({symbol})"}, status=400)
    interval = request.query.get("interval", "").strip() or "5m"
    limit_raw = request.query.get("limit", "").strip()
    end_raw = request.query.get("endTime", "").strip()
    limit = int(limit_raw) if limit_raw.isdigit() else 500
    end_time = int(end_raw) if end_raw.isdigit() else None
    svc = get_service()
    session = await svc._ensure_session()
    try:
        rows, src = await fetch_pattern_klines_with_source(
            session,
            base_url=svc.radar.base_url,
            symbol=symbol,
            interval=interval,
            limit=limit,
            end_time=end_time,
        )
    except Exception as exc:
        logger.exception("K线代拉失败 %s", symbol)
        return _json_response({"ok": False, "error": str(exc)}, status=500)
    if not rows:
        return _json_response(
            {"ok": False, "error": f"K线为空 ({symbol})", "symbol": symbol},
            status=404,
        )
    candles = []
    for row in rows:
        if not isinstance(row, (list, tuple)) or len(row) < 6:
            continue
        try:
            candles.append(
                {
                    "time": int(row[0]) // 1000,
                    "open": float(row[1]),
                    "high": float(row[2]),
                    "low": float(row[3]),
                    "close": float(row[4]),
                    "volume": float(row[5] or 0),
                }
            )
        except (TypeError, ValueError):
            continue
    return _json_response(
        {
            "ok": True,
            "symbol": symbol,
            "interval": interval,
            "source": src,
            "candles": candles,
            "rawCount": len(rows),
        }
    )


async def handle_card_prices(_request: web.Request) -> web.Response:
    """立即刷新活跃卡片币种市价（写入 last_price / 距 TP·SL）。"""
    svc = get_service()
    session = await svc._ensure_session()
    result = await svc.card_engine.refresh_card_market_prices(
        session,
        base_url=svc.radar.base_url,
        pool_rows=svc.radar.last_all_rows,
    )
    return _json_response({**result, **svc.card_engine.get_payload()})


async def handle_tv_alert(_request: web.Request) -> web.Response:
    """TradingView BB-Wicks 信号监听同步状态。"""
    return _json_response({"ok": True, **get_service().tv_alert_sync.get_payload()})


async def handle_scan_status(_request: web.Request) -> web.Response:
    """返回雷达扫描运行状态。"""
    svc = get_service()
    is_running = svc._running
    scan_ts = svc.radar.last_scan_ts
    return _json_response({
        "ok": True,
        "running": is_running,
        "scan_ts": scan_ts,
    })


async def handle_scan_restart(_request: web.Request) -> web.Response:
    """重启雷达后台扫描循环（stop 再 start）。"""
    svc = get_service()
    import inspect as _inspect
    sig = _inspect.signature(svc.start_background)
    sig2 = _inspect.signature(svc.stop)
    await svc.stop()
    interval = SCAN_INTERVAL_SEC
    if "interval_sec" in sig.parameters:
        interval = sig.parameters["interval_sec"].default or SCAN_INTERVAL_SEC
    await svc.start_background(interval)
    return _json_response({
        "ok": True,
        "running": svc._running,
        "scan_ts": svc.radar.last_scan_ts,
    })


async def handle_stream(request: web.Request) -> web.StreamResponse:

    """SSE：推送最新雷达快照。"""

    resp = web.StreamResponse(

        status=200,

        headers={

            "Content-Type": "text/event-stream",

            "Cache-Control": "no-cache",

            "Connection": "keep-alive",

            "Access-Control-Allow-Origin": "*",

        },

    )

    await resp.prepare(request)

    svc = get_service()



    try:

        while True:

            payload = svc.get_snapshot()

            data = json.dumps(payload, ensure_ascii=False, default=str)

            await resp.write(f"data: {data}\n\n".encode())

            # smart.b 桥开启时 ~10–20s 推快照；否则跟本地慢扫描
            try:
                from oi_mornitor.smartb_radar_source import get_smartb_source, SMARTB_RADAR_REFRESH_SEC
                _sb = get_smartb_source()
                _push = int(min(max(SMARTB_RADAR_REFRESH_SEC, 10), 20)) if _sb.enabled else int(SCAN_INTERVAL_SEC)
            except Exception:
                _push = int(SCAN_INTERVAL_SEC)
            await asyncio.sleep(max(5, _push))

    except (asyncio.CancelledError, ConnectionResetError):

        logger.info("SSE 客户端断开")

    return resp







async def handle_ai_judge_health(_request: web.Request) -> web.Response:
    """探活 ezcoin-adapter (127.0.0.1:5179) 与 BTC 自动信号队列。"""
    import aiohttp
    from oi_mornitor.ai_judge_bridge import ADAPTER_BASE_URL, get_btc_signals_feed

    adapter_status: dict[str, Any] = {"ok": False}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=3)) as session:
            async with session.get(f"{ADAPTER_BASE_URL}/health") as resp:
                if resp.status == 200:
                    adapter_status = await resp.json()
    except Exception as exc:  # noqa: BLE001
        adapter_status = {"ok": False, "error": str(exc)}
    btc_items = get_btc_signals_feed(limit=10)
    return _json_response({
        "ok": True,
        "adapter_url": ADAPTER_BASE_URL,
        "adapter": adapter_status,
        "btc_signal_count": len(btc_items),
        "latest_btc_signal": btc_items[0] if btc_items else None,
    })


async def handle_ai_judge_snapshot(request: web.Request) -> web.Response:
    """导出指定币种的 ezcoin 结构化多周期 snapshot JSON（15m/1h/4h/1d）。"""
    from oi_mornitor.ai_judge_bridge import build_ezcoin_snapshot

    symbol = str(request.query.get("symbol") or "BTCUSDT").strip().upper()
    interval = str(request.query.get("interval") or request.query.get("tf") or "15m").strip().lower()
    svc = get_service()
    snap = await build_ezcoin_snapshot(svc, symbol, signal_tf=interval)
    return _json_response({"ok": True, "snapshot": snap})


async def handle_ai_judge_latest(request: web.Request) -> web.Response:
    """查询指定币种最近一次 AI 研判结论。"""
    from oi_mornitor.ai_judge_bridge import fetch_adapter_latest, get_btc_signals_feed, normalize_pair_and_short

    symbol = str(request.query.get("symbol") or "BTCUSDT").strip().upper()
    _, short_sym = normalize_pair_and_short(symbol)
    rec = await fetch_adapter_latest(symbol)
    btc_signals = get_btc_signals_feed(limit=20) if short_sym == "BTC" else []
    if not rec:
        return _json_response({
            "ok": False,
            "symbol": short_sym,
            "judgment": None,
            "btc_signals": btc_signals,
        })
    return _json_response({
        "ok": True,
        "symbol": short_sym,
        "snapshot": rec.get("snapshot"),
        "judgment": rec.get("judgment"),
        "updated_at": rec.get("updated_at"),
        "btc_signals": btc_signals,
    })


async def handle_ai_judge_run(request: web.Request) -> web.Response:
    """手动或前端按钮触发指定币种 AI 研判（支持 skip_llm 仅测门禁，支持 push_telegram）。"""
    from oi_mornitor.ai_judge_bridge import (
        build_ezcoin_snapshot,
        call_adapter_judge,
        push_judgment_to_telegram,
    )

    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    symbol = str(body.get("symbol") or request.query.get("symbol") or "BTCUSDT").strip().upper()
    interval = str(body.get("interval") or body.get("timeframe") or request.query.get("interval") or "15m").strip().lower()
    skip_llm = bool(body.get("skip_llm") or body.get("gates_only"))
    push_tg = bool(body.get("push_telegram"))
    signal_meta = body.get("signal_meta") if isinstance(body.get("signal_meta"), dict) else {}
    if interval and not signal_meta.get("timeframe"):
        signal_meta["timeframe"] = interval

    svc = get_service()
    if isinstance(body.get("snapshot"), dict):
        snap = body["snapshot"]
    else:
        snap = await build_ezcoin_snapshot(svc, symbol, signal_tf=interval, signal_meta=signal_meta)

    res = await call_adapter_judge(
        snap,
        skip_llm=skip_llm,
        signal_meta=signal_meta,
        auto_btc_signal=bool(body.get("auto_btc_signal")),
        force=bool(body.get("force")),
    )
    pushed = False
    if push_tg and res.get("formatted_text"):
        pushed = await asyncio.to_thread(push_judgment_to_telegram, str(res["formatted_text"]))

    return _json_response({
        "ok": bool(res.get("ok", True)),
        "symbol": snap.get("symbol"),
        "raw_symbol": snap.get("raw_symbol") or symbol,
        "interval": interval,
        "pushed_telegram": pushed,
        "snapshot": snap,
        "judgment": res,
        **res,
    })


async def handle_ai_judge_btc_signals_get(request: web.Request) -> web.Response:
    """获取 BTC/ETH 15m/1h/4h/1d 专属信号自动研判历史流。"""
    from oi_mornitor.ai_judge_bridge import get_btc_signals_feed

    limit = int(request.query.get("limit") or 30)
    tf = str(request.query.get("timeframe") or request.query.get("interval") or "").strip().lower()
    sym = str(request.query.get("symbol") or "").strip().upper()
    items = get_btc_signals_feed(limit=limit, timeframe=tf, symbol=sym)
    return _json_response({"ok": True, "count": len(items), "items": items})


async def handle_ai_judge_btc_signal_post(request: web.Request) -> web.Response:
    """触发或测试 BTC 15m/1h/4h/1d 专属信号自动研判与推送（带去重，支持 force=true 强制重跑）。"""
    from oi_mornitor.ai_judge_bridge import trigger_btc_signal_auto_judge

    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    iv = str(body.get("interval") or body.get("timeframe") or "15m").strip().lower()
    if iv not in ("15m", "1h", "4h", "1d"):
        return _json_response({"ok": False, "error": "BTC 专属信号仅支持 15m / 1h / 4h / 1d"}, status=400)

    raw_sym = str(body.get("symbol") or (body.get("alert") or {}).get("symbol") or "BTCUSDT").strip().upper()
    if raw_sym in ("BTC", "ETH"):
        raw_sym = f"{raw_sym}USDT"
    short_s = raw_sym[:-4] if raw_sym.endswith("USDT") else raw_sym
    alert_dict = body.get("alert") if isinstance(body.get("alert"), dict) else {
        "symbol": raw_sym,
        "interval": iv,
        "kind": body.get("kind") or body.get("signal_kind") or f"manual_{short_s.lower()}_signal",
        "type_label": body.get("signal_name") or body.get("type_label") or f"{short_s} {iv} 信号触发",
        "side": body.get("side") or "bull",
        "kline_close_time": body.get("bar_ts") or body.get("kline_close_time") or int(asyncio.get_event_loop().time()),
        "vol_ratio": body.get("vol_ratio"),
    }
    alert_dict["symbol"] = raw_sym
    alert_dict["interval"] = iv

    skip_llm = bool(body.get("skip_llm") or body.get("gates_only"))
    push_tg = bool(body.get("push_telegram", False))
    force = bool(body.get("force", False))

    svc = get_service()
    item = await trigger_btc_signal_auto_judge(
        svc,
        alert_dict,
        skip_llm=skip_llm,
        push_telegram=push_tg,
        force=force,
    )
    if not item:
        return _json_response({"ok": False, "error": "BTC auto judge returned empty"}, status=500)
    return _json_response({"ok": True, "item": item, **item})


async def handle_ai_judge_btc_signal_sync(request: web.Request) -> web.Response:
    """接收 ezcoin-adapter (:5179/signal-btc) 外部直推过来的 BTC 信号结论并同步到本机与 TG。"""
    from oi_mornitor.ai_judge_bridge import sync_btc_signal_from_adapter

    try:
        body = await request.json()
    except Exception:
        return _json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return _json_response({"ok": False, "error": "invalid payload"}, status=400)
    push_tg = bool(body.get("push_telegram", False))
    item = await asyncio.to_thread(sync_btc_signal_from_adapter, body, push_telegram=push_tg)
    return _json_response({"ok": True, "item": item})

async def handle_ai_judge_backtest_btc_get(request: web.Request) -> web.Response:
    """获取多币种/多周期严格无未来数据回测结果（优先缓存；支持 query 过滤提示）。"""
    from oi_mornitor.btc_1h_backtest import load_cached_btc_backtest, run_btc_backtest

    cached = load_cached_btc_backtest()
    if cached:
        return _json_response(cached)
    res = await run_btc_backtest(symbol="BTCUSDT", timeframes=["1h"], days=7, skip_llm=True)
    return _json_response(res)


async def handle_ai_judge_backtest_btc_run(request: web.Request) -> web.Response:
    """重新运行多币种/多周期严格无未来数据 AI 回测。

    Body/query 支持:
      - symbol / symbols: BTC / ETH / QQQ / SNDK / DOGE / UNI / NEAR 或任意可交易对
      - timeframes: ["15m","1h","4h","1d"] 或多选字符串
      - start / end: Asia/Shanghai ISO 时间；或 days 回退
      - skip_llm / force_refresh
      - llm_mode: trader_only|full（默认 trader_only，回测更快且必有做/不做结论）
      - max_llm_signals / soft_ai_top_n
      - sync: true → 旧同步阻塞直到全部完成（脚本用）；默认 false → 立即返回 job_id，按币种渐进
    """
    from oi_mornitor.ai_btc_backtest_jobs import job_to_dict, start_ai_backtest_job
    from oi_mornitor.btc_1h_backtest import run_btc_backtest

    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    q = request.rel_url.query
    symbols_raw = body.get("symbols")
    if isinstance(symbols_raw, str) and symbols_raw.strip():
        symbols_list = [x.strip() for x in symbols_raw.replace("|", ",").split(",") if x.strip()]
    elif isinstance(symbols_raw, list):
        symbols_list = [str(x).strip() for x in symbols_raw if str(x).strip()]
    else:
        symbols_list = None
    symbol = (
        body.get("symbol")
        or (symbols_list[0] if symbols_list else None)
        or q.get("symbol")
        or "BTCUSDT"
    )
    timeframes = body.get("timeframes") or body.get("tfs") or q.get("timeframes") or ["1h"]
    start = body.get("start") or q.get("start")
    end = body.get("end") or q.get("end")
    days_raw = body.get("days") if body.get("days") is not None else q.get("days")
    days = int(days_raw) if days_raw not in (None, "") else (7 if not start else None)
    if days is not None:
        days = max(1, min(int(days), 30))
    skip_llm = bool(body.get("skip_llm", False))
    force_refresh = bool(body.get("force_refresh", False))
    llm_mode = str(body.get("llm_mode") or q.get("llm_mode") or "trader_only").strip() or "trader_only"
    try:
        max_llm_signals = int(body.get("max_llm_signals") if body.get("max_llm_signals") is not None else (q.get("max_llm_signals") or 12))
    except Exception:
        max_llm_signals = 12
    max_llm_signals = max(0, min(max_llm_signals, 50))
    try:
        soft_ai_top_n = int(body.get("soft_ai_top_n") if body.get("soft_ai_top_n") is not None else (q.get("soft_ai_top_n") or 0))
    except Exception:
        soft_ai_top_n = 0
    soft_ai_top_n = max(0, min(soft_ai_top_n, 20))
    include_tight_sl_signals = bool(
        body.get("include_tight_sl_signals")
        if body.get("include_tight_sl_signals") is not None
        else (q.get("include_tight_sl_signals") in ("1", "true", "yes", "True"))
    )
    sync_flag = body.get("sync")
    if sync_flag is None:
        sync_flag = q.get("sync")
    if isinstance(sync_flag, str):
        sync_mode = sync_flag.strip().lower() in ("1", "true", "yes", "sync")
    else:
        sync_mode = bool(sync_flag)

    logger.info(
        "backtest-btc/run start sync=%s symbols=%s tfs=%s start=%s end=%s skip_llm=%s force=%s llm_mode=%s max_llm=%s tight_sl=%s",
        sync_mode,
        symbols_list or symbol,
        timeframes,
        start,
        end,
        skip_llm,
        force_refresh,
        llm_mode,
        max_llm_signals,
        include_tight_sl_signals,
    )

    if not sync_mode:
        try:
            job = await start_ai_backtest_job(
                symbol=str(symbol),
                symbols=symbols_list,
                timeframes=timeframes,
                days=days,
                start=start,
                end=end,
                skip_llm=skip_llm,
                force_refresh=force_refresh,
                llm_mode=llm_mode,
                max_llm_signals=max_llm_signals,
                soft_ai_top_n=soft_ai_top_n,
                include_tight_sl_signals=include_tight_sl_signals,
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("backtest-btc/run start job failed")
            return _json_response(
                {"ok": False, "error": f"启动回测任务失败: {e}", "items": [], "summary": {}},
                status=500,
            )
        payload = job_to_dict(job)
        logger.info("backtest-btc/run job_id=%s status=%s", job.id, job.status)
        return _json_response(payload)

    # Legacy sync path (scripts / curl with sync:true)
    try:
        res = await run_btc_backtest(
            symbol=str(symbol),
            symbols=symbols_list,
            timeframes=timeframes,
            days=days,
            start=start,
            end=end,
            skip_llm=skip_llm,
            force_refresh=force_refresh,
            llm_mode=llm_mode,
            max_llm_signals=max_llm_signals,
            soft_ai_top_n=soft_ai_top_n,
            include_tight_sl_signals=include_tight_sl_signals,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("backtest-btc/run failed")
        return _json_response(
            {
                "ok": False,
                "error": f"回测异常: {e}",
                "items": [],
                "summary": {},
                "errors": [{"symbol": "*", "error": str(e)}],
            },
            status=500,
        )
    if not isinstance(res, dict):
        return _json_response({"ok": False, "error": "invalid backtest result", "items": []}, status=500)
    status = 200 if res.get("ok") or res.get("items") else 500
    n = len(res.get("items") or [])
    logger.info(
        "backtest-btc/run done ok=%s items=%s errors=%s partial=%s",
        res.get("ok"),
        n,
        res.get("errors") or res.get("summary", {}).get("symbol_errors"),
        res.get("partial"),
    )
    return _json_response(res, status=status)


async def handle_ai_judge_backtest_btc_job(request: web.Request) -> web.Response:
    """Poll progressive AI backtest job state (per-symbol accumulation)."""
    from oi_mornitor.ai_btc_backtest_jobs import get_ai_backtest_job, job_to_dict

    job_id = str(request.match_info.get("job_id") or "").strip()
    if not job_id:
        return _json_response({"ok": False, "error": "missing job_id"}, status=400)
    job = get_ai_backtest_job(job_id)
    if job is None:
        return _json_response({"ok": False, "error": f"job not found: {job_id}", "done": True}, status=404)
    return _json_response(job_to_dict(job))


# Backward-compatible aliases
async def handle_ai_judge_backtest_btc_1h_get(request: web.Request) -> web.Response:
    return await handle_ai_judge_backtest_btc_get(request)


async def handle_ai_judge_backtest_btc_1h_run(request: web.Request) -> web.Response:
    return await handle_ai_judge_backtest_btc_run(request)



async def on_startup(app: web.Application) -> None:
    await get_service().start_background(SCAN_INTERVAL_SEC)
    logger.info("雷达后台扫描已挂载到 Web 服务")

    async def _resume_kline_prefetch() -> None:
        from oi_mornitor.backtest_prefetch import resume_interrupted_prefetch

        try:
            job = await resume_interrupted_prefetch(lambda: get_service().radar.last_all_rows)
            if job is not None:
                logger.info("已恢复中断的 K 线拉取 %s", job.id)
        except Exception:  # noqa: BLE001
            logger.exception("恢复 K 线拉取失败")

    asyncio.create_task(_resume_kline_prefetch())





async def on_cleanup(app: web.Application) -> None:

    await get_service().stop()

    logger.info("雷达服务已停止")





def create_app() -> web.Application:

    app = web.Application()

    app.router.add_get("/", handle_index)

    app.router.add_get("/patterns", handle_index)

    app.router.add_get("/backtest", handle_index)

    app.router.add_get("/api/health", handle_health)

    app.router.add_get("/api/snapshot", handle_snapshot)

    app.router.add_get("/api/hot", handle_hot)

    app.router.add_get("/api/matrix", handle_matrix)

    app.router.add_get("/api/dormant-funnel", handle_dormant_funnel)
    app.router.add_get("/api/potential-discovery", handle_potential_discovery)
    app.router.add_get("/api/binance/leaderboards", handle_binance_leaderboards)

    app.router.add_get("/api/patterns", handle_patterns)

    app.router.add_post("/api/patterns/watch", handle_patterns_watch_post)

    app.router.add_delete("/api/patterns/watch", handle_patterns_watch_delete)

    app.router.add_post("/api/patterns/watch/pin", handle_patterns_watch_pin)

    app.router.add_get("/api/focus-symbols", handle_focus_symbols_get)

    app.router.add_put("/api/focus-symbols", handle_focus_symbols_put)

    app.router.add_post("/api/focus-symbols", handle_focus_symbols_put)

    app.router.add_get("/api/pattern-alert-stats", handle_pattern_alert_stats_get)
    app.router.add_post("/api/pattern-alert-stats/record-card", handle_pattern_alert_stats_record_card)
    app.router.add_post("/api/pattern-alert-stats/recalculate-v2", handle_pattern_alert_stats_recalculate_v2)
    app.router.add_post("/api/pattern-alert-stats", handle_pattern_alert_stats_post)
    app.router.add_put("/api/pattern-alert-stats", handle_pattern_alert_stats_post)

    app.router.add_get("/api/backtest/structure/options", handle_backtest_structure_options)
    app.router.add_get("/api/backtest/structure/latest", handle_backtest_structure_latest)
    app.router.add_get("/api/backtest/structure/jobs", handle_backtest_structure_jobs)
    app.router.add_post("/api/backtest/structure", handle_backtest_structure_start)
    app.router.add_get("/api/backtest/structure/{job_id}", handle_backtest_structure_get)
    app.router.add_post("/api/backtest/kline/prefetch", handle_backtest_kline_prefetch_start)
    app.router.add_get("/api/backtest/kline/prefetch/latest", handle_backtest_kline_prefetch_latest)
    app.router.add_get("/api/backtest/kline/prefetch/{job_id}", handle_backtest_kline_prefetch_get)
    app.router.add_post("/api/backtest/kline/coverage", handle_backtest_kline_coverage)

    app.router.add_get("/api/pattern-alert-ticker", handle_pattern_alert_ticker_get)
    app.router.add_post("/api/pattern-alert-ticker", handle_pattern_alert_ticker_post)
    app.router.add_put("/api/pattern-alert-ticker", handle_pattern_alert_ticker_post)

    app.router.add_get("/api/telegram-push-toggles", handle_telegram_push_toggles_get)
    app.router.add_post("/api/telegram-push-toggles", handle_telegram_push_toggles_post)
    app.router.add_put("/api/telegram-push-toggles", handle_telegram_push_toggles_post)
    app.router.add_post("/api/telegram-push-test", handle_telegram_push_test)

    app.router.add_post("/api/patterns/random", handle_patterns_random)

    app.router.add_get("/api/patterns/chart-candles", handle_patterns_chart_candles)
    app.router.add_get("/api/patterns/chart", handle_patterns_chart)

    app.router.add_get("/api/patterns/chart-meta", handle_patterns_chart_meta)

    app.router.add_get("/api/patterns/oi-hist", handle_patterns_oi_hist)
    app.router.add_get("/api/patterns/spot-net", handle_patterns_spot_net)
    app.router.add_get("/api/patterns/futures-net", handle_patterns_futures_net)

    app.router.add_get("/api/patterns/klines", handle_patterns_klines)

    app.router.add_post("/api/cards/prices", handle_card_prices)

    app.router.add_get("/api/tv-alert", handle_tv_alert)

    app.router.add_get("/api/stream", handle_stream)
    app.router.add_get("/api/scan/status", handle_scan_status)
    app.router.add_get("/api/ai-judge/health", handle_ai_judge_health)
    app.router.add_get("/api/ai-judge/snapshot", handle_ai_judge_snapshot)
    app.router.add_get("/api/ai-judge/latest", handle_ai_judge_latest)
    app.router.add_post("/api/ai-judge/run", handle_ai_judge_run)
    app.router.add_get("/api/ai-judge/btc-signals", handle_ai_judge_btc_signals_get)
    app.router.add_post("/api/ai-judge/btc-signal", handle_ai_judge_btc_signal_post)
    app.router.add_post("/api/ai-judge/btc-signal-sync", handle_ai_judge_btc_signal_sync)
    app.router.add_get("/api/ai-judge/backtest-btc", handle_ai_judge_backtest_btc_get)
    app.router.add_post("/api/ai-judge/backtest-btc/run", handle_ai_judge_backtest_btc_run)
    app.router.add_get("/api/ai-judge/backtest-btc/job/{job_id}", handle_ai_judge_backtest_btc_job)
    app.router.add_get("/api/ai-judge/backtest-btc-1h", handle_ai_judge_backtest_btc_1h_get)
    app.router.add_post("/api/ai-judge/backtest-btc-1h/run", handle_ai_judge_backtest_btc_1h_run)
    app.router.add_get("/btc-backtest", handle_index)

    app.router.add_post("/api/scan/restart", handle_scan_restart)

    # Discord 卡片外送：WS /ws/cards · POST /api/cards
    register_card_routes(app)

    if STATIC_DIST.exists():

        app.router.add_static("/assets", STATIC_DIST / "assets", show_index=False)

    app.on_startup.append(on_startup)

    app.on_cleanup.append(on_cleanup)

    return app





def main() -> None:

    logging.basicConfig(

        level=logging.INFO,

        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",

        datefmt="%Y-%m-%d %H:%M:%S",

    )

    if not STATIC_DIST.exists():

        logger.warning(

            "未找到 %s — 请先构建 React 前端: cd oi_mornitor/frontend && npm install && npm run build",

            STATIC_DIST,

        )

    web.run_app(create_app(), host=WEB_HOST, port=WEB_PORT)





if __name__ == "__main__":

    main()

