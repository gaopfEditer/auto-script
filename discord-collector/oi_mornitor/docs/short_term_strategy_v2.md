# 短线策略 V2

与 **V1**（`strategy/short_term_v1`：现有形态 / MTF / 五类 setup + 消融 A–E）**并行独立**。  
默认**不**把 V2 规则叠进 V1。后续组合应先按策略单独验证净期望。

参数是可编程初始规则，**不是**已验证盈利参数。

## 梯队映射

| V2 | V1 | 含义 |
|----|----|------|
| 1 | A | 第一梯队（BTC/ETH） |
| 2 | B | 第二梯队 |
| 3 | C/D | 第三梯队 |
| — | E | 美股代币，默认排除 |

## 策略编号

| 编号 | 名称 | 批次 |
|------|------|------|
| S01 | 短线形态放量 | 第一批（已实现） |
| S03 | 清算反转 | 第一批 |
| S04 | 清算延续 | 第一批 |
| S05 | 沉寂复苏 | 第一批 |
| S06 | 小币假突破 | 第一批 |
| S07 | 大币假突破 | 第一批 |
| S10 | OI 异常 | 第一批 |
| S02/S08/S09/S11/S12/S13 | 大周期/消息/平台/价格异常/流动性/RSI | 第二批（stub/观察） |

## 统一信号字段

`signal_type`, `market_cap_tier`, `trigger_time`, `confirm_time`, `entry_time`, `direction`, `entry_price`, `stop_price`, `target_price`, `price_return`, `net_return`, `MAE`, `MFE`, `exit_reason`  
另有 `status`：`observe` / `entry_ready` / `traded` / `skipped`。

## 怎么跑

在 `discord-collector` 目录：

```bash
PYTHONPATH=. python -m oi_mornitor.scripts.run_short_term_strategy_v2 --dry-run
PYTHONPATH=. python -m oi_mornitor.scripts.run_short_term_strategy_v2 --dry-run --parallel-v1

PYTHONPATH=. python -m oi_mornitor.scripts.run_short_term_strategy_v2 \
  --symbols BTCUSDT,ETHUSDT \
  --start 2026-05-01 --end 2026-11-01 \
  --strategies S01,S03,S04,S05,S06,S07,S10 \
  --parallel-v1 --v1-experiment E \
  --out oi_mornitor/data/short_term_v2/my-run
```

结果：`summary.json` + `summary.md`。并行模式下 `combinedSignals` 带 `strategyVersion=v1|v2`。

## 模块

`strategy/short_term_v2/`：`params`、`tiers`、`metrics`、`signal`、`common`、`strategies/*`、`engine`、`parallel`、`runner`。
