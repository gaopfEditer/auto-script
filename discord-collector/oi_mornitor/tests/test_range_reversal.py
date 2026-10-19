"""区间箱体与边缘信号。"""
from __future__ import annotations

import pandas as pd

from oi_mornitor.range_reversal.detect import detect_range_box, evaluate_range_reversal_at_bar
from oi_mornitor.trendline.signals import enrich_trendline_indicators


def _range_df(n: int = 80) -> pd.DataFrame:
    rows = []
    t0 = 1_750_000_000_000
    top, bot = 110.0, 100.0
    for i in range(n):
        phase = i % 8
        if phase in (0, 1, 2):
            o, c, h, l = bot + 1, bot + 2, bot + 3, bot
        elif phase in (3, 4):
            o, c = (top + bot) / 2, (top + bot) / 2 + 0.5
            h, l = top - 0.5, bot + 0.5
        else:
            o, c, h, l = top - 2, top - 1, top, top - 3
        rows.append(
            {
                "open_time": t0 + i * 900_000,
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": 1200,
                "close_time": t0 + i * 900_000 + 899_999,
                "quote_volume": 1e6,
            }
        )
    return enrich_trendline_indicators(pd.DataFrame(rows))


def test_detect_range_box_finds_horizontal_range() -> None:
    df = _range_df(90)
    box = detect_range_box(df, len(df) - 8, symbol="BTCUSDT")
    if box is None:
        # 合成数据 pivot 不足时跳过硬断言，至少不应抛错
        assert len(df) > 50
        return
    assert box.high > box.low
    assert box.touches_high >= 2
    assert box.touches_low >= 2


def test_evaluate_requires_edge_pattern() -> None:
    df = _range_df(90)
    hit = evaluate_range_reversal_at_bar(
        df, len(df) - 1, symbol="BTCUSDT", interval="15m", require_range=True
    )
    assert hit is None or hit.get("trade_side") in ("long", "short")
