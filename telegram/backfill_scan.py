"""
按 backfill_groups.json 拉取 Telegram 群历史，统计建卡级信号（与 listen.py / TradeCardPusher 同逻辑）。

用法:
  cd telegram && python backfill_scan.py --period week
  cd telegram && python backfill_scan.py --period month1 --chat-ids -1002404948215
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

from telethon.errors import FloodWaitError

from backfill_dedup import dedupe_cards
from backfill_store import BackfillStore, FetchStats, _ms
from message_format import sender_display
from session import create_and_start_client
from trade_backfill_engine import (
    MAX_BACKFILL_CARDS,
    BackfillReplayPusher,
    replay_chat_messages,
)
from trade_signal_detect import looks_like_trade_message, strip_promotional_lines

ROOT = Path(__file__).resolve().parent
CONFIG_FILE = ROOT / "backfill_groups.json"
PROFILES_FILE = ROOT / "channel_profiles.json"
CACHE_DIR = ROOT / ".backfill_cache"
DEFAULT_LIMIT_PER_CHAT = int(__import__("os").environ.get("TELEGRAM_BACKFILL_MSG_LIMIT", "4000"))
REPLAY_MODE = "trade_card_pusher"


def _normalize_period(period: str) -> str:
    p = (period or "week").strip().lower()
    aliases = {
        "month": "month1",
        "30d": "month1",
        "m": "month1",
        "1m": "month1",
    }
    if p in aliases:
        return aliases[p]
    if p in ("week", "month1", "month2", "month3", "month4"):
        return p
    return "week"


def _period_days(period: str) -> int:
    key = _normalize_period(period)
    return {
        "week": 7,
        "month1": 30,
        "month2": 60,
        "month3": 90,
        "month4": 120,
    }.get(key, 7)


def _period_bounds(period: str) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=_period_days(period))
    return start, now


def _load_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except json.JSONDecodeError:
        return {}


def _merge_profiles(groups: list[dict]) -> list[dict]:
    profiles = _load_json(PROFILES_FILE)
    out: list[dict] = []
    for g in groups:
        if not isinstance(g, dict):
            continue
        cid = str(g.get("chatId") or g.get("chat_id") or "").strip()
        if not cid:
            continue
        prof = profiles.get(cid) if isinstance(profiles.get(cid), dict) else {}
        name = str(g.get("name") or prof.get("name") or cid).strip()
        avatar = str(g.get("avatar") or prof.get("avatar") or "").strip()
        enabled = g.get("enabled")
        if enabled is False:
            continue
        out.append(
            {
                "chatId": cid,
                "name": name,
                "avatar": avatar,
                "note": str(g.get("note") or "").strip(),
            }
        )
    return out


def load_backfill_groups() -> list[dict]:
    cfg = _load_json(CONFIG_FILE)
    raw = cfg.get("groups")
    if not isinstance(raw, list):
        return []
    return _merge_profiles(raw)


def _parse_chat_ids(raw: str | None) -> set[str] | None:
    if raw is None or not str(raw).strip():
        return None
    out: set[str] = set()
    for part in str(raw).replace(",", " ").split():
        cid = part.strip()
        if cid:
            out.add(cid)
    return out or None


def _window_message_stats(messages: list[tuple[int, str, str, datetime]]) -> tuple[int, int]:
    msg_n = 0
    trade_n = 0
    for _mid, _sender, text, _at in messages:
        body = strip_promotional_lines((text or "").strip())
        if not body:
            continue
        msg_n += 1
        if looks_like_trade_message(body):
            trade_n += 1
    return msg_n, trade_n


def _symbols_from_cards(cards: list[dict]) -> dict[str, int]:
    from collections import Counter

    c: Counter[str] = Counter()
    for card in cards:
        sym = str(card.get("symbol") or "").strip().upper()
        if sym:
            c[sym] += 1
    return dict(c.most_common(20))


def _samples_from_cards(cards: list[dict], limit: int = 8) -> list[dict]:
    out: list[dict] = []
    for card in cards[:limit]:
        out.append(
            {
                "phase": card.get("phase"),
                "symbol": card.get("symbol"),
                "direction": card.get("direction"),
                "at": card.get("signalAt") or card.get("at"),
                "preview": card.get("preview"),
            }
        )
    return out


def _card_ts_ms(card: dict) -> int:
    raw = str(card.get("signalAt") or card.get("at") or "").strip()
    if not raw:
        return 0
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return _ms(dt)
    except ValueError:
        return 0


async def _fetch_gap(
    client,
    chat_id: int,
    chat_key: str,
    store: BackfillStore,
    gap_start_ms: int,
    gap_end_ms: int,
    until: datetime,
    *,
    limit: int,
    stats: FetchStats,
) -> None:
    gap_start = datetime.fromtimestamp(gap_start_ms / 1000, tz=timezone.utc)
    gap_end = datetime.fromtimestamp(gap_end_ms / 1000, tz=timezone.utc)
    end_dt = min(until, gap_end)
    fetched = 0
    stats.telethon_calls += 1
    async for message in client.iter_messages(chat_id, offset_date=end_dt):
        if not message or not getattr(message, "date", None):
            continue
        mdt = message.date
        if mdt.tzinfo is None:
            mdt = mdt.replace(tzinfo=timezone.utc)
        if mdt < gap_start:
            break
        if _ms(mdt) < gap_start_ms or _ms(mdt) > gap_end_ms:
            continue
        text = (message.message or "").strip()
        if not text:
            continue
        mid = int(message.id)
        if store.has_message(chat_key, mid):
            stats.skipped_existing += 1
            continue
        sender = await sender_display(client, message)
        if store.upsert_message(chat_key, mid, _ms(mdt), sender, text):
            stats.fetched_new += 1
            fetched += 1
        else:
            stats.skipped_existing += 1
        if fetched >= limit:
            break


async def _scan_one(
    client,
    chat_id: int,
    meta: dict,
    since: datetime,
    until: datetime,
    *,
    limit: int,
    store: BackfillStore,
    force_fetch: bool = False,
    force_replay: bool = False,
) -> dict:
    name = meta.get("name") or str(chat_id)
    chat_key = str(meta.get("chatId") or chat_id)
    start_ms = _ms(since)
    end_ms = _ms(until)
    fetch_stats = FetchStats()
    pusher: BackfillReplayPusher | None = None

    try:
        if force_fetch:
            gaps = [(start_ms, end_ms)]
        else:
            gaps = store.gaps_for_window(chat_key, start_ms, end_ms)
        fetch_stats.gaps = len(gaps)
        for g_start, g_end in gaps:
            await _fetch_gap(
                client,
                chat_id,
                chat_key,
                store,
                g_start,
                g_end,
                until,
                limit=limit,
                stats=fetch_stats,
            )
        store.add_coverage_range(chat_key, start_ms, end_ms)

        all_msgs = store.list_messages_in_window(chat_key, start_ms, end_ms, limit=limit)
        msg_count, trade_like = _window_message_stats(all_msgs)

        last_replayed, prior_digests = store.load_replay_state(chat_key)
        if force_replay:
            to_replay = all_msgs
            prior_digests = set()
        else:
            to_replay = [m for m in all_msgs if m[0] > last_replayed]

        pusher = BackfillReplayPusher(prior_digests=prior_digests)
        await replay_chat_messages(pusher, chat_id, str(name), to_replay)

        for card in pusher.stats.cards:
            digest = str(card.get("digest") or "").strip()
            if not digest:
                continue
            mid = int(card.get("msgId") or 0)
            ts_ms = _card_ts_ms(card) or (start_ms if mid else start_ms)
            store.upsert_card(chat_key, digest, card, mid, ts_ms)

        max_msg = max((m[0] for m in all_msgs), default=last_replayed)
        store.save_replay_state(chat_key, max_msg, pusher._pushed_digest)

        cards_raw = store.list_cards_in_window(chat_key, start_ms, end_ms, limit=MAX_BACKFILL_CARDS)
        cards = dedupe_cards(cards_raw)
        card_emit = len(cards)
        dedup_dropped = len(cards_raw) - len(cards)

        return {
            "chatId": meta.get("chatId"),
            "name": name,
            "avatar": meta.get("avatar") or "",
            "ok": True,
            "messageCount": msg_count,
            "tradeLikeCount": trade_like,
            "cardEmitCount": card_emit,
            "parsedSignalCount": card_emit,
            "symbols": _symbols_from_cards(cards),
            "samples": _samples_from_cards(cards),
            "cards": cards,
            "incremental": {
                "fetchGaps": fetch_stats.gaps,
                "messagesFetchedNew": fetch_stats.fetched_new,
                "messagesSkippedExisting": fetch_stats.skipped_existing,
                "messagesReplayed": len(to_replay),
                "messagesInWindow": len(all_msgs),
            },
            "dedupDropped": dedup_dropped,
            "error": None,
        }
    except FloodWaitError as e:
        st = pusher.stats if pusher else None
        cards_fb = (
            store.list_cards_in_window(chat_key, start_ms, end_ms, limit=MAX_BACKFILL_CARDS)
            if pusher is None
            else st.cards
        )
        return {
            "chatId": meta.get("chatId"),
            "name": name,
            "avatar": meta.get("avatar") or "",
            "ok": False,
            "messageCount": st.message_count if st else 0,
            "tradeLikeCount": st.trade_like_count if st else 0,
            "cardEmitCount": len(cards_fb),
            "parsedSignalCount": len(cards_fb),
            "symbols": _symbols_from_cards(cards_fb) if pusher is None else dict(st.symbols),
            "samples": _samples_from_cards(cards_fb) if pusher is None else st.samples,
            "cards": cards_fb,
            "error": f"FloodWait {e.seconds}s",
        }
    except Exception as e:
        st = pusher.stats if pusher else None
        cards_fb = (
            store.list_cards_in_window(chat_key, start_ms, end_ms, limit=MAX_BACKFILL_CARDS)
            if pusher is None
            else st.cards
        )
        return {
            "chatId": meta.get("chatId"),
            "name": name,
            "avatar": meta.get("avatar") or "",
            "ok": False,
            "messageCount": st.message_count if st else 0,
            "tradeLikeCount": st.trade_like_count if st else 0,
            "cardEmitCount": len(cards_fb),
            "parsedSignalCount": len(cards_fb),
            "symbols": _symbols_from_cards(cards_fb) if pusher is None else dict(st.symbols),
            "samples": _samples_from_cards(cards_fb) if pusher is None else st.samples,
            "cards": cards_fb,
            "error": str(e),
        }


def _parse_force_flags() -> tuple[bool, bool]:
    import os

    raw = (os.environ.get("TELEGRAM_BACKFILL_FORCE") or "").strip().lower()
    force_fetch = False
    force_replay = False
    if raw in ("1", "true", "yes", "all", "fetch"):
        force_fetch = True
    if raw in ("1", "true", "yes", "all", "replay"):
        force_replay = True
    return force_fetch, force_replay


async def run_scan(
    *,
    period: str,
    out_path: Path | None,
    limit: int,
    chat_ids: set[str] | None = None,
    force_fetch: bool = False,
    force_replay: bool = False,
) -> dict:
    since, until = _period_bounds(period)
    groups = load_backfill_groups()
    if chat_ids:
        groups = [g for g in groups if str(g.get("chatId") or "").strip() in chat_ids]
    if not groups:
        raise SystemExit(f"未配置回溯群：请编辑 {CONFIG_FILE}，或检查 --chat-ids")

    env_fetch, env_replay = _parse_force_flags()
    force_fetch = force_fetch or env_fetch
    force_replay = force_replay or env_replay

    store = BackfillStore(CACHE_DIR)
    client, _ = await create_and_start_client()
    results: list[dict] = []
    try:
        for meta in groups:
            cid_raw = str(meta.get("chatId") or "").strip()
            try:
                chat_id = int(cid_raw)
            except ValueError:
                results.append(
                    {
                        **meta,
                        "ok": False,
                        "messageCount": 0,
                        "tradeLikeCount": 0,
                        "cardEmitCount": 0,
                        "parsedSignalCount": 0,
                        "symbols": {},
                        "samples": [],
                        "error": f"invalid chatId: {cid_raw}",
                    }
                )
                continue
            print(f"[backfill] 扫描 {meta.get('name')} ({chat_id}) …", flush=True)
            row = await _scan_one(
                client,
                chat_id,
                meta,
                since,
                until,
                limit=limit,
                store=store,
                force_fetch=force_fetch,
                force_replay=force_replay,
            )
            results.append(row)
            inc = row.get("incremental") if isinstance(row.get("incremental"), dict) else {}
            print(
                f"  → msg={row.get('messageCount')} trade≈{row.get('tradeLikeCount')} "
                f"cards={row.get('cardEmitCount')} "
                f"(+{inc.get('messagesFetchedNew', 0)} new, replay={inc.get('messagesReplayed', 0)})",
                flush=True,
            )
    finally:
        await client.disconnect()

    ranking = sorted(
        results,
        key=lambda r: (
            int(r.get("cardEmitCount") or r.get("parsedSignalCount") or 0),
            int(r.get("tradeLikeCount") or 0),
            int(r.get("messageCount") or 0),
        ),
        reverse=True,
    )

    period_key = _normalize_period(period)
    generated_at = datetime.now(timezone.utc).isoformat()
    inc_totals = {
        "messagesFetchedNew": 0,
        "messagesSkippedExisting": 0,
        "messagesReplayed": 0,
        "fetchGaps": 0,
    }
    for r in results:
        inc = r.get("incremental")
        if not isinstance(inc, dict):
            continue
        for k in inc_totals:
            inc_totals[k] += int(inc.get(k) or 0)

    payload = {
        "ok": True,
        "replayMode": REPLAY_MODE,
        "incrementalMode": not (force_fetch or force_replay),
        "forceFetch": force_fetch,
        "forceReplay": force_replay,
        "incrementalTotals": inc_totals,
        "period": period_key,
        "periodDays": _period_days(period),
        "fromMs": int(since.timestamp() * 1000),
        "toMs": int(until.timestamp() * 1000),
        "generatedAt": generated_at,
        "configFile": str(CONFIG_FILE),
        "selectedChatIds": [str(g.get("chatId") or "").strip() for g in groups],
        "groupCount": len(results),
        "groups": results,
        "ranking": [
            {
                "chatId": r.get("chatId"),
                "name": r.get("name"),
                "cardEmitCount": r.get("cardEmitCount"),
                "parsedSignalCount": r.get("parsedSignalCount"),
                "tradeLikeCount": r.get("tradeLikeCount"),
                "messageCount": r.get("messageCount"),
            }
            for r in ranking
        ],
    }

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    default_out = CACHE_DIR / f"{period_key}.latest.json"
    target = out_path or default_out
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[backfill] 已写入 {target}", flush=True)

    history_dir = CACHE_DIR / "history" / period_key
    history_dir.mkdir(parents=True, exist_ok=True)
    run_id = generated_at.replace(":", "-").replace("+", "_")
    history_file = history_dir / f"{run_id}.json"
    history_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[backfill] 历史快照 {history_file}", flush=True)
    return payload


def main() -> None:
    ap = argparse.ArgumentParser(description="Telegram 群组信号回溯统计（TradeCardPusher 重放）")
    ap.add_argument(
        "--period",
        choices=["week", "month1", "month2", "month3", "month4", "month"],
        default="week",
    )
    ap.add_argument("--out", default="", help="输出 JSON 路径")
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT_PER_CHAT)
    ap.add_argument("--chat-ids", default="", help="逗号分隔 chatId；空则扫描配置中全部 enabled 群")
    ap.add_argument(
        "--force",
        action="store_true",
        help="全量重拉并重放（等同 TELEGRAM_BACKFILL_FORCE=1）",
    )
    ap.add_argument(
        "--force-fetch",
        action="store_true",
        help="忽略覆盖区间，Telegram 全窗口重拉（仍会去重入库）",
    )
    ap.add_argument(
        "--force-replay",
        action="store_true",
        help="窗口内消息全量重放建卡（不清库）",
    )
    args = ap.parse_args()
    out = Path(args.out).resolve() if args.out else None
    ids = _parse_chat_ids(args.chat_ids)
    try:
        force_fetch = bool(args.force or args.force_fetch)
        force_replay = bool(args.force or args.force_replay)
        asyncio.run(
            run_scan(
                period=args.period,
                out_path=out,
                limit=max(100, args.limit),
                chat_ids=ids,
                force_fetch=force_fetch,
                force_replay=force_replay or force_fetch,
            )
        )
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
