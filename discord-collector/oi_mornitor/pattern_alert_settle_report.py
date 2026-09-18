"""形态信号列表结算摘要：北京时间 04/08/12/16/20/24 点推到 MAIN 群。"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from oi_mornitor.config import PATTERN_STATE_DB
from oi_mornitor.pattern_alert_stats import (
    _rec_pnl_pct,
    list_alert_stats,
    list_type_options,
    summarize,
)
from oi_mornitor.symbol_aliases import human_base_asset

logger = logging.getLogger(__name__)

_TZ_CN = timezone(timedelta(hours=8))
# 北京时间整点：4 / 8 / 12 / 16 / 20 / 24(=0)
_SLOT_HOURS = (0, 4, 8, 12, 16, 20)
_STATE_FILE = Path(PATTERN_STATE_DB).resolve().parent / "pattern_alert_settle_report.json"
_TYPE_TOP_N = 8
_MOVER_TOP_N = 3


def _now_cn(now: datetime | None = None) -> datetime:
    if now is None:
        now = datetime.now(_TZ_CN)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=_TZ_CN)
    else:
        now = now.astimezone(_TZ_CN)
    return now


def slot_hour_label(hour: int) -> str:
    return "24:00" if hour == 0 else f"{hour:02d}:00"


def due_slot(now: datetime | None = None) -> datetime:
    """当前 4h 档起点（北京时间）。整点后整档内均可补发一次。"""
    dt = _now_cn(now)
    slot_h = 0
    for hour in _SLOT_HOURS:
        if hour <= dt.hour:
            slot_h = hour
    return dt.replace(hour=slot_h, minute=0, second=0, microsecond=0)


def slot_window(slot: datetime) -> tuple[datetime, datetime]:
    """本档覆盖上一整点（含）到本档（不含）。"""
    end = slot
    start = end - timedelta(hours=4)
    return start, end


def _slot_key(slot: datetime) -> str:
    return slot.astimezone(_TZ_CN).strftime("%Y-%m-%dT%H:%M%z")


def _load_state() -> dict[str, Any]:
    if not _STATE_FILE.is_file():
        return {}
    try:
        raw = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取结算摘要状态失败: %s", exc)
        return {}


def _save_state(slot: datetime, ok: bool) -> None:
    payload = {
        "lastSlot": _slot_key(slot),
        "sentAt": int(datetime.now(_TZ_CN).timestamp() * 1000),
        "ok": ok,
    }
    try:
        _STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _STATE_FILE.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("写入结算摘要状态失败: %s", exc)


def already_sent(slot: datetime) -> bool:
    return str(_load_state().get("lastSlot") or "") == _slot_key(slot)


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def _in_range(rows: list[dict[str, Any]], start: datetime, end: datetime) -> list[dict[str, Any]]:
    lo, hi = _ms(start), _ms(end)
    return [r for r in rows if lo <= int(r.get("signalAt") or 0) < hi]


def _fmt_pnl(v: float | None) -> str:
    if v is None or not isinstance(v, (int, float)):
        return "—"
    sign = "+" if v > 0 else ""
    return f"{sign}{v:.1f}%"


def _fmt_summary_line(s: dict[str, Any]) -> str:
    wr = s.get("winRate")
    wr_s = "—" if wr is None else f"{float(wr) * 100:.0f}%"
    settled = int(s.get("wins") or 0) + int(s.get("losses") or 0)
    parts = [
        f"{int(s.get('total') or 0)} 条",
        f"胜率 {wr_s}",
        f"已核 {settled}（胜 {int(s.get('wins') or 0)} / 负 {int(s.get('losses') or 0)}）",
    ]
    pending = int(s.get("pending") or 0)
    if pending:
        parts.append(f"待核 {pending}")
    flats = int(s.get("flats") or 0)
    if flats:
        parts.append(f"平 {flats}")
    errors = int(s.get("errors") or 0)
    if errors:
        parts.append(f"失败 {errors}")
    pnl = s.get("totalPnlPct")
    if pnl is not None:
        parts.append(f"合计 {_fmt_pnl(float(pnl))}")
    return " · ".join(parts)


def _fmt_movers(rows: list[dict[str, Any]], *, positive: bool) -> list[str]:
    scored: list[tuple[float, dict[str, Any]]] = []
    for r in rows:
        pnl = _rec_pnl_pct(r)
        if pnl is None:
            continue
        if positive and pnl <= 0:
            continue
        if not positive and pnl >= 0:
            continue
        scored.append((float(pnl), r))
    scored.sort(key=lambda x: x[0], reverse=positive)
    lines: list[str] = []
    for pnl, r in scored[:_MOVER_TOP_N]:
        sym = human_base_asset(str(r.get("tradeSymbol") or r.get("symbol") or "")) or str(
            r.get("symbol") or ""
        )
        lab = str(r.get("typeLabel") or "").strip() or "信号"
        iv = str(r.get("interval") or "").strip()
        dir_s = str(r.get("dir") or "").strip()
        bit = f"{sym} {dir_s} {lab}".strip()
        if iv:
            bit += f" {iv}"
        lines.append(f"• {bit} {_fmt_pnl(pnl)}")
    return lines


def format_settle_report(slot: datetime, rows: list[dict[str, Any]] | None = None) -> str:
    slot = slot.astimezone(_TZ_CN)
    start, end = slot_window(slot)
    all_rows = rows if rows is not None else list_alert_stats()
    window_rows = _in_range(all_rows, start, end)
    day_start = slot.replace(hour=0, minute=0, second=0, microsecond=0)
    if slot.hour == 0:
        # 24:00 档：今日 = 刚结束的日历日
        day_start = day_start - timedelta(days=1)
        day_end = day_start + timedelta(days=1)
    else:
        day_end = slot
    day_rows = _in_range(all_rows, day_start, day_end)

    win_s = start.strftime("%H:%M")
    win_e = "24:00" if end.hour == 0 else end.strftime("%H:%M")
    title_h = slot_hour_label(slot.hour)
    date_s = slot.strftime("%Y-%m-%d")
    if slot.hour == 0:
        date_s = (slot - timedelta(seconds=1)).strftime("%Y-%m-%d")

    lines = [
        f"📊 形态信号结算 · {title_h}",
        f"{date_s} 档期 {win_s}–{win_e}（北京时间）",
        "",
        "本档 " + _fmt_summary_line(summarize(window_rows)),
    ]

    types = list_type_options(window_rows)[:_TYPE_TOP_N]
    if types:
        lines.append("按类型")
        for t in types:
            wr = t.get("winRate")
            wr_s = "—" if wr is None else f"{float(wr) * 100:.0f}%"
            pnl_s = _fmt_pnl(
                float(t["totalPnlPct"]) if t.get("totalPnlPct") is not None else None
            )
            lines.append(f"• {t['label']} {int(t.get('count') or 0)} · 胜率 {wr_s} · {pnl_s}")

    wins = _fmt_movers(window_rows, positive=True)
    losses = _fmt_movers(window_rows, positive=False)
    if wins:
        lines.append("本档盈利")
        lines.extend(wins)
    if losses:
        lines.append("本档亏损")
        lines.extend(losses)

    lines.append("")
    day_label = day_start.strftime("%m-%d")
    lines.append(f"当日累计 {day_label} " + _fmt_summary_line(summarize(day_rows)))
    lines.append(
        "核算：BTC/ETH/SOL 100x · 山寨 20x · TP 3%/7% 分批 · Runner 跟踪 · "
        "止损 ±5% · 每 15m 核实 · 最长 3h"
    )
    return "\n".join(lines)


def tick_settle_report(*, now: datetime | None = None, force: bool = False) -> bool:
    """到点则发送；已发过同档则跳过。返回是否发出。"""
    from oi_mornitor.config import STATS_SETTLE_TELEGRAM, STATS_SETTLE_TELEGRAM_CHAT_ID
    from oi_mornitor.notify_telegram import send_telegram_text

    if not STATS_SETTLE_TELEGRAM and not force:
        return False
    chat = STATS_SETTLE_TELEGRAM_CHAT_ID
    if not chat:
        return False
    slot = due_slot(now)
    if not force and already_sent(slot):
        return False
    text = format_settle_report(slot)
    ok = send_telegram_text(text, chat_id=chat)
    if ok:
        _save_state(slot, True)
        logger.info("形态结算摘要已推送 MAIN 群 · %s", _slot_key(slot))
    else:
        logger.warning("形态结算摘要推送失败 · %s", _slot_key(slot))
    return ok


async def run_settle_report_loop(is_running: Callable[[], bool]) -> None:
    await asyncio.sleep(8)
    while is_running():
        try:
            tick_settle_report()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("形态结算摘要循环异常: %s", exc)
        await asyncio.sleep(20)
