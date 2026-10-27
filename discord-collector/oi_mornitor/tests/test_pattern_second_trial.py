"""方案1 第二审判：mock ezcoin-adapter。"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from oi_mornitor.ai_judge_bridge import AdapterJudgeResult
from oi_mornitor.pattern_second_trial import evaluate_second_trial


def _alert() -> dict:
    return {
        "type": "candle_pattern_card",
        "symbol": "BTCUSDT",
        "interval": "15m",
        "kind": "shooting_star",
        "side": "bear",
        "type_label": "射击之星",
        "kline_close_time": 1_700_000_000_000,
        "price": 100_000.0,
        "close": 100_000.0,
        "confluence": {"score": 78, "tier": "B"},
    }


class SecondTrialFormalTests(unittest.TestCase):
    def setUp(self) -> None:
        from oi_mornitor.pattern_second_trial import _DEDUPE_CACHE

        _DEDUPE_CACHE.clear()

    def test_pass_long_is_formal(self) -> None:
        with mock.patch("oi_mornitor.pattern_second_trial.OI_SECOND_TRIAL_ENABLED", True):
            with mock.patch("oi_mornitor.pattern_second_trial.OI_SECOND_TRIAL_BYPASS", False):
                with mock.patch(
                    "oi_mornitor.pattern_second_trial.call_adapter_judge",
                    return_value=AdapterJudgeResult(
                        ok=True, gate_result="pass", action="SHORT", rationale="ok"
                    ),
                ):
                    v = evaluate_second_trial(_alert(), confluence_formal=True)
        self.assertTrue(v.formal)
        self.assertEqual(v.action, "SHORT")

    def test_gate_reject_is_observation(self) -> None:
        with mock.patch("oi_mornitor.pattern_second_trial.OI_SECOND_TRIAL_ENABLED", True):
            with mock.patch(
                "oi_mornitor.pattern_second_trial.call_adapter_judge",
                return_value=AdapterJudgeResult(ok=False, gate_result="reject", action="SHORT"),
            ):
                v = evaluate_second_trial(_alert(), confluence_formal=True)
        self.assertFalse(v.formal)
        self.assertEqual(v.reason, "gate_reject")

    def test_watch_is_observation(self) -> None:
        with mock.patch("oi_mornitor.pattern_second_trial.OI_SECOND_TRIAL_ENABLED", True):
            with mock.patch(
                "oi_mornitor.pattern_second_trial.call_adapter_judge",
                return_value=AdapterJudgeResult(ok=True, gate_result="pass", action="WATCH"),
            ):
                v = evaluate_second_trial(_alert(), confluence_formal=True)
        self.assertFalse(v.formal)
        self.assertEqual(v.reason, "llm_not_trade")

    def test_adapter_down_is_observation(self) -> None:
        with mock.patch("oi_mornitor.pattern_second_trial.OI_SECOND_TRIAL_ENABLED", True):
            with mock.patch(
                "oi_mornitor.pattern_second_trial.call_adapter_judge",
                return_value=AdapterJudgeResult(ok=False, gate_result="unavailable", error="conn"),
            ):
                v = evaluate_second_trial(_alert(), confluence_formal=True)
        self.assertFalse(v.formal)
        self.assertEqual(v.reason, "adapter_unreachable")

    def test_c_tier_skips_adapter(self) -> None:
        with mock.patch(
            "oi_mornitor.pattern_second_trial.call_adapter_judge",
        ) as call_mock:
            v = evaluate_second_trial(_alert(), confluence_formal=False)
        call_mock.assert_not_called()
        self.assertFalse(v.formal)
        self.assertEqual(v.reason, "confluence_not_formal")


if __name__ == "__main__":
    unittest.main()
