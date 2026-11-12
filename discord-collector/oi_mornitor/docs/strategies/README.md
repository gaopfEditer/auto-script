# Strategies（源脚本存档）

| 文件 | 说明 |
|------|------|
| `aicoin-dca-td9-vegas-nlv.pine` | 用户 AICoin 短线 DCA 原脚本（TD9 + Vegas + 射击之星/倒锤子 + NLV） |

## Python 端口

- 信号：`strategy/dca_short_signals.py`（复用 `td_sequential` / `range_extreme_volume` / `strategy.indicators` / `candle_signals.near_vegas_channel`）
- 回测：`backtest/dca_pipeline.py` → 落盘 `data/dca_backtest/`
- CLI：`python -m oi_mornitor.scripts.run_dca_backtest` 或 `scripts/run_dca_backtest.py`
- API：`/api/backtest/dca/...`；UI：`/backtest` 第 4 节

## 模式与止损选择

| Mode | 行为 | 止损/出场 |
|------|------|-----------|
| A `nlv_flip` | NLV 买多/卖空腿 | 插针极值 SL + exit_plan（与第 3 节 NLV 一致） |
| B `td9_long` | TD-9 开多，TD+9 平 | **对手 TD9 下一根开盘**；默认无插针/ATR 硬 SL（对齐 Pine `enable_strategy` 市价无 SL） |
| C `confluence` | 标签/计分 | 无成交 |

信号仅已收盘柱；入场/TD 出场均为下一根开盘。

## 行情环境 tip

文案在 `backtest/regime_tips.py`，经 options API 下发；前端 `RegimeTip` 图标悬停/点击查看。

## 短线策略 V1

研究决策层（非已验证优势）：`docs/short_term_strategy_v1.md`。
CLI：`python -m oi_mornitor.scripts.run_short_term_strategy_v1`；API：`/api/backtest/short-term-v1/...`；UI：`/backtest` 第 5 节。
