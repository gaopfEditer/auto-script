"""Agent decision PA layer: swings, sweep+reclaim, OB/FVG, VWAP, A/B/C tagging, research strategies."""

from __future__ import annotations

import os
import unittest

from oi_mornitor.agent_decision import (
    attach_agent_decision,
    classify_group_a,
    classify_group_b,
    classify_group_c,
    compute_shadow_veto,
)
from oi_mornitor.pa.analysis import compute_pa_snapshot
from oi_mornitor.pa.b_tags import categorize_tags, liquidity_zone_phase
from oi_mornitor.pa.liquidity import compute_liquidity_zones
from oi_mornitor.pa.obfvg import compute_order_blocks
from oi_mornitor.pa.research_strategies import (
    STRATEGY_LIQUIDITY_REVERSAL,
    STRATEGY_RANGE,
    STRATEGY_TREND_PULLBACK,
    evaluate_research_strategies,
)
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

    def test_liquidity_phases_progression(self) -> None:
        zone = {
            "zone_id": "equal_lows:1:2",
            "kind": "equal_lows",
            "tested": True,
            "mitigated": True,
            "reclaimed": True,
        }
        events = [{"type": "choch_bullish", "index": 99}]
        phase, name, _ = liquidity_zone_phase(zone, events)
        self.assertGreaterEqual(phase, 4)
        self.assertIn(name, ("reclaimed", "reversal_confirmed"))


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


class BTagTaxonomyTests(unittest.TestCase):
    def test_position_only_does_not_activate_b(self) -> None:
        pa = {
            "close": 100.0,
            "structure": {"trend": "down", "events": []},
            "liquidity": {"zones": []},
            "obfvg": {"order_blocks": [], "fvgs": []},
            "vwap": {"position": "above"},
        }
        gb = classify_group_b(pa, "long")
        self.assertIn("vwap_above", gb["tags"])
        self.assertFalse(gb["active"])
        self.assertTrue(gb.get("positionOnly"))


class DirectionConfluenceTests(unittest.TestCase):
    def test_conflict_not_resonance(self) -> None:
        ga = {"active": True, "direction": "short"}
        gb = {"active": True, "direction": "long", "activationSource": "structure"}
        gc = classify_group_c(ga, gb)
        self.assertEqual(gc["classification"], "Conflict")
        self.assertFalse(gc["active"])
        self.assertTrue(gc["directionConflict"])


class ShadowVetoTests(unittest.TestCase):
    def test_veto_status_triple(self) -> None:
        pa = {"structure": {"trend": "down", "events": []}}
        veto = compute_shadow_veto({"side": "long"}, pa, "long", {"direction": "neutral"})
        self.assertIn(veto["status"], ("pass", "warning", "veto"))
        self.assertTrue(veto.get("shadow"))
        self.assertEqual(veto["status"], "veto")


class ResearchStrategyTests(unittest.TestCase):
    def test_strategies_schema(self) -> None:
        alert = {"side": "long", "interval": "15m"}
        pa = compute_pa_snapshot(
            [_candle(i, 100 + i * 0.05, 100.6 + i * 0.05, 99.5 + i * 0.05, 100.2 + i * 0.05, 500) for i in range(60)]
        )
        gb = classify_group_b(pa, "long")
        payload = evaluate_research_strategies(
            alert,
            pa,
            "long",
            b_tags=gb["tags"],
            categories=gb.get("tagCategories") or categorize_tags(gb["tags"]),
            liquidity_states=gb.get("liquidityStates") or [],
        )
        self.assertTrue(payload.get("readOnly"))
        self.assertEqual(payload.get("backtestStatus"), "planned_p1")
        ids = {m["id"] for m in payload.get("matches") or []}
        self.assertEqual(
            ids,
            {STRATEGY_LIQUIDITY_REVERSAL, STRATEGY_TREND_PULLBACK, STRATEGY_RANGE},
        )


class AgentDecisionTaggingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._prev = os.environ.get("OI_AGENT_DECISION_ENABLED")
        os.environ["OI_AGENT_DECISION_ENABLED"] = "1"

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop("OI_AGENT_DECISION_ENABLED", None)
        else:
            os.environ["OI_AGENT_DECISION_ENABLED"] = self._prev

    def test_attach_decision_fields(self) -> None:
        alert = {
            "symbol": "BTCUSDT",
            "interval": "15m",
            "side": "long",
            "type": "candle_pattern_card",
            "type_label": "倒锤子",
            "kind": "inverted_hammer",
        }
        candles = [_candle(i, 100 + i * 0.05, 100.6 + i * 0.05, 99.5 + i * 0.05, 100.2 + i * 0.05, 500) for i in range(60)]
        dec = attach_agent_decision(alert, klines=candles)
        self.assertIsNotNone(dec)
        self.assertTrue(dec.get("readOnly"))
        self.assertIn(dec.get("primaryGroup"), ("A", "B", "C", None))
        self.assertIn("researchStrategies", dec)
        self.assertIsInstance(dec.get("matchedIds") if "matchedIds" in dec else dec["researchStrategies"].get("matchedIds"), list)
        self.assertTrue((dec.get("shadowVeto") or {}).get("shadow"))
        self.assertIn("status", dec.get("shadowVeto") or {})


if __name__ == "__main__":
    unittest.main()
