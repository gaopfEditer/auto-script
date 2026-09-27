"""卡片监听：接入、生命周期状态、市价刷新（无纸面模拟开单）。"""
from __future__ import annotations

import logging
import time
from typing import Any

import aiohttp

from oi_mornitor.config import (
    CARD_DEFAULT_LEVERAGE,
    CARD_EVAL_INTERVAL,
    CARD_NEAR_ENTRY_PCT,
    CARD_NEAR_ENTRY_PCT_MAJOR,
    CARD_WS_ENABLED,
    FAPI_BASE_URL,
)
from oi_mornitor.pattern_monitor import fetch_pattern_klines_batch
from oi_mornitor.cards.card_parser import (
    ParsedCard,
    parse_card_message,
    resolve_signal_channel_author,
)
from oi_mornitor.cards.card_tracker import CardTracker
from oi_mornitor.cards.card_utils import (
    card_near_entry_pct,
    exit_reason_label,
    validate_card_levels,
)

logger = logging.getLogger("OI_Radar")


class CardEngine:
    def __init__(self) -> None:
        self.tracker = CardTracker()
        self._last_card_price_ts: float = 0.0
        self._last_scan_ts: float = 0.0

    def get_payload(self) -> dict[str, Any]:
        card_orders = []
        for o in self.tracker.list_card_orders(limit=200):
            author = resolve_signal_channel_author(
                str(o.get("channel_id") or ""),
                channel_name=str(o.get("channel_name") or ""),
                source_label=str(o.get("source_label") or ""),
                author_name=str(o.get("author_name") or ""),
            )
            if author:
                o = {**o, "author_name": author}
                if not o.get("channel_name") or str(o.get("channel_name")).isdigit():
                    o["channel_name"] = author
            card_orders.append(self._enrich_card_order_row(o))
        return {
            "card_orders": card_orders,
            "card_price_ts": self._last_card_price_ts,
            "card_scan_ts": self._last_scan_ts,
            "card_near_entry_pct": CARD_NEAR_ENTRY_PCT,
            "card_near_entry_pct_major": CARD_NEAR_ENTRY_PCT_MAJOR,
        }

    def ingest_card(self, payload: dict[str, Any] | str) -> dict[str, Any]:
        if not CARD_WS_ENABLED:
            return {"ok": False, "error": "卡片接入未启用"}
        card = parse_card_message(payload)
        if not card:
            return {"ok": False, "error": "无法解析卡片（需 ID/币种/方向/止损）"}
        if card.sl is None or card.sl <= 0:
            return {"ok": False, "error": "卡片缺少有效止损"}
        if card.entry_type != "market" and card.entry_low is not None:
            hi = card.entry_high if card.entry_high is not None else card.entry_low
            mid = (float(card.entry_low) + float(hi)) / 2.0
            ok_lv, lv_err = validate_card_levels(card.side, mid, card.sl, list(card.tps or []))
            if not ok_lv:
                logger.warning("卡片拒收 %s：%s", card.card_id, lv_err)
                return {"ok": False, "error": f"卡片价位异常：{lv_err}"}
        existing = self.tracker.get_card_order(card.card_id)
        if existing and existing.get("status") in ("filled", "closed"):
            return {
                "ok": True,
                "duplicate": True,
                "card_id": card.card_id,
                "status": existing.get("status"),
                "order": existing,
            }

        payload_dict = card.to_dict()
        status = "watching"
        if card.entry_type == "market":
            status = "ordered"
        order = {
            "card_id": card.card_id,
            "symbol": card.symbol,
            "side": card.side,
            "status": status,
            "payload": payload_dict,
            "created_at": (existing or {}).get("created_at") or time.time(),
        }
        self.tracker.upsert_card_order(order)
        self._ensure_card_pattern_slot(card.symbol)
        logger.info(
            "卡片接入 %s %s %s %s entry=%s SL=%s TPs=%s",
            card.card_id,
            card.symbol,
            card.side,
            card.entry_type,
            card.entry_type if card.entry_type == "market" else f"{card.entry_low}-{card.entry_high}",
            card.sl,
            card.tps,
        )
        return {
            "ok": True,
            "card_id": card.card_id,
            "status": status,
            "order": self.tracker.get_card_order(card.card_id),
        }

    @staticmethod
    def _ensure_card_pattern_slot(symbol: str) -> None:
        try:
            from oi_mornitor.radar import get_service

            pe = get_service().pattern_engine
            if pe.ensure_card_symbol(symbol):
                logger.info("卡片币已占形态槽 %s", symbol)
        except Exception as exc:  # noqa: BLE001
            logger.debug("卡片占形态槽失败 %s: %s", symbol, exc)

    @staticmethod
    def _entry_zone_distance_pct(
        price: float, entry_low: float | None, entry_high: float | None
    ) -> float | None:
        if price <= 0 or entry_low is None:
            return None
        hi = entry_high if entry_high is not None else entry_low
        lo, hi = min(entry_low, hi), max(entry_low, hi)
        if lo <= price <= hi:
            return 0.0
        if price < lo:
            return (lo - price) / price * 100.0
        return (price - hi) / price * 100.0

    @staticmethod
    def _price_in_entry_zone(
        price: float, entry_low: float | None, entry_high: float | None
    ) -> bool:
        if price <= 0 or entry_low is None:
            return False
        hi = entry_high if entry_high is not None else entry_low
        lo, hi = min(entry_low, hi), max(entry_low, hi)
        return lo <= price <= hi

    def _card_from_order(self, order: dict[str, Any]) -> ParsedCard | None:
        payload = order.get("payload") or order
        return parse_card_message(payload if isinstance(payload, dict) else order)

    @staticmethod
    def _card_level_distances(
        *,
        side: str,
        price: float,
        entry_low: float | None,
        entry_high: float | None,
        sl: float | None,
        tps: list[float] | None,
        fill_price: float | None = None,
    ) -> dict[str, Any]:
        side_u = str(side or "").upper()
        px = float(price or 0)
        info: dict[str, Any] = {"last_price": px}
        if px <= 0:
            return info
        entry_ref = float(fill_price) if fill_price and float(fill_price) > 0 else 0.0
        if entry_ref <= 0 and entry_low is not None:
            hi = entry_high if entry_high is not None else entry_low
            entry_ref = (float(entry_low) + float(hi)) / 2.0
        if entry_ref > 0:
            info["entry_ref"] = entry_ref
            info["dist_entry_pct"] = (px - entry_ref) / entry_ref * 100.0
        if entry_low is not None:
            hi = entry_high if entry_high is not None else entry_low
            lo, hi = min(float(entry_low), float(hi)), max(float(entry_low), float(hi))
            if lo <= px <= hi:
                info["dist_zone_pct"] = 0.0
            elif px < lo:
                info["dist_zone_pct"] = (lo - px) / px * 100.0
            else:
                info["dist_zone_pct"] = (px - hi) / px * 100.0
        if sl and float(sl) > 0:
            sl_v = float(sl)
            info["dist_sl_pct"] = (px - sl_v) / sl_v * 100.0 if side_u == "LONG" else (sl_v - px) / sl_v * 100.0
            info["sl_hit"] = (side_u == "LONG" and px <= sl_v) or (
                side_u == "SHORT" and px >= sl_v
            )
        tp_dists: list[dict[str, Any]] = []
        for i, tp in enumerate(tps or []):
            try:
                tp_v = float(tp)
            except (TypeError, ValueError):
                continue
            if tp_v <= 0:
                continue
            dist = (px - tp_v) / tp_v * 100.0 if side_u == "LONG" else (tp_v - px) / tp_v * 100.0
            hit = (side_u == "LONG" and px >= tp_v) or (side_u == "SHORT" and px <= tp_v)
            tp_dists.append({"tp": i + 1, "price": tp_v, "dist_pct": dist, "hit": hit})
        if tp_dists:
            info["tp_distances"] = tp_dists
            pending = [x for x in tp_dists if not x["hit"]]
            if pending:
                nxt = min(pending, key=lambda x: abs(float(x["dist_pct"])))
                info["next_tp"] = nxt["tp"]
                info["dist_next_tp_pct"] = nxt["dist_pct"]
        return info

    def _annotate_card_order_price(
        self, order: dict[str, Any], price: float, *, ts: float | None = None
    ) -> dict[str, Any]:
        px = float(price or 0)
        if px <= 0:
            return order
        now = float(ts if ts is not None else time.time())
        card = self._card_from_order(order)
        base = dict(order.get("payload") or {})
        if card:
            base = {**card.to_dict(), **base}
        dists = self._card_level_distances(
            side=str(order.get("side") or (card.side if card else "")),
            price=px,
            entry_low=card.entry_low if card else base.get("entry_low"),
            entry_high=card.entry_high if card else base.get("entry_high"),
            sl=card.sl if card else base.get("sl"),
            tps=list(card.tps if card else (base.get("tps") or [])),
            fill_price=base.get("fill_price"),
        )
        base.update(dists)
        base["last_price"] = px
        base["last_price_ts"] = now
        order["payload"] = base
        order["last_price"] = px
        order["last_price_ts"] = now
        order["dist_entry_pct"] = dists.get("dist_entry_pct")
        order["dist_zone_pct"] = dists.get("dist_zone_pct")
        order["dist_sl_pct"] = dists.get("dist_sl_pct")
        order["dist_next_tp_pct"] = dists.get("dist_next_tp_pct")
        order["next_tp"] = dists.get("next_tp")
        order["tp_distances"] = dists.get("tp_distances")
        return order

    def _mark_card_closed(
        self,
        card_id: str | None,
        *,
        exit_code: str,
        exit_label: str = "",
        exit_price: float | None = None,
        outcome: str = "",
    ) -> None:
        cid = str(card_id or "").strip()
        if not cid:
            return
        co = self.tracker.get_card_order(cid)
        if not co:
            return
        payload = dict(co.get("payload") or {})
        payload["exit_code"] = exit_code
        payload["exit_label"] = exit_label or exit_reason_label(exit_code)
        if exit_price is not None and float(exit_price) > 0:
            payload["exit_price"] = float(exit_price)
        payload["outcome"] = outcome or (
            "take_profit"
            if exit_code.startswith("card_tp")
            else "stop_loss"
            if exit_code == "card_sl"
            else "closed"
        )
        payload["closed_at"] = time.time()
        co["status"] = "closed"
        co["payload"] = payload
        co["exit_code"] = payload["exit_code"]
        co["exit_label"] = payload["exit_label"]
        co["exit_price"] = payload.get("exit_price")
        co["outcome"] = payload["outcome"]
        self.tracker.upsert_card_order(co)

    @staticmethod
    def _card_lifecycle_phase(order: dict[str, Any]) -> str:
        st = str(order.get("status") or "")
        if st == "rejected":
            return "拒收"
        if st == "closed":
            code = str(order.get("exit_code") or (order.get("payload") or {}).get("exit_code") or "")
            outcome = str(order.get("outcome") or (order.get("payload") or {}).get("outcome") or "")
            if code.startswith("card_tp") or outcome == "take_profit":
                return "止盈"
            if code == "card_sl" or outcome == "stop_loss":
                return "止损"
            return "出场"
        if st == "filled":
            return "入场"
        if st == "ordered":
            return "挂单"
        if st == "near":
            return "近场"
        if st == "watching":
            return "监听"
        return st or "建立"

    def _enrich_card_order_row(self, order: dict[str, Any]) -> dict[str, Any]:
        o = dict(order)
        payload = dict(o.get("payload") or {})
        for k in (
            "last_price",
            "last_price_ts",
            "dist_entry_pct",
            "dist_zone_pct",
            "dist_sl_pct",
            "dist_next_tp_pct",
            "next_tp",
            "tp_distances",
            "exit_code",
            "exit_label",
            "exit_price",
            "outcome",
            "fill_price",
            "closed_at",
            "reject_reason",
        ):
            if o.get(k) is None and payload.get(k) is not None:
                o[k] = payload.get(k)
        o["phase"] = self._card_lifecycle_phase(o)
        o["phase_created"] = True
        o["phase_watching"] = o.get("status") in (
            "watching",
            "near",
            "ordered",
            "filled",
            "closed",
        )
        o["phase_entered"] = o.get("status") in ("filled", "closed") or bool(o.get("fill_price"))
        o["phase_exited"] = o.get("status") == "closed"
        o["phase_sl"] = o.get("phase") == "止损"
        o["phase_tp"] = o.get("phase") == "止盈"
        return o

    def _price_map_from_pool(self, pool_rows: list[dict[str, Any]] | None) -> dict[str, float]:
        out: dict[str, float] = {}
        for r in pool_rows or []:
            sym = str(r.get("symbol") or "").upper()
            try:
                px = float(r.get("last_price") or 0)
            except (TypeError, ValueError):
                px = 0.0
            if sym and px > 0:
                out[sym] = px
        return out

    async def _fetch_prices(
        self,
        session: aiohttp.ClientSession,
        *,
        base_url: str,
        symbols: list[str],
        prices: dict[str, float],
    ) -> dict[str, float]:
        out = dict(prices)
        missing = [s for s in symbols if s not in out or out[s] <= 0]
        if not missing:
            return out
        km = await fetch_pattern_klines_batch(
            session,
            base_url=base_url,
            symbols=missing,
            interval=CARD_EVAL_INTERVAL,
            limit=3,
        )
        for sym in missing:
            kl = km.get(sym) or []
            if not kl:
                continue
            try:
                out[sym] = float(kl[-1][4])
            except (TypeError, ValueError, IndexError):
                pass
        return out

    async def refresh_card_market_prices(
        self,
        session: aiohttp.ClientSession,
        *,
        base_url: str = FAPI_BASE_URL,
        pool_rows: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        orders = [
            o
            for o in self.tracker.list_active_card_orders()
            if o.get("status") in ("watching", "near", "ordered", "filled")
        ]
        if not orders:
            return {"ok": True, "updated": 0, "symbols": []}
        prices = self._price_map_from_pool(pool_rows)
        all_syms = sorted({str(o.get("symbol") or "").upper() for o in orders if o.get("symbol")})
        prices = await self._fetch_prices(
            session, base_url=base_url, symbols=all_syms, prices=prices
        )
        now = time.time()
        updated = 0
        for order in orders:
            sym = str(order.get("symbol") or "").upper()
            px = prices.get(sym)
            if not px:
                continue
            annotated = self._annotate_card_order_price(order, px, ts=now)
            self.tracker.upsert_card_order(annotated)
            updated += 1
        self._last_card_price_ts = now
        return {
            "ok": True,
            "updated": updated,
            "symbols": all_syms,
            "ts": now,
            "interval": CARD_EVAL_INTERVAL,
        }

    async def scan_card_lifecycle(
        self,
        session: aiohttp.ClientSession,
        *,
        base_url: str,
        pool_rows: list[dict[str, Any]] | None = None,
    ) -> None:
        """更新卡片状态（近场/触价/SL·TP），不创建纸面仓位。"""
        prices = self._price_map_from_pool(pool_rows)
        active = self.tracker.list_active_card_orders()
        syms = sorted({str(o.get("symbol") or "").upper() for o in active if o.get("symbol")})
        prices = await self._fetch_prices(
            session, base_url=base_url, symbols=syms, prices=prices
        )
        now = time.time()
        for order in active:
            card = self._card_from_order(order)
            if not card:
                continue
            sym = card.symbol
            px = prices.get(sym)
            if not px:
                continue
            st = str(order.get("status") or "")

            if st in ("watching", "near", "ordered"):
                if card.entry_type == "market" or st == "ordered":
                    fill_px = px
                    ok_lv, lv_err = validate_card_levels(
                        card.side, fill_px, card.sl, list(card.tps or [])
                    )
                    if ok_lv:
                        order["status"] = "filled"
                        order["payload"] = {
                            **(order.get("payload") or card.to_dict()),
                            "fill_price": fill_px,
                            "last_price": px,
                        }
                    else:
                        order["status"] = "rejected"
                        order["reject_reason"] = lv_err
                else:
                    self._annotate_card_order_price(order, px, ts=now)
                    near_pct = card_near_entry_pct(sym, card.leverage)
                    dist = self._entry_zone_distance_pct(px, card.entry_low, card.entry_high)
                    if dist is not None and dist <= near_pct and st == "watching":
                        order["status"] = "near"
                    if self._price_in_entry_zone(px, card.entry_low, card.entry_high):
                        fill_px = px
                        if card.entry_low is not None:
                            hi = card.entry_high if card.entry_high is not None else card.entry_low
                            fill_px = (float(card.entry_low) + float(hi)) / 2.0
                        ok_lv, lv_err = validate_card_levels(
                            card.side, fill_px, card.sl, list(card.tps or [])
                        )
                        if ok_lv:
                            order["status"] = "filled"
                            order["payload"] = {
                                **(order.get("payload") or card.to_dict()),
                                "fill_price": fill_px,
                                "last_price": px,
                            }
                        else:
                            order["status"] = "rejected"
                            order["reject_reason"] = lv_err
                self.tracker.upsert_card_order(order)
                continue

            if st == "filled":
                self._annotate_card_order_price(order, px, ts=now)
                dists = self._card_level_distances(
                    side=card.side,
                    price=px,
                    entry_low=card.entry_low,
                    entry_high=card.entry_high,
                    sl=card.sl,
                    tps=list(card.tps or []),
                    fill_price=(order.get("payload") or {}).get("fill_price"),
                )
                if dists.get("sl_hit"):
                    self._mark_card_closed(
                        card.card_id,
                        exit_code="card_sl",
                        exit_price=px,
                    )
                    continue
                tp_dists = dists.get("tp_distances") or []
                if tp_dists and all(x.get("hit") for x in tp_dists):
                    self._mark_card_closed(
                        card.card_id,
                        exit_code="card_tp_all",
                        exit_price=px,
                    )
                else:
                    self.tracker.upsert_card_order(order)

        self._last_scan_ts = now
