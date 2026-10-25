"""从 smart.b EzRadar 拉榜单/异动，转成本地 all_tickers 形态（覆盖雷达矩阵逻辑）。

本机直连 fapi 常超时/451；smart.b 在 VPS 上代拉币安，节奏约 board 20s。
启用：SMARTB_RADAR_ENABLED=1（默认开）
地址：SMARTB_RADAR_BASE_URL=https://smart.b.ezcoin.ink
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

SMARTB_RADAR_ENABLED = os.getenv("SMARTB_RADAR_ENABLED", "1").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
SMARTB_RADAR_BASE_URL = (
    os.getenv("SMARTB_RADAR_BASE_URL", "https://smart.b.ezcoin.ink").strip().rstrip("/")
)
SMARTB_RADAR_REFRESH_SEC = float(os.getenv("SMARTB_RADAR_REFRESH_SEC", "20"))
SMARTB_RADAR_TIMEOUT_SEC = float(os.getenv("SMARTB_RADAR_TIMEOUT_SEC", "12"))

# 本地 UI 周期；smart.b 无 5m，用 15m 顶上
LOCAL_TFS = ("5m", "15m", "30m", "1h", "4h", "1d")
SMARTB_WINDOWS = ("15m", "30m", "1h", "4h", "1d", "3d")
TF_MAP = {
    "5m": "15m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
}

BOARD_TO_DOMAIN = {
    "gainers_value": ("price", True, "value"),
    "losers_value": ("price", False, "value"),
    "gainers_strength": ("price", True, "strength"),
    "losers_strength": ("price", False, "strength"),
    "oi_up_value": ("oi", True, "value"),
    "oi_down_value": ("oi", False, "value"),
    "oi_up_strength": ("oi", True, "strength"),
    "oi_down_strength": ("oi", False, "strength"),
    "perp_in_value": ("contract_flow", True, "value"),
    "perp_out_value": ("contract_flow", False, "value"),
    "perp_in_strength": ("contract_flow", True, "strength"),
    "perp_out_strength": ("contract_flow", False, "strength"),
    "spot_in_value": ("spot_flow", True, "value"),
    "spot_out_value": ("spot_flow", False, "value"),
    "spot_in_strength": ("spot_flow", True, "strength"),
    "spot_out_strength": ("spot_flow", False, "strength"),
}


def _empty_metric() -> dict[str, float]:
    return {
        "magnitude_usd": 0.0,
        "change_rate": 0.0,
        "z_score": 0.0,
        "intensity_score": 0.0,
    }


def _empty_rank_tf() -> dict[str, dict[str, float]]:
    return {
        "price": _empty_metric(),
        "oi": _empty_metric(),
        "contract_flow": _empty_metric(),
        "spot_flow": _empty_metric(),
    }


def _sym_base(symbol: str) -> str:
    s = str(symbol or "").upper().strip()
    if s.endswith("USDT"):
        s = s[:-4]
    if s.startswith("1000"):
        s = s[4:]
    return s



def _parse_aux_usd(raw: Any) -> float:
    """Parse smart.b auxDisplay like +$1.3M / -$443.4K into signed USD."""
    s = str(raw or "").strip().replace(",", "")
    if not s:
        return 0.0
    m = re.match(r"^([+-]?)\$?\s*([\d.]+)\s*([KMB万亿]?)$", s, re.I)
    if not m:
        return 0.0
    sign = -1.0 if m.group(1) == "-" else 1.0
    try:
        v = float(m.group(2))
    except ValueError:
        return 0.0
    unit = (m.group(3) or "").upper()
    mul = {"K": 1e3, "M": 1e6, "B": 1e9, "万": 1e4, "亿": 1e8}.get(unit, 1.0)
    return sign * v * mul


def _pair(symbol: str) -> str:
    s = str(symbol or "").upper().strip()
    return s if s.endswith("USDT") else f"{s}USDT"


def _apply_board_row(
    bucket: dict[str, Any],
    *,
    local_tf: str,
    board_key: str,
    row: dict[str, Any],
) -> None:
    meta = BOARD_TO_DOMAIN.get(board_key)
    if not meta:
        return
    domain, positive, _kind = meta
    rank_tf = bucket.setdefault("rank_by_tf", {})
    slot = rank_tf.setdefault(local_tf, _empty_rank_tf())
    m = dict(slot.get(domain) or _empty_metric())

    pct = float(row.get("pct") or 0.0)
    value = float(row.get("value") or 0.0)
    strength = float(row.get("strength") or row.get("bar") or 0.0)
    impact = float(row.get("impact") or 0.0)

    if domain == "price":
        # 本地 change_rate 为小数；smart.b pct 为百分数。
        # strength 榜的 value 常是 Str 分数，不能当涨跌幅。
        if _kind == "value" or abs(pct) > 1e-12:
            rate = (pct if abs(pct) > 1e-12 else value) / 100.0
            if not positive and rate > 0:
                rate = -rate
            if positive and rate < 0:
                rate = abs(rate)
            # 仅在尚无有效涨跌幅，或本行是 value 榜时写入
            if _kind == "value" or abs(float(m.get("change_rate") or 0)) < 1e-12:
                m["change_rate"] = rate
            if _kind == "value":
                m["magnitude_usd"] = abs(impact) if impact else abs(rate) * max(float(row.get("quoteVolume") or 0), 1e6)
        m["intensity_score"] = max(m["intensity_score"], strength if strength else (value if _kind == "strength" else 0))
    elif domain == "oi":
        # smart.b OI 榜通常无 oiPct：value=金额或 Str，auxDisplay=±$金额
        oi_pct = float(row.get("oiPct") or row.get("oi_pct") or row.get("pct") or 0.0)
        aux_mag = abs(_parse_aux_usd(row.get("auxDisplay")))
        # value 榜：value 为 USDT 变动；strength 榜：value/strength 为 Str 分数
        if _kind == "value":
            mag = abs(value) if abs(value) > 0 else aux_mag
            if oi_pct:
                rate = oi_pct / 100.0
            else:
                # 无真实涨跌幅时只保留方向，供同侧过滤；UI 量级榜看 magnitude
                rate = 0.01 if positive else -0.01
            if positive and rate < 0:
                rate = abs(rate)
            if not positive and rate > 0:
                rate = -rate
            m["magnitude_usd"] = mag
            m["change_rate"] = rate
        else:
            if abs(float(m.get("magnitude_usd") or 0)) < 1.0:
                # 强度榜优先用 auxDisplay 金额，避免占位 1.0
                m["magnitude_usd"] = aux_mag if aux_mag > 0 else max(abs(impact), 1.0)
            if oi_pct:
                rate = oi_pct / 100.0
                if positive and rate < 0:
                    rate = abs(rate)
                if not positive and rate > 0:
                    rate = -rate
                m["change_rate"] = rate
            elif abs(float(m.get("change_rate") or 0)) < 1e-12:
                # 仅方向占位；前端强度榜展示 intensity_score（Str），不再当 %
                m["change_rate"] = 0.01 if positive else -0.01
        str_score = abs(strength) if strength else (abs(value) if _kind == "strength" else 0.0)
        m["intensity_score"] = max(m["intensity_score"], str_score)
        # 同步 oi_by_tf（用已写入 m 的量级/涨跌，避免 strength 分支未定义 mag）
        mag = abs(float(m.get("magnitude_usd") or 0.0))
        rate = float(m.get("change_rate") or (0.01 if positive else -0.01))
        signed = mag if positive else -mag
        oi_map = bucket.setdefault("oi_by_tf", {})
        oi_map[local_tf] = {"delta_usd": signed, "pct": abs(rate) * 100.0}
        if local_tf in ("5m", "15m"):
            if local_tf == "5m" or not bucket.get("delta_5m_usd"):
                bucket["delta_5m_usd"] = signed
                bucket["pct_5m"] = abs(rate) * 100.0
            if local_tf == "15m":
                bucket["delta_15m_usd"] = signed
                bucket["pct_15m"] = abs(rate) * 100.0
    else:
        flow_key = "flow_by_tf" if domain == "contract_flow" else "spot_flow_by_tf"
        fmap = bucket.setdefault(flow_key, {})
        if _kind == "value":
            mag = abs(value)
            rate = 0.05 if positive else -0.05
            m["magnitude_usd"] = mag if positive else -mag
            m["change_rate"] = rate
            fmap[local_tf] = {"net_usd": mag if positive else -mag, "volume_usd": max(mag, 1.0)}
        else:
            if abs(float(m.get("magnitude_usd") or 0)) < 1e-9:
                mag = max(abs(impact), 1.0)
                m["magnitude_usd"] = mag if positive else -mag
                m["change_rate"] = 0.05 if positive else -0.05
                fmap[local_tf] = {"net_usd": m["magnitude_usd"], "volume_usd": mag}
        m["intensity_score"] = max(m["intensity_score"], strength if strength else (value if _kind == "strength" else 0))

    # 价格窗口
    if domain == "price":
        pmap = bucket.setdefault("price_by_tf", {})
        pmap[local_tf] = {"pct": abs(m["change_rate"]) * 100.0 * (1 if positive else -1)}
        if local_tf == "5m":
            bucket["pct_price_5m"] = pmap[local_tf]["pct"]
        if local_tf == "15m":
            bucket["pct_price_15m"] = pmap[local_tf]["pct"]

    slot[domain] = m
    rank_tf[local_tf] = slot
    bucket["rank_by_tf"] = rank_tf

    # 展示字段
    if row.get("price") is not None:
        try:
            bucket["last_price"] = float(row["price"])
        except (TypeError, ValueError):
            pass
    cat = row.get("category")
    if cat:
        bucket["category"] = cat
    name = row.get("name")
    if name:
        bucket["name"] = name


def _boards_to_rows(
    boards_by_window: dict[str, list[dict[str, Any]]],
    anomalies: list[dict[str, Any]],
    *,
    scan_ts: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_sym: dict[str, dict[str, Any]] = {}

    for local_tf in LOCAL_TFS:
        src_win = TF_MAP[local_tf]
        boards = boards_by_window.get(src_win) or []
        for board in boards:
            key = str(board.get("key") or "")
            for row in board.get("rows") or []:
                base = _sym_base(str(row.get("symbol") or ""))
                if not base:
                    continue
                pair = _pair(base)
                bucket = by_sym.get(pair)
                if not bucket:
                    bucket = {
                        "symbol": pair,
                        "volume_rank": 0,
                        "quote_volume": 0.0,
                        "last_price": float(row.get("price") or 0) or 0.0,
                        "current_oi": 0.0,
                        "current_oi_usd": 0.0,
                        "delta_5m_usd": 0.0,
                        "pct_5m": 0.0,
                        "delta_15m_usd": 0.0,
                        "pct_15m": 0.0,
                        "price_change_pct_24h": 0.0,
                        "status": "active",
                        "triggered_windows": [],
                        "raw_triggered_windows": [],
                        "is_hot": False,
                        "is_alert": False,
                        "is_suppressed": False,
                        "type": "SMARTB",
                        "individual_strength_score": None,
                        "is_historic_anomaly": False,
                        "global_intensity_rank": None,
                        "global_volume_rank": None,
                        "oi_by_tf": {},
                        "price_by_tf": {},
                        "flow_by_tf": {},
                        "spot_flow_by_tf": {},
                        "rank_by_tf": {},
                        "data_source": "smartb",
                    }
                    by_sym[pair] = bucket
                _apply_board_row(bucket, local_tf=local_tf, board_key=key, row=row)
                # impact → 粗算成交额权重
                impact = float(row.get("impact") or 0)
                if impact > bucket.get("quote_volume", 0):
                    bucket["quote_volume"] = abs(impact)
                tw = bucket.setdefault("triggered_windows", [])
                if local_tf not in tw:
                    tw.append(local_tf)

    # 异动标记
    hot: list[dict[str, Any]] = []
    for a in anomalies:
        base = _sym_base(str(a.get("symbol") or ""))
        if not base:
            continue
        pair = _pair(base)
        bucket = by_sym.get(pair)
        if not bucket:
            continue
        bucket["is_alert"] = True
        bucket["is_hot"] = True
        bucket["alert_reason"] = str(a.get("eventLabel") or a.get("event") or "smartb")
        bucket["alert_ts"] = float(a.get("ts") or scan_ts * 1000) / (
            1000.0 if float(a.get("ts") or 0) > 1e12 else 1.0
        )
        bucket["type"] = str(a.get("event") or "SMARTB_ALERT").upper()
        side = str(a.get("side") or "")
        bucket["status"] = "pump" if side == "up" else "dump" if side == "down" else "active"
        hot.append(dict(bucket))

    rows = list(by_sym.values())
    # volume_rank by quote_volume
    rows.sort(key=lambda r: float(r.get("quote_volume") or 0), reverse=True)
    for i, r in enumerate(rows, start=1):
        r["volume_rank"] = i
        r["global_volume_rank"] = i
        # intensity rank by max strength
        strengths = []
        for tf_slot in (r.get("rank_by_tf") or {}).values():
            for dom in tf_slot.values():
                strengths.append(float(dom.get("intensity_score") or 0))
        r["individual_strength_score"] = max(strengths) if strengths else None
    rows_by_str = sorted(
        rows,
        key=lambda r: float(r.get("individual_strength_score") or 0),
        reverse=True,
    )
    for i, r in enumerate(rows_by_str, start=1):
        r["global_intensity_rank"] = i

    if not hot:
        hot = [r for r in rows if r.get("is_hot")][:20]
    return rows, hot


class SmartbRadarSource:
    def __init__(self) -> None:
        self.enabled = SMARTB_RADAR_ENABLED
        self.base_url = SMARTB_RADAR_BASE_URL
        self.refresh_sec = max(8.0, SMARTB_RADAR_REFRESH_SEC)
        self.last_rows: list[dict[str, Any]] = []
        self.last_hot: list[dict[str, Any]] = []
        self.last_anomalies: list[dict[str, Any]] = []
        self.last_ts: float = 0.0
        self.last_error: str | None = None
        self.last_meta: dict[str, Any] = {}
        self._lock = asyncio.Lock()
        self._task: asyncio.Task[Any] | None = None
        self._session: aiohttp.ClientSession | None = None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session and not self._session.closed:
            return self._session
        timeout = aiohttp.ClientTimeout(total=SMARTB_RADAR_TIMEOUT_SEC)
        self._session = aiohttp.ClientSession(timeout=timeout)
        return self._session

    async def close(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    async def refresh_once(self) -> bool:
        if not self.enabled:
            return False
        session = await self._ensure_session()
        boards_by_window: dict[str, list[dict[str, Any]]] = {}
        anomalies: list[dict[str, Any]] = []
        meta: dict[str, Any] = {}
        try:
            # 并行拉各窗口 + 异动
            async def fetch_window(win: str) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
                url = f"{self.base_url}/api/v1/hot-boards?window={win}"
                async with session.get(url) as resp:
                    resp.raise_for_status()
                    data = await resp.json(content_type=None)
                return win, list(data.get("boards") or []), dict(data.get("meta") or {})

            async def fetch_anomalies() -> list[dict[str, Any]]:
                url = f"{self.base_url}/api/v1/anomalies"
                async with session.get(url) as resp:
                    resp.raise_for_status()
                    data = await resp.json(content_type=None)
                return list(data.get("anomalies") or [])

            results = await asyncio.gather(
                *[fetch_window(w) for w in SMARTB_WINDOWS],
                fetch_anomalies(),
                return_exceptions=True,
            )
            for item in results[:-1]:
                if isinstance(item, Exception):
                    logger.warning("smart.b window fetch failed: %s", item)
                    continue
                win, boards, wmeta = item
                boards_by_window[win] = boards
                if wmeta:
                    meta = wmeta
            last = results[-1]
            if isinstance(last, Exception):
                logger.warning("smart.b anomalies failed: %s", last)
            else:
                anomalies = last

            if not any(boards_by_window.values()):
                raise RuntimeError("smart.b 返回空榜单")

            now = time.time()
            rows, hot = _boards_to_rows(boards_by_window, anomalies, scan_ts=now)
            async with self._lock:
                self.last_rows = rows
                self.last_hot = hot
                self.last_anomalies = anomalies
                self.last_ts = now
                self.last_error = None
                self.last_meta = {
                    **meta,
                    "source": "smartb",
                    "source_label": "smart.b EzRadar",
                    "refresh_sec": self.refresh_sec,
                    "symbols": len(rows),
                    "anomalies": len(anomalies),
                }
            logger.info(
                "smart.b 雷达已刷新 symbols=%s anomalies=%s refresh=%.0fs",
                len(rows),
                len(anomalies),
                self.refresh_sec,
            )
            return True
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)
            logger.warning("smart.b 雷达刷新失败: %s", exc)
            return False

    async def _loop(self) -> None:
        while True:
            try:
                await self.refresh_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.exception("smart.b 循环异常: %s", exc)
            await asyncio.sleep(self.refresh_sec)

    def start_background(self) -> None:
        if not self.enabled:
            logger.info("smart.b 雷达桥未启用（SMARTB_RADAR_ENABLED=0）")
            return
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop(), name="smartb-radar")
        logger.info(
            "smart.b 雷达桥已启动 base=%s every=%.0fs",
            self.base_url,
            self.refresh_sec,
        )


_source = SmartbRadarSource()


def get_smartb_source() -> SmartbRadarSource:
    return _source
