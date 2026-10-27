"""沉寂拉盘：慢扫候选池（4h）+ 快扫点火（15m）→ 特别关注 / 顶栏榜单。"""

from __future__ import annotations



import asyncio

import logging

import time

from typing import Any, Callable



import aiohttp



from oi_mornitor.config import FAPI_BASE_URL

from oi_mornitor.derivatives_metrics import fetch_premium_index

from oi_mornitor.dormant_funnel import evaluate_dormant_funnel_df

from oi_mornitor.dormant_funnel_store import (
    candidate_symbols,
    get_funnel_payload,
    update_funnel_snapshot,
)

from oi_mornitor.dormant_ignition import scan_dormant_breakout_klines

from oi_mornitor.dormant_ignition_config import (

    DORMANT_IGNITION_ENABLED,

    DORMANT_IGNITION_INTERVAL,

    DORMANT_IGNITION_TTL_H,

    FUNNEL_FAST_INTERVAL_SEC,

    FUNNEL_KLINE_LIMIT,

    FUNNEL_MAX_UNIVERSE,

    FUNNEL_SLOW_INTERVAL_SEC,

)

from oi_mornitor.breakout_detector import klines_to_df

from oi_mornitor.dormant_ignition import _attach_oi

from oi_mornitor.focus_symbols import add_temporary_focus, normalize_focus_symbol

from oi_mornitor.mcap_tier import resolve_mcap_tier

from oi_mornitor.pattern_monitor import fetch_open_interest_hist, fetch_pattern_klines_batch

from oi_mornitor.symbol_aliases import is_stablecoin_symbol



logger = logging.getLogger("OI_Radar")



_last_slow = 0.0

_last_fast = 0.0





def _small_cap_universe(rows: list[dict[str, Any]]) -> list[str]:

    """第三梯队 · 按 24h 成交额升序（偏小市值流动性）。"""

    scored: list[tuple[float, str]] = []

    seen: set[str] = set()

    for r in rows:

        sym = normalize_focus_symbol(str(r.get("symbol") or ""))

        if not sym or sym in seen or is_stablecoin_symbol(sym):

            continue

        if resolve_mcap_tier(sym) != "t3":

            continue

        seen.add(sym)

        vol = float(r.get("quote_volume") or 0)

        scored.append((vol, sym))

    scored.sort(key=lambda x: x[0])

    syms = [s for _, s in scored]

    return syms[: max(40, FUNNEL_MAX_UNIVERSE)]





def _row_from_eval(sym: str, ev: dict[str, Any]) -> dict[str, Any]:

    detail = ev.get("detail") if isinstance(ev.get("detail"), dict) else {}

    stage = str(ev.get("stage") or "NONE")

    badge = "点火"

    tone = "up"

    if stage == "CANDIDATE":

        badge = "试盘"

        tone = "neutral"

    elif stage == "DORMANT":

        badge = "沉寂"

        tone = "neutral"

    vol_r = detail.get("vol_ratio")

    if vol_r is not None:

        badge = f"{badge}·{vol_r}x"

    conf = str(ev.get("confidence") or "")

    if conf == "HIGH":

        badge = f"★{badge}"

    return {

        "symbol": sym,

        "rank": int(ev.get("score") or 0),

        "score": int(ev.get("score") or 0),

        "stage": stage,

        "confidence": conf,

        "badge": badge,

        "tone": tone,

        "detail": detail,

    }





async def _klines_and_oi(

    session: aiohttp.ClientSession,

    *,

    symbols: list[str],

    base_url: str,

) -> tuple[dict[str, list], dict[str, dict[int, float]]]:

    iv = DORMANT_IGNITION_INTERVAL

    kmap = await fetch_pattern_klines_batch(

        session,

        base_url=base_url,

        symbols=symbols,

        interval=iv,

        limit=FUNNEL_KLINE_LIMIT,

    )

    oi_maps: dict[str, dict[int, float]] = {}

    sem = asyncio.Semaphore(8)



    async def _one(sym: str) -> None:

        async with sem:

            try:

                mp = await fetch_open_interest_hist(

                    session,

                    base_url=base_url,

                    symbol=sym,

                    interval=iv,

                    limit=min(500, FUNNEL_KLINE_LIMIT),

                )

                if mp:

                    oi_maps[sym] = mp

            except Exception:  # noqa: BLE001

                pass



    await asyncio.gather(*[_one(s) for s in symbols], return_exceptions=True)

    return kmap, oi_maps





async def run_funnel_slow_scan(

    session: aiohttp.ClientSession,

    *,

    pool_rows: list[dict[str, Any]],

    base_url: str = FAPI_BASE_URL,

) -> list[dict[str, Any]]:

    symbols = _small_cap_universe(pool_rows)

    if not symbols:

        update_funnel_snapshot(candidates=[], slow_scan=True)

        return []



    kmap, oi_maps = await _klines_and_oi(session, symbols=symbols, base_url=base_url)

    candidates: list[dict[str, Any]] = []

    for sym in symbols:

        raw = kmap.get(sym) or []

        if len(raw) < 300:

            continue

        df = _attach_oi(klines_to_df(raw), oi_maps.get(sym))

        ev = evaluate_dormant_funnel_df(df)

        if ev.get("phase1") and ev.get("phase2"):
            candidates.append(_row_from_eval(sym, ev))



    update_funnel_snapshot(candidates=candidates, slow_scan=True)

    logger.info("沉寂漏斗慢扫：候选 %d / 扫描 %d", len(candidates), len(symbols))

    return candidates





async def run_funnel_fast_scan(

    session: aiohttp.ClientSession,

    *,

    pool_rows: list[dict[str, Any]],

    base_url: str = FAPI_BASE_URL,

) -> list[dict[str, Any]]:

    symbols = candidate_symbols()

    if not symbols:

        symbols = _small_cap_universe(pool_rows)[:30]

    if not symbols:

        update_funnel_snapshot(candidates=[], ignitions=[], fast_scan=True)

        return []



    kmap, oi_maps = await _klines_and_oi(session, symbols=symbols, base_url=base_url)

    ignitions: list[dict[str, Any]] = []

    alerts: list[dict[str, Any]] = []

    updated_candidates: list[dict[str, Any]] = []



    for sym in symbols:

        raw = kmap.get(sym) or []

        if len(raw) < 300:

            continue

        funding_pct = None

        try:

            prem = await fetch_premium_index(session, base_url=base_url, symbol=sym)

            funding_pct = prem.get("funding_rate_pct")

            if funding_pct is not None:

                funding_pct = float(funding_pct)

        except Exception:  # noqa: BLE001

            pass



        result = scan_dormant_breakout_klines(

            raw,

            oi_map=oi_maps.get(sym),

            funding_rate_pct=funding_pct,

        )

        ev = result if result.get("stage") else {

            "stage": "IGNITION" if result.get("status") == "IGNITION_SIGNAL" else "NONE",

            "signal": result.get("status") == "IGNITION_SIGNAL",

            "score": result.get("score") or 0,

            "confidence": result.get("confidence") or "MEDIUM",

            "detail": result.get("detail") or {},

            "phase1": True,

            "phase2": True,

        }

        row = _row_from_eval(sym, ev)

        if ev.get("stage") == "CANDIDATE" or (ev.get("phase1") and ev.get("phase2")):

            updated_candidates.append(row)

        if result.get("status") == "IGNITION_SIGNAL" or ev.get("signal"):

            ignitions.append(row)

            detail = ev.get("detail") if isinstance(ev.get("detail"), dict) else {}

            vol_s = detail.get("vol_ratio")

            conf = str(ev.get("confidence") or "MEDIUM")

            badge = f"沉寂拉盘·{conf}"

            if vol_s is not None:

                badge += f"·{vol_s}x"

            add_temporary_focus(

                sym,

                ttl_hours=DORMANT_IGNITION_TTL_H,

                source="dormant_funnel",

                badge=badge,

                detail={**detail, "confidence": conf, "score": ev.get("score")},

            )

            msg = f"沉寂拉盘点火 · {conf} · 量{vol_s or '—'}x · OI+{detail.get('oi_bias_pct') or detail.get('oi_bias') or '—'}"

            alerts.append(

                {

                    "type": "dormant_ignition",

                    "symbol": sym,

                    "message": msg,

                    "type_label": "沉寂拉盘",

                    "interval": DORMANT_IGNITION_INTERVAL,

                    "side": "long",

                    "dir": "long",

                    "detail": detail,

                    "ts": time.time(),

                }

            )

            logger.info("沉寂拉盘点火 %s conf=%s %s", sym, conf, detail)



    prev = get_funnel_payload().get("candidates") or []
    final_candidates = updated_candidates if updated_candidates else prev
    update_funnel_snapshot(
        candidates=final_candidates,
        ignitions=ignitions,
        fast_scan=True,
    )

    return alerts





async def run_dormant_ignition_once(

    session: aiohttp.ClientSession,

    *,

    pool_rows: list[dict[str, Any]],

    base_url: str = FAPI_BASE_URL,

) -> list[dict[str, Any]]:

    """兼容旧入口：等价于快扫。"""

    return await run_funnel_fast_scan(session, pool_rows=pool_rows, base_url=base_url)





async def run_dormant_ignition_loop(

    is_running: Callable[[], bool],

    *,

    get_pool_rows: Callable[[], list[dict[str, Any]]],

    get_session: Callable[[], Any],

    base_url: str = FAPI_BASE_URL,

    on_alerts: Callable[[list[dict[str, Any]]], None] | None = None,

) -> None:

    global _last_slow, _last_fast

    if not DORMANT_IGNITION_ENABLED:

        while is_running():

            await asyncio.sleep(5)

        return



    tick = max(30, min(FUNNEL_FAST_INTERVAL_SEC, 120))

    _last_slow = 0.0

    _last_fast = 0.0



    while is_running():

        try:

            session = await get_session()

            rows = get_pool_rows() or []

            now = time.time()

            if now - _last_slow >= FUNNEL_SLOW_INTERVAL_SEC:

                await run_funnel_slow_scan(session, pool_rows=rows, base_url=base_url)

                _last_slow = now

            if now - _last_fast >= FUNNEL_FAST_INTERVAL_SEC:

                alerts = await run_funnel_fast_scan(session, pool_rows=rows, base_url=base_url)

                _last_fast = now

                if alerts and on_alerts:

                    on_alerts(alerts)

        except asyncio.CancelledError:

            raise

        except Exception as exc:  # noqa: BLE001

            logger.warning("沉寂拉盘扫描失败: %s", exc)

        for _ in range(tick):

            if not is_running():

                break

            await asyncio.sleep(1)


