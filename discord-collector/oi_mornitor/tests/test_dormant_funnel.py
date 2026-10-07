"""沉寂拉盘三阶段漏斗单测。"""

import unittest

import numpy as np
import pandas as pd

from oi_mornitor.dormant_funnel import evaluate_dormant_funnel_df


def _synthetic_dormant(n: int = 760) -> pd.DataFrame:
    t = np.arange(n, dtype=float)
    close = 100 + np.sin(t / 80) * 0.5
    vol = np.full(n, 1000.0)
    vol[-200:-24] = 200.0
    vol[-1] = 8000.0
    vol[-2] = 5000.0
    vol[-3] = 3000.0
    vol[-100] = 5000.0
    high = close + 0.3
    low = close - 0.3
    oi = np.full(n, 1e6)
    oi[-1] = 1.25e6
    return pd.DataFrame(
        {
            "open_time": (1_700_000_000_000 + t * 3_600_000).astype(np.int64),
            "open": close,
            "high": high,
            "low": low,
            "close": close,
            "volume": vol,
            "open_interest": oi,
        }
    )


class DormantFunnelTests(unittest.TestCase):
    def test_insufficient_data(self) -> None:
        df = _synthetic_dormant(100)
        out = evaluate_dormant_funnel_df(df)
        self.assertFalse(out.get("signal"))
        self.assertEqual(out.get("stage"), "NONE")

    def test_returns_structure(self) -> None:
        df = _synthetic_dormant()
        out = evaluate_dormant_funnel_df(df)
        self.assertIn("phase1", out)
        self.assertIn("score", out)
        self.assertIn("stage", out)


if __name__ == "__main__":
    unittest.main()
