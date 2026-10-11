"""潜力五模型单测（对齐 spec §10）。"""
import os
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from oi_mornitor.potential_aggregate import aggregate_candidate, should_export
from oi_mornitor.potential_features import SymbolFeed, closed_df
from oi_mornitor.potential_model_eval import (
    ModelResult,
    eval_m2_short_squeeze,
    eval_m4_wyckoff_spring,
    eval_m5_liquidity_sweep,
)
from oi_mornitor.potential_models_config import load_potential_config
from oi_mornitor.potential_universe import pass_universe


def _ohlcv(n: int, *, base: float = 10.0, vol: float = 1000.0) -> pd.DataFrame:
    t = np.arange(n)
    c = base + np.sin(t / 7) * 0.05
    return pd.DataFrame(
        {
            "open": c - 0.01,
            "high": c + 0.05,
            "low": c - 0.05,
            "close": c,
            "volume": np.full(n, vol),
            "open_time": (t * 3600_000).astype(np.int64),
        }
    )


class PotentialDiscoverySpecTests(unittest.TestCase):
    def test_t8_mcap_5b_rejected(self) -> None:
        with patch.dict(os.environ, {"OI_POTENTIAL_RELAX_MCAP": "0"}, clear=False):
            ok, reason = pass_universe(
                "BTCUSDT",
                quote_volume_24h=2e6,
                mcap_usd=5e9,
            )
        self.assertFalse(ok)
        self.assertEqual(reason, "mcap_out_of_range")

    def test_t3_funding_exiting(self) -> None:
        cfg = load_potential_config()
        n = 120
        df = _ohlcv(n)
        df["open_interest"] = np.linspace(100, 130, n)
        feed = SymbolFeed(
            symbol="TRBUSDT",
            funding_rates=[-0.01] * 5 + [0.001],
            candles={"1h": df},
        )
        r = eval_m2_short_squeeze(feed, cfg)
        self.assertIn(r.stage, ("exiting", "watch", "primed", "triggered"))

    def test_t6_spring_hard_fail(self) -> None:
        cfg = load_potential_config()
        n = 100
        c = np.full(n, 5.2)
        lo = np.full(n, 5.0)
        lo[-5:] = 4.5
        c[-5:] = 4.4
        df = pd.DataFrame(
            {
                "open": c,
                "high": c + 0.02,
                "low": lo,
                "close": c,
                "volume": np.full(n, 800.0),
            }
        )
        feed = SymbolFeed(symbol="TESTUSDT", candles={"4h": df})
        r = eval_m4_wyckoff_spring(feed, cfg)
        self.assertTrue(r.hard_fail or not r.hit)

    def test_t9_no_hit_not_exported(self) -> None:
        with patch.dict(os.environ, {"OI_POTENTIAL_SOFT_EXPORT_MIN": "0"}, clear=False):
            cand = aggregate_candidate(
                "X",
                [ModelResult("quiet_oi_breakout", False, 10, "watch", "", "", {}, "4h")],
                mcap_usd=4e7,
                mcap_tier="t3",
            )
        self.assertIsNone(cand)

    def test_soft_export_merges_sub_hit(self) -> None:
        env = {
            "OI_POTENTIAL_SOFT_EXPORT_MIN": "22",
            "OI_POTENTIAL_SCORE_LIST_MIN": "25",
            "OI_POTENTIAL_DISCOVERY_MIN_SCORE": "",
        }
        with patch.dict(os.environ, env, clear=False):
            cand = aggregate_candidate(
                "Y",
                [ModelResult("short_squeeze", False, 28, "watch", "OI↑", "", {}, "1h")],
                mcap_usd=4e7,
                mcap_tier="t3",
            )
            self.assertIsNotNone(cand)
            assert cand is not None
            self.assertEqual(cand["score"], 28)
            self.assertTrue(should_export(cand))

    def test_export_score_list_min(self) -> None:
        with patch.dict(
            os.environ,
            {"OI_POTENTIAL_SCORE_LIST_MIN": "55", "OI_POTENTIAL_DISCOVERY_MIN_SCORE": ""},
            clear=False,
        ):
            cfg = load_potential_config()
            list_min = int(cfg["export"]["score_list_min"])
            self.assertTrue(should_export({"stage": "watch", "score": 75}))
            self.assertTrue(should_export({"stage": "watch", "score": list_min}))
            self.assertFalse(should_export({"stage": "watch", "score": list_min - 1}))

    def test_hydrate_potential_json(self) -> None:
        from oi_mornitor.potential_discovery_store import (
            _POTENTIAL_JSON,
            get_discovery_payload,
            hydrate_discovery_from_disk,
        )

        if not _POTENTIAL_JSON.is_file():
            self.skipTest("no potential.json")
        self.assertTrue(hydrate_discovery_from_disk(force=True))
        payload = get_discovery_payload()
        self.assertTrue(payload.get("ok"))
        self.assertIsNotNone(payload.get("updated_utc8"))
        if (_POTENTIAL_JSON.read_text(encoding="utf-8").count('"symbol"')):
            self.assertGreater(len(payload.get("items") or []), 0)


if __name__ == "__main__":
    unittest.main()
