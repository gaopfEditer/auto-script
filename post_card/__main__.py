"""CLI: normalize fixtures and run card backtests."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from post_card.adapters import from_discord_message, from_telegram_message, from_twitter_json
from post_card.backtest import run_backtest
from post_card.pipeline import PostCardPipeline
from post_card.schema import TradeCard, SourceType


def _load_cards(path: Path) -> list[TradeCard]:
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data if isinstance(data, list) else data.get("cards") or [data]
    out: list[TradeCard] = []
    for row in items:
        if not isinstance(row, dict):
            continue
        st = SourceType(str(row.get("source_type") or row.get("source") or "telegram"))
        opened = row.get("opened_at")
        opened_dt = None
        if opened:
            opened_dt = datetime.fromisoformat(str(opened).replace("Z", "+00:00"))
        out.append(
            TradeCard(
                source_type=st,
                source_id=str(row.get("source_id") or ""),
                message_ids=[str(x) for x in (row.get("message_ids") or [])],
                author=str(row.get("author") or ""),
                channel=str(row.get("channel") or ""),
                symbol=str(row.get("symbol") or ""),
                direction=str(row.get("direction") or ""),
                entry=str(row.get("entry") or ""),
                stop_loss=str(row.get("stop_loss") or ""),
                take_profit=str(row.get("take_profit") or ""),
                tpsl_source=str(row.get("tpsl_source") or ""),
                opened_at=opened_dt,
                raw_texts=list(row.get("raw_texts") or []),
            )
        )
    return out


def cmd_normalize(args: argparse.Namespace) -> int:
    raw = json.loads(Path(args.input).read_text(encoding="utf-8"))
    pipeline = PostCardPipeline()
    cards: list[TradeCard] = []
    for item in raw if isinstance(raw, list) else [raw]:
        if not isinstance(item, dict):
            continue
        src = str(item.get("source") or item.get("source_type") or "telegram")
        text = str(item.get("text") or item.get("body") or "")
        if src == "discord":
            c = from_discord_message(
                text=text,
                author=str(item.get("author") or ""),
                channel_id=str(item.get("channel_id") or item.get("channelId") or ""),
                channel_name=str(item.get("channel") or ""),
                message_id=str(item.get("message_id") or item.get("id") or ""),
            )
        elif src in ("twitter", "x"):
            c = from_twitter_json(item)
        else:
            c = from_telegram_message(
                text=text,
                chat_id=item.get("chat_id") or item.get("channelId") or "",
                chat_title=str(item.get("channel") or ""),
                msg_id=item.get("msg_id") or item.get("message_id") or item.get("id") or "",
                sender=str(item.get("author") or item.get("sender") or ""),
            )
        if c:
            cards.extend(pipeline.ingest(c))
    cards.extend(pipeline.flush())
    payload = [c.to_dict() for c in cards]
    out = Path(args.output) if args.output else None
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if out:
        out.write_text(text, encoding="utf-8")
    else:
        print(text)
    return 0


def cmd_backtest(args: argparse.Namespace) -> int:
    cards = _load_cards(Path(args.cards))
    ohlc_path = Path(args.ohlc)
    bars_data = json.loads(ohlc_path.read_text(encoding="utf-8"))
    bars = bars_data if isinstance(bars_data, list) else bars_data.get("bars") or []
    results = []
    for card in cards:
        r = run_backtest(card, bars)
        results.append({"card": card.to_dict(), "backtest": r.to_dict()})
    text = json.dumps(results, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
    else:
        print(text)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m post_card")
    sub = p.add_subparsers(dest="cmd", required=True)

    n = sub.add_parser("normalize", help="Adapt raw posts JSON → finalized cards")
    n.add_argument("input", help="JSON file (list of posts)")
    n.add_argument("-o", "--output", help="Write cards JSON")
    n.set_defaults(func=cmd_normalize)

    b = sub.add_parser("backtest", help="Run OHLC replay on finalized cards")
    b.add_argument("--cards", required=True, help="Cards JSON")
    b.add_argument("--ohlc", required=True, help="OHLC JSON (list of bars)")
    b.add_argument("-o", "--output", help="Write results JSON")
    b.set_defaults(func=cmd_backtest)

    args = p.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
