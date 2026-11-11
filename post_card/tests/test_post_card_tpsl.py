from __future__ import annotations

import sys
import unittest
from pathlib import Path

_TELEGRAM = Path(__file__).resolve().parents[2] / "telegram"
if _TELEGRAM.is_dir():
    sys.path.insert(0, str(_TELEGRAM))

from post_card.schema import TradeCard, SourceType
from post_card.tpsl import apply_defaults


class DefaultTpslUnifiedTest(unittest.TestCase):
    def test_defaults_5_10_long(self) -> None:
        card = TradeCard(
            source_type=SourceType.TELEGRAM,
            source_id="1",
            symbol="BTCUSDT",
            direction="long",
            entry="100",
        )
        out, changed = apply_defaults(card)
        self.assertTrue(changed)
        self.assertEqual(out.tpsl_source, "default")
        self.assertIn("95", out.stop_loss)
        self.assertIn("110", out.take_profit)


if __name__ == "__main__":
    unittest.main()
