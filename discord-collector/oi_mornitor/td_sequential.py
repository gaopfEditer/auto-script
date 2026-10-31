"""TD Sequential Setup（DeMark）— 仅作共振评分特征，非独立自动交易引擎。

定义（与 AICoin ``td(close)`` / 常见 TD9 口径对齐）
------------------------------------------------
在收盘价序列上做 **Setup** 计数（非 Countdown）：

- 从第 5 根 K 起（0-based 下标 i≥4），比较 ``close[i]`` 与 ``close[i-4]``：
  - ``close[i] > close[i-4]``：卖出 Setup（正计数 +1…+9），同时清空买入 Setup；
  - ``close[i] < close[i-4]``：买入 Setup（负计数 -1…-9），同时清空卖出 Setup；
  - 相等：双向计数归零。
- 绝对计数封顶 9：条件持续成立时保持 ±9，便于形态出现时仍识别「已完成 TD9」。
- **超买** ``td == 9``（卖出 Setup 完成）；**超卖** ``td == -9``（买入 Setup 完成）。

组合用法见 ``confluence_features``：与倒锤子 / 射击之星 / 放量共振加分；
与方向冲突时不给 TD 加分（忽略 boost）。
"""
from __future__ import annotations

from typing import Any, Sequence


def td_setup_series(closes: Sequence[float | int]) -> list[int]:
    """返回与 closes 等长的 signed Setup 序列（|值|≤9）。"""
    n = len(closes)
    out = [0] * n
    if n < 5:
        return out
    buy = 0  # 负向累计（超卖方向）
    sell = 0  # 正向累计（超买方向）
    for i in range(4, n):
        try:
            c = float(closes[i])
            c4 = float(closes[i - 4])
        except (TypeError, ValueError):
            buy = 0
            sell = 0
            out[i] = 0
            continue
        if c > c4:
            sell = min(sell + 1, 9)
            buy = 0
            out[i] = sell
        elif c < c4:
            buy = min(buy + 1, 9)
            sell = 0
            out[i] = -buy
        else:
            buy = 0
            sell = 0
            out[i] = 0
    return out


def td_setup_at(closes: Sequence[float | int], index: int = -1) -> int:
    """单点 Setup 值；index 默认最后一根已收盘柱。"""
    series = td_setup_series(closes)
    if not series:
        return 0
    i = index if index >= 0 else len(series) + index
    if i < 0 or i >= len(series):
        return 0
    return int(series[i])


def is_td9_overbought(td: int) -> bool:
    return int(td) == 9


def is_td9_oversold(td: int) -> bool:
    return int(td) == -9


def td_label_zh(td: int) -> str:
    """UI 中文：超买 / 超卖 / 空。"""
    v = int(td)
    if v == 9:
        return "超买"
    if v == -9:
        return "超卖"
    if v > 0:
        return f"TD+{v}"
    if v < 0:
        return f"TD{v}"
    return ""


def closes_from_df(df: Any) -> list[float]:
    """从带 ``close`` 列的 DataFrame / 映射取收盘价列表。"""
    if df is None:
        return []
    try:
        col = df["close"]
        return [float(x) for x in col.tolist()]
    except Exception:  # noqa: BLE001
        return []


def closes_from_klines(klines: Sequence[Sequence[Any]]) -> list[float]:
    """Binance 风格 kline 行：index 4 = close。"""
    out: list[float] = []
    for row in klines or []:
        try:
            out.append(float(row[4]))
        except (TypeError, ValueError, IndexError):
            continue
    return out


def attach_td_setup(
    alert: dict[str, Any],
    closes: Sequence[float | int] | None = None,
    *,
    df: Any = None,
    index: int = -1,
) -> int:
    """就地写入 ``tdSetup`` / ``tdLabel``；返回 signed 值。"""
    seq = list(closes) if closes is not None else []
    if not seq and df is not None:
        seq = closes_from_df(df)
    td = td_setup_at(seq, index=index) if seq else 0
    alert["tdSetup"] = int(td)
    lab = td_label_zh(td)
    if lab in ("超买", "超卖"):
        alert["tdLabel"] = lab
    elif lab:
        alert["tdLabel"] = lab
    else:
        alert.pop("tdLabel", None)
    return int(td)


def debug_print_series(closes: Sequence[float | int], *, last: int = 20) -> None:
    series = td_setup_series(closes)
    start = max(0, len(series) - last)
    print("i\tclose\ttd")
    for i in range(start, len(series)):
        print(f"{i}\t{closes[i]}\t{series[i]}")


def _self_check() -> None:
    # 构造：连续 9 根 close > close[i-4] → 末值应为 +9（超买）
    # 先铺 4 根基准，再抬升
    base = [100.0, 100.0, 100.0, 100.0]
    up = [101.0 + i * 0.1 for i in range(9)]  # 每根都高于 4 根前
    closes_ob = base + up
    series_ob = td_setup_series(closes_ob)
    assert series_ob[-1] == 9, series_ob
    assert is_td9_overbought(series_ob[-1])

    # 连续更低 → -9 超卖
    down = [99.0 - i * 0.1 for i in range(9)]
    closes_os = base + down
    series_os = td_setup_series(closes_os)
    assert series_os[-1] == -9, series_os
    assert is_td9_oversold(series_os[-1])

    # 打断后归零再反向
    mixed = base + up[:3] + [100.0] + down
    # 仅断言可运行且末段为负或零
    _ = td_setup_series(mixed)
    print("td_sequential self-check OK", {"ob": series_ob[-1], "os": series_os[-1]})


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="TD Sequential Setup 调试 / 自检")
    p.add_argument("--self-check", action="store_true", help="跑内置夹具断言")
    p.add_argument(
        "--demo",
        action="store_true",
        help="打印一段演示收盘价的 TD 序列",
    )
    args = p.parse_args()
    if args.self_check or not args.demo:
        _self_check()
    if args.demo:
        demo = [100.0] * 4 + [101 + i * 0.2 for i in range(12)]
        debug_print_series(demo)
