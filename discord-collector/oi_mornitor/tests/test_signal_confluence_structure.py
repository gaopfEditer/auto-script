"""综合分与摆动结构倾向对齐。"""

import unittest

from oi_mornitor.signal_confluence import compute_signal_confluence


class SignalConfluenceStructureTests(unittest.TestCase):
    def test_counter_structure_penalizes_long(self) -> None:
        rec = {
            "typeLabel": "倒锤子",
            "interval": "15m",
            "side": "long",
            "structure_bias": {"bias": "bear", "score": 65},
            "market_structure_bias": "bear",
        }
        out = compute_signal_confluence(rec)
        self.assertIn(out["tier"], ("C", "D"))
        self.assertLess(out["score"], 45)

    def test_aligned_structure_boosts_short(self) -> None:
        rec = {
            "typeLabel": "射击之星",
            "interval": "1h",
            "side": "short",
            "structure_bias": {"bias": "bear", "score": 60},
        }
        base = compute_signal_confluence({**rec, "structure_bias": None})
        aligned = compute_signal_confluence(rec)
        self.assertGreaterEqual(aligned["score"], base["score"])


if __name__ == "__main__":
    unittest.main()
