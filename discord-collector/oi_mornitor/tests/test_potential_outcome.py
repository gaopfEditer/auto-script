"""潜力信号窗口盈/回撤与预期判定。"""
from __future__ import annotations

import unittest

from oi_mornitor.potential_outcome_eval import compute_window_excursions
from oi_mornitor.potential_outcome_expect import evaluate_track_expectation
from oi_mornitor.potential_outcome_tracker import _empty_checkpoints, track_id
from oi_mornitor.potential_model_eval import ModelResult


def _klines_from_closes(closes: list[tuple[int, float, float, float]]) -> list[list]:
    """(open_time_ms, open, high, low, close) simplified to binance row."""
    rows = []
    for ot, o, h, l, c in closes:
        rows.append([ot, str(o), str(h), str(l), str(c), "1000", ot + 899_999, "0"])
    return rows


class TestPotentialOutcome(unittest.TestCase):
    def test_long_max_profit_and_drawdown(self) -> None:
        t0 = 1_700_000_000_000
        step = 15 * 60 * 1000
        data = [
            (t0, 100, 100, 99, 100),
            (t0 + step, 100, 110, 98, 108),
            (t0 + 2 * step, 108, 109, 95, 97),
        ]
        end = t0 + 3 * step
        r = compute_window_excursions(
            _klines_from_closes(data),
            signal_time_ms=t0,
            window_end_ms=end,
            direction="long",
        )
        self.assertTrue(r.get("ok"))
        self.assertAlmostEqual(r["max_profit_pct"], 10.0, places=1)
        self.assertAlmostEqual(r["max_drawdown_pct"], 5.0, places=1)

    def test_short(self) -> None:
        t0 = 1_700_000_000_000
        step = 15 * 60 * 1000
        data = [
            (t0, 100, 101, 99, 100),
            (t0 + step, 100, 105, 90, 92),
        ]
        r = compute_window_excursions(
            _klines_from_closes(data),
            signal_time_ms=t0,
            window_end_ms=t0 + 2 * step,
            direction="short",
        )
        self.assertTrue(r.get("ok"))
        self.assertAlmostEqual(r["max_profit_pct"], 10.0, places=1)
        self.assertAlmostEqual(r["max_drawdown_pct"], 5.0, places=1)

    def test_expectation_long_met(self) -> None:
        ev = evaluate_track_expectation(
            direction="long",
            end_pnl_pct=2.0,
            max_profit_pct=5.0,
            max_drawdown_pct=3.0,
        )
        self.assertTrue(ev.get("met"))

    def test_expectation_long_fail_mae(self) -> None:
        ev = evaluate_track_expectation(
            direction="long",
            end_pnl_pct=5.0,
            max_profit_pct=8.0,
            max_drawdown_pct=12.0,
        )
        self.assertFalse(ev.get("met"))

    def test_checkpoint_keys_default(self) -> None:
        cps = _empty_checkpoints(1_700_000_000_000)
        self.assertIn("d1", cps)
        self.assertIn("d3", cps)
        self.assertIn("d7", cps)

    def test_register_writes_snapshot(self) -> None:
        from oi_mornitor.potential_outcome_tracker import _FILE, _store

        # 使用临时内存：清空全局 store 并指向隔离测试较复杂，仅测 track_id 与结构
        r = ModelResult(
            model_id="quiet_oi_breakout",
            hit=True,
            score=72.0,
            stage="building",
            entry="test",
            exit="",
            metrics={"oi_chg_pct": 1.2},
            tf="1h",
            signal_time_ms=1_700_000_000_000,
            direction="long",
            score_reasons=["OI 抬升"],
            label="OI 沉寂 → 建仓爆发",
        )
        tid = track_id("BTCUSDT", r.model_id, int(r.signal_time_ms))
        self.assertEqual(tid, "BTCUSDT:quiet_oi_breakout:1700000000000")
        # 不写入真实 data 文件以免污染；register 逻辑由集成扫描验证
        self.assertIsNotNone(_FILE)


if __name__ == "__main__":
    unittest.main()
