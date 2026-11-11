"""Agent decision PA layer: swings, sweep+reclaim, OB/FVG, VWAP, A/B/C tagging."""

from __future__ import annotations

import os
import unittest

from oi_mornitor.agent_decision import (
    attach_agent_decision,
    classify_group_a,
    classify_group_b,
    classify_group_c,
)
from oi_mornitor.pa.analysis import compute_pa_snapshot
from oi_mornitor.pa.liquidity import compute_liquidity_zones
from oi_mornitor.pa.obfvg import compute_order_blocks
from oi_mornitor.pa.swings import detect_structure
from oi_mornitor.pa.vwap_sessions import compute_vwap, vwap_position


def _candle(i: int, o: float, h: float, l: float, c: float, v: float = 100.0) -> dict:
    return {
        "open_time": 1_700_000_000 + i * 3600,
        "open": o,
        "high": h,
        "low": l,
        "close": c,
        "volume": v,
    }


class SwingStructureTests(unittest.TestCase):
    def test_bos_then_choch(self) -> None:
        candles = []
        price = 100.0
        for i in range(40):
            if i < 10:
                price -= 0.3
            elif i < 20:
                price += 0.8
            elif i < 30:
                price += 0.2
            else:
                price -= 1.2
            candles.append(
                _candle(
                    i,
                    price,
                    price + 0.5,
                    price - 0.5,
                    price + (0.1 if i % 2 == 0 else -0.1),
                )
            )
        struct = detect_structure(candles)
        types = {e["type"] for e in struct.get("events", [])}
        self.assertTrue(types & {"bos_bullish", "bos_bearish", "choch_bullish", "choch_bearish"})


class LiquidityReclaimTests(unittest.TestCase):
    def test_sweep_and_reclaim_equal_lows(self) -> None:
        candles = []
        base = 50.0
        for i in range(25):
            lo = base - (0.2 if i % 5 == 0 else 0.05)
            hi = lo + 1.0
            cl = lo + 0.4
            candles.append(_candle(i, lo, hi, lo, cl))
        candles.append(_candle(25, 49.0, 49.5, 48.0, 49.2))
        candles.append(_candle(26, 49.2, 50.5, 49.0, 50.3))
        struct = detect_structure(candles)
        liq = compute_liquidity_zones(candles, struct)
        reclaimed = any(z.get("reclaimed") for z in liq.get("zones", []))
        mitigated = any(z.get("mitigated") for z in liq.get("zones", []))
        self.assertTrue(mitigated)
        self.assertTrue(reclaimed)


class ObFvgVwapTests(unittest.TestCase):
    def test_fvg_detection(self) -> None:
        candles = [
            _candle(0, 10, 10.5, 9.8, 10.2),
            _candle(1, 10.2, 11, 10.1, 10.8),
            _candle(2, 11.5, 12, 11.2, 11.8),
        ]
        struct = detect_structure(candles)
        obfvg = compute_order_blocks(candles, struct)
        self.assertGreaterEqual(len(obfvg.get("fvgs") or []), 1)

    def test_vwap_side(self) -> None:
        candles = [_candle(i, 100 + i * 0.1, 100.5 + i * 0.1, 99.5 + i * 0.1, 100 + i * 0.1, 1000) for i in range(10)]
        vw = compute_vwap(candles)
        pos = vwap_position(float(candles[-1]["close"]), vw.get("current"))
        self.assertIn(pos, ("above", "below", "at", None))


class AgentDecisionTaggingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._prev = os.environ.get("OI_AGENT_DECISION_ENABLED")
        os.environ["OI_AGENT_DECISION_ENABLED"] = "1"

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop("OI_AGENT_DECISION_ENABLED", None)
        else:
            os.environ["OI_AGENT_DECISION_ENABLED"] = self._prev

    def test_abc_resonance(self) -> None:
        alert = {
            "symbol": "BTCUSDT",
            "interval": "15m",
            "side": "long",
            "type": "candle_pattern_card",
            "type_label": "倒锤子",
            "kind": "inverted_hammer",
        }
        candles = [_candle(i, 100 + i * 0.05, 100.6 + i * 0.05, 99.5 + i * 0.05, 100.2 + i * 0.05, 500) for i in range(60)]
        alert["pa_klines"] = candles
        ga = classify_group_a(alert)
        self.assertTrue(ga["active"])
        pa = compute_pa_snapshot(candles)
        gb = classify_group_b(pa, "long")
        gc = classify_group_c(ga, gb)
        self.assertIsInstance(gc["active"], bool)
        dec = attach_agent_decision(alert, klines=candles)
        self.assertIsNotNone(dec)
        self.assertIn(dec.get("primaryGroup"), ("A", "B", "C", None))
        self.assertTrue(dec.get("readOnly"))
        self.assertTrue((dec.get("shadowVeto") or {}).get("shadow"))


if __name__ == "__main__":
    unittest.main()
