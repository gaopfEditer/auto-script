"""雷达 OI/价格异动与榜单进出事件的历史缓存（默认保留 4h，可 env 配置）。"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

from oi_mornitor.config import (
    OI_DELTA_MAX_PCT_15M,
    OI_DELTA_MAX_PCT_5M,
    OI_RADAR_ANOMALY_MAX_ITEMS,
    OI_RADAR_ANOMALY_RETENTION_SEC,
    OI_RADAR_BOARD_HISTORY_MAX,
    OI_RADAR_BOARD_TOP_N,
    PRICE_SPIKE_PCT_15M,
    PRICE_SPIKE_PCT_5M,
)

logger = logging.getLogger(__name__)

_LOCK = threading.Lock()
_MEMORY: dict[str, Any] | None = None
_LAST_BOARD_KEYS: set[str] = set()

_HISTORY_FILE = Path(__file__).resolve().parent / "data" / "radar_anomaly_history.json"

_BOARD_LISTS: tuple[tuple[str, str, str], ...] = (
    ("price", "up", "价格涨幅榜"),
    ("price", "down", "价格跌幅榜"),
    ("oi", "up", "持仓增加榜"),
    ("oi", "down", "持仓减少榜"),
    ("contract", "up", "合约流入榜"),
    ("contract", "down", "合约流出榜"),
)


def _now() -> float:
    import time

    return time.time()


def _compact_row(row: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "symbol",
        "last_price",
        "price_change_pct_24h",
        "quote_volume",
        "volume_rank",
        "current_oi_usd",
        "delta_5m_usd",
        "pct_5m",
        "delta_15m_usd",
        "pct_15m",
        "pct_price_5m",
        "pct_price_15m",
        "global_intensity_rank",
        "global_volume_rank",
        "status",
        "triggered_windows",
        "raw_triggered_windows",
        "alert_ts",
        "is_suppressed",
    )
    return {k: row.get(k) for k in keys if row.get(k) is not None}


def _is_triggered(delta_usd: float, pct: float, usd_limit: float, pct_limit: float) -> bool:
    try:
        du = float(delta_usd)
        pc = float(pct)
    except (TypeError, ValueError):
        return False
    return abs(du) >= usd_limit or abs(pc) >= pct_limit


def _plausible_oi(delta_usd: float, pct: float, oi_usd: float, window: str) -> bool:
    max_pct = OI_DELTA_MAX_PCT_5M if window == "5m" else OI_DELTA_MAX_PCT_15M
    if abs(pct) > max_pct:
        return False
    if oi_usd > 0 and abs(delta_usd) > oi_usd * (max_pct / 100.0):
        return False
    return True


def _price_pct(row: dict[str, Any], window: str) -> float:
    if window == "5m":
        return float(row.get("pct_price_5m") or 0)
    by_tf = row.get("price_by_tf") or {}
    if isinstance(by_tf, dict):
        block = by_tf.get("15m") or {}
        if isinstance(block, dict) and block.get("pct") is not None:
            return float(block.get("pct") or 0)
    return float(row.get("pct_price_15m") or 0)


def _rank_maps(rows: list[dict[str, Any]]) -> tuple[dict[str, int], dict[str, int]]:
    live = [r for r in rows if str(r.get("status") or "") != "warming"]
    by_price = sorted(live, key=lambda r: abs(float(r.get("pct_price_5m") or 0)), reverse=True)
    by_oi = sorted(live, key=lambda r: abs(float(r.get("delta_5m_usd") or 0)), reverse=True)
    pr = {str(r.get("symbol")): i + 1 for i, r in enumerate(by_price[:30])}
    oi = {str(r.get("symbol")): i + 1 for i, r in enumerate(by_oi[:30])}
    return pr, oi


def _tags_for(
    row: dict[str, Any],
    kind: str,
    price_rank: dict[str, int],
    oi_rank: dict[str, int],
) -> list[str]:
    sym = str(row.get("symbol") or "")
    tags: list[str] = []
    pr = price_rank.get(sym)
    oi = oi_rank.get(sym)
    if kind == "price" and pr is not None and pr <= 30:
        tags.append(f"涨跌幅榜 #{pr}")
    if kind == "oi" and oi is not None and oi <= 30:
        tags.append(f"持仓变动 #{oi}")
    gi = row.get("global_intensity_rank")
    if gi is not None and int(gi) <= 50:
        tags.append(f"全场强度 #{gi}")
    gv = row.get("global_volume_rank")
    if gv is not None and int(gv) <= 50:
        tags.append(f"全场量级 #{gv}")
    return tags[:3]


def _load() -> dict[str, Any]:
    global _MEMORY
    with _LOCK:
        if _MEMORY is not None:
            return dict(_MEMORY)
        data: dict[str, Any] = {"oi_price": [], "board": []}
        if _HISTORY_FILE.is_file():
            try:
                raw = json.loads(_HISTORY_FILE.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    data["oi_price"] = list(raw.get("oi_price") or [])
                    data["board"] = list(raw.get("board") or [])
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取雷达异动历史失败: %s", exc)
        _MEMORY = data
        return dict(data)


def _save(data: dict[str, Any]) -> dict[str, Any]:
    global _MEMORY
    with _LOCK:
        _MEMORY = data
        try:
            _HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
            _HISTORY_FILE.write_text(
                json.dumps(data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("写入雷达异动历史失败: %s", exc)
        return data


def _prune_list(items: list[dict[str, Any]], *, retention_sec: int, max_items: int) -> list[dict[str, Any]]:
    cutoff = _now() - max(60, int(retention_sec))
    kept = [
        x
        for x in items
        if isinstance(x, dict) and float(x.get("last_seen_ts") or x.get("alert_ts") or 0) >= cutoff
    ]
    kept.sort(key=lambda r: float(r.get("last_seen_ts") or r.get("alert_ts") or 0), reverse=True)
    if max_items > 0 and len(kept) > max_items:
        kept = kept[:max_items]
    return kept


def prune_history() -> None:
    data = _load()
    data["oi_price"] = _prune_list(
        data.get("oi_price") or [],
        retention_sec=OI_RADAR_ANOMALY_RETENTION_SEC,
        max_items=OI_RADAR_ANOMALY_MAX_ITEMS,
    )
    data["board"] = _prune_list(
        data.get("board") or [],
        retention_sec=OI_RADAR_ANOMALY_RETENTION_SEC,
        max_items=OI_RADAR_BOARD_HISTORY_MAX,
    )
    _save(data)


def _upsert(
    items: list[dict[str, Any]],
    rec: dict[str, Any],
    *,
    id_key: str = "id",
) -> list[dict[str, Any]]:
    rid = str(rec.get(id_key) or "")
    if not rid:
        return items
    out: list[dict[str, Any]] = []
    found = False
    for it in items:
        if str(it.get(id_key)) == rid:
            merged = {**it, **rec}
            merged["first_seen_ts"] = float(it.get("first_seen_ts") or rec.get("alert_ts") or _now())
            merged["last_seen_ts"] = float(rec.get("last_seen_ts") or _now())
            out.append(merged)
            found = True
        else:
            out.append(it)
    if not found:
        seen = float(rec.get("last_seen_ts") or rec.get("alert_ts") or _now())
        first = float(rec.get("first_seen_ts") or rec.get("alert_ts") or seen)
        rec = {**rec, "first_seen_ts": first, "last_seen_ts": seen}
        out.insert(0, rec)
    return out


def ingest_oi_price_from_rows(
    rows: list[dict[str, Any]],
    *,
    scan_ts: float,
    oi_usd_limit: float,
    oi_pct_limit: float,
    price_spike_5m: float = PRICE_SPIKE_PCT_5M,
    price_spike_15m: float = PRICE_SPIKE_PCT_15M,
) -> None:
    if not rows:
        return
    price_rank, oi_rank = _rank_maps(rows)
    now = float(scan_ts) if scan_ts > 0 else _now()
    new_recs: list[dict[str, Any]] = []

    for row in rows:
        if str(row.get("status") or "") == "warming":
            continue
        sym = str(row.get("symbol") or "")
        if not sym:
            continue
        oi_usd = float(row.get("current_oi_usd") or 0)
        alert_ts = float(row.get("alert_ts") or now)

        for window, delta, pct in (
            ("5m", float(row.get("delta_5m_usd") or 0), float(row.get("pct_5m") or 0)),
            ("15m", float(row.get("delta_15m_usd") or 0), float(row.get("pct_15m") or 0)),
        ):
            if not _is_triggered(delta, pct, oi_usd_limit, oi_pct_limit):
                continue
            if not _plausible_oi(delta, pct, oi_usd, window):
                continue
            raw_w = row.get("raw_triggered_windows") or []
            trig_w = row.get("triggered_windows") or []
            suppressed = window in raw_w and window not in trig_w
            new_recs.append(
                {
                    "id": f"oi-{sym}-{window}",
                    "kind": "oi",
                    "window": window,
                    "symbol": sym,
                    "alert_ts": alert_ts,
                    "pct": pct,
                    "delta_usd": delta,
                    "is_pump": delta > 0,
                    "is_suppressed": bool(suppressed),
                    "tags": _tags_for(row, "oi", price_rank, oi_rank),
                    "row": _compact_row(row),
                }
            )

        for window, limit in (("5m", price_spike_5m), ("15m", price_spike_15m)):
            pct = _price_pct(row, window)
            if abs(pct) < limit or abs(pct) > 80:
                continue
            new_recs.append(
                {
                    "id": f"price-{sym}-{window}",
                    "kind": "price",
                    "window": window,
                    "symbol": sym,
                    "alert_ts": now,
                    "pct": pct,
                    "delta_usd": 0.0,
                    "is_pump": pct > 0,
                    "is_suppressed": False,
                    "tags": _tags_for(row, "price", price_rank, oi_rank),
                    "row": _compact_row(row),
                }
            )

    if not new_recs:
        prune_history()
        return

    data = _load()
    items = list(data.get("oi_price") or [])
    ts_now = _now()
    for rec in new_recs:
        rec["last_seen_ts"] = ts_now
        items = _upsert(items, rec)
    data["oi_price"] = _prune_list(
        items,
        retention_sec=OI_RADAR_ANOMALY_RETENTION_SEC,
        max_items=OI_RADAR_ANOMALY_MAX_ITEMS,
    )
    _save(data)


def _metric(row: dict[str, Any], domain: str, positive: bool) -> float:
    """与前端 deriveLists 同口径；无 rank_by_tf 时回退 delta/pct 字段。"""
    rank_tf = row.get("rank_by_tf") or {}
    block = rank_tf.get("5m") if isinstance(rank_tf, dict) else None
    if isinstance(block, dict):
        dom = block.get(domain) if isinstance(block.get(domain), dict) else {}
        if isinstance(dom, dict) and dom.get("change_rate") is not None:
            rate = float(dom.get("change_rate") or 0)
            if positive and rate <= 0:
                return 0.0
            if not positive and rate >= 0:
                return 0.0
            if domain == "price":
                return abs(rate) * 100.0
            return abs(float(dom.get("magnitude_usd") or 0))
    # fallback
    if domain == "price":
        pct = float(row.get("pct_price_5m") or 0)
        if positive and pct <= 0:
            return 0.0
        if not positive and pct >= 0:
            return 0.0
        return abs(pct)
    if domain == "oi":
        du = float(row.get("delta_5m_usd") or 0)
        if positive and du <= 0:
            return 0.0
        if not positive and du >= 0:
            return 0.0
        return abs(du)
    flow = row.get("flow_by_tf") or {}
    if isinstance(flow, dict):
        f5 = flow.get("5m") if isinstance(flow.get("5m"), dict) else {}
        net = float((f5 or {}).get("net_usd") or (f5 or {}).get("net") or 0)
        if positive and net <= 0:
            return 0.0
        if not positive and net >= 0:
            return 0.0
        return abs(net)
    return 0.0


def ingest_board_from_rows(rows: list[dict[str, Any]], *, scan_ts: float) -> None:
    global _LAST_BOARD_KEYS
    if not rows:
        return
    live = [r for r in rows if str(r.get("status") or "") != "warming"]
    now = float(scan_ts) if scan_ts > 0 else _now()
    current_keys: set[str] = set()
    new_events: list[dict[str, Any]] = []

    for domain, polarity, label in _BOARD_LISTS:
        positive = polarity == "up"
        picked = sorted(
            live,
            key=lambda r: _metric(r, domain, positive),
            reverse=True,
        )
        picked = [r for r in picked if _metric(r, domain, positive) > 0][: max(1, int(OI_RADAR_BOARD_TOP_N))]
        for rank, row in enumerate(picked, start=1):
            sym = str(row.get("symbol") or "")
            if not sym:
                continue
            key = f"{domain}:{polarity}:5m:{sym}"
            current_keys.add(key)
            if key in _LAST_BOARD_KEYS:
                continue
            score = _metric(row, domain, positive)
            new_events.append(
                {
                    "id": f"board-{key}-{int(now)}",
                    "kind": "board",
                    "window": "5m",
                    "symbol": sym,
                    "board_domain": domain,
                    "board_polarity": polarity,
                    "board_label": label,
                    "board_rank": rank,
                    "alert_ts": now,
                    "pct": score if domain == "price" else 0.0,
                    "delta_usd": score if domain != "price" else 0.0,
                    "is_pump": positive,
                    "is_suppressed": False,
                    "tags": [f"{label} #{rank}"],
                    "row": _compact_row(row),
                }
            )

    _LAST_BOARD_KEYS = current_keys
    if not new_events:
        prune_history()
        return

    data = _load()
    items = list(data.get("board") or [])
    ts_now = _now()
    for rec in new_events:
        rec["last_seen_ts"] = ts_now
        items.insert(0, {**rec, "first_seen_ts": now})
    data["board"] = _prune_list(
        items,
        retention_sec=OI_RADAR_ANOMALY_RETENTION_SEC,
        max_items=OI_RADAR_BOARD_HISTORY_MAX,
    )
    _save(data)


def ingest_radar_scan(
    rows: list[dict[str, Any]],
    *,
    scan_ts: float,
    oi_usd_limit: float,
    oi_pct_limit: float,
    price_spike_5m: float = PRICE_SPIKE_PCT_5M,
    price_spike_15m: float = PRICE_SPIKE_PCT_15M,
) -> None:
    ingest_oi_price_from_rows(
        rows,
        scan_ts=scan_ts,
        oi_usd_limit=oi_usd_limit,
        oi_pct_limit=oi_pct_limit,
        price_spike_5m=price_spike_5m,
        price_spike_15m=price_spike_15m,
    )
    ingest_board_from_rows(rows, scan_ts=scan_ts)
    prune_history()


def history_payload() -> dict[str, Any]:
    prune_history()
    data = _load()
    return {
        "retention_sec": int(OI_RADAR_ANOMALY_RETENTION_SEC),
        "oi_price": list(data.get("oi_price") or []),
        "board": list(data.get("board") or []),
        "storage_path": str(_HISTORY_FILE),
    }
