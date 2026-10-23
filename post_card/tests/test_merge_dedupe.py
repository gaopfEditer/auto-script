from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from post_card.merge import PendingMergeStore
from post_card.pipeline import PostCardPipeline
from post_card.schema import TradeCard, SourceType


class MergeDedupeTest(unittest.TestCase):
    def test_merge_window_applies_defaults_on_expire(self) -> None:
        t0 = datetime(2025, 1, 1, 12, 0, tzinfo=timezone.utc)
        pipe = PostCardPipeline(merge_window_sec=900)
        a = TradeCard(
            source_type=SourceType.TELEGRAM,
            source_id="100",
            message_ids=["1"],
            author="kol",
            channel="ch",
            symbol="BTCUSDT",
            direction="long",
            entry="100",
            opened_at=t0,
            raw_texts=["long btc"],
        )
        self.assertEqual(pipe.ingest(a, now=t0), [])
        out = pipe.flush(now=t0 + timedelta(seconds=901))
        self.assertEqual(len(out), 1)
        c = out[0]
        self.assertEqual(c.tpsl_source, "default")
        self.assertTrue(c.stop_loss)
        self.assertTrue(c.take_profit)

    def test_merge_tpsl_within_window(self) -> None:
        t0 = datetime(2025, 1, 1, 12, 0, tzinfo=timezone.utc)
        pipe = PostCardPipeline(merge_window_sec=900)
        a = TradeCard(
            source_type=SourceType.DISCORD,
            source_id="c1",
            message_ids=["10"],
            author="kol",
            channel="c1",
            symbol="ETHUSDT",
            direction="short",
            entry="2000",
            opened_at=t0,
        )
        b = TradeCard(
            source_type=SourceType.DISCORD,
            source_id="c1",
            message_ids=["11"],
            author="kol",
            channel="c1",
            symbol="ETHUSDT",
            direction="short",
            entry="2000",
            stop_loss="2100",
            take_profit="1800",
            opened_at=t0 + timedelta(minutes=5),
        )
        self.assertEqual(pipe.ingest(a, now=t0), [])
        out = pipe.ingest(b, now=t0 + timedelta(minutes=5))
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].tpsl_source, "explicit")
        self.assertEqual(out[0].stop_loss, "2100")

    def test_dedupe_same_message_id(self) -> None:
        pipe = PostCardPipeline()
        t0 = datetime(2025, 1, 1, tzinfo=timezone.utc)
        card = TradeCard(
            source_type=SourceType.TWITTER,
            source_id="u1",
            message_ids=["99"],
            symbol="BTCUSDT",
            direction="long",
            entry="100",
            stop_loss="95",
            take_profit="110",
            opened_at=t0,
        )
        first = pipe.ingest(card, now=t0)
        self.assertEqual(len(first), 1)
        second = pipe.ingest(card, now=t0)
        self.assertEqual(second, [])


if __name__ == "__main__":
    unittest.main()
