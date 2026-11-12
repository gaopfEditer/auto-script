# /oi 交易策略重构

> 从「检测到形态就尝试交易」转向「识别市场环境 → 高质量机会 → 是否值得入场 → 独立仓位管理」。
> **文中过滤与新策略规则都是待验证的研究假设，不是已经证明有效的交易系统。**

相关模块：`pattern_settle.py`（诊断 + 强平）、`pattern_pause.py`、`trade_leverage.py`、`trade_diagnostics.py`、`market_regime.py`、`opportunity_score.py`、`strategy_ablation.py`、`strategy/trend_continuation.py`、`strategy/liquidity_reversal.py`、`strategy/range_reversion.py`、`strategy/decision_layer.py`。

## 目标（不是「胜率 55%」）

1. 单笔净期望值转正。
2. 盈亏比不再长期低于 1。
3. 利润因子 > 1，并在样本外保持。
4. 交易数量可以减少，但必须提高每笔质量。

## 默认配置（env，均带 `OI_` 前缀）

| 变量 | 默认 | 含义 |
|------|------|------|
| `OI_PAUSE_BOTTOM_SECONDARY` | **关** | 整类暂停二次探底（默认不暂停） |
| `OI_PAUSE_SHOOTING_STAR` | **关** | 整类暂停射击之星（默认不暂停） |
| `OI_REQUIRE_DIRECTION_OR_HTF_REVERSAL` | 开 | 二次探底/射击之星：方向未破 **或** 4h 已反转才放行 |
| `OI_BOTTOM_4H_DOWNTREND_FORBID_LONG` | **关** | 旧闸：4h 下跌一律禁止底部做多（默认改用情境闸） |
| `OI_SETTLE_LIQUIDATION` | 开 | 模拟强平（维持保证金） |
| `OI_SETTLE_CAP_LOSS_AT_MARGIN` | 开 | 单笔 ROE 不低于 -100（不超过保证金） |
| `OI_SETTLE_LEVERAGE_MAJOR` | 100 | BTC/ETH/SOL |
| `OI_SETTLE_LEVERAGE_ALT` | 20 | 其他加密（与沙盒 30x 是两套系统） |
| `OI_SETTLE_MMR_MAJOR` | 0.4 | 主流维持保证金占名义本金 % |
| `OI_SETTLE_MMR_ALT` | 1.0 | 山寨维持保证金 % |
| `OI_BT_FEE_PCT` | 0.06 | 单边手续费 %（须与账户核对） |
| `OI_BT_SLIPPAGE_PCT` | 0.03 | 单边滑点 %（固定，未按流动性分档） |

设为 `0` / `false` 可重开暂停形态做研究。资金费率：**未建模**（字段 `fundingModeled=false`），不虚构费率。现货/永续基差未建模。

## 形态分级

- **情境闸（替代整类暂停）**：底部二次探底、射击之星默认启用；须满足「信号周期方向未被反向收盘 BOS」**或**「4h 已同向反转（trend 同向 / CHoCH）」。不要继续抠几何参数。
- **保留、不主动调参**：头肩顶。
- **观察**：M 顶（样本不足，不可当核心）。
- **保留研究**：流动性掠夺 → 升级为严格独立策略（必须 sweep+reclaim+CHoCH）。
- Vegas 回踩 / Spring：不删除；回踩引擎已收紧（收盘确认、禁止立即收回、方向 K、结构/ATR 止损对照）；Spring 非本轮优先。
- 圆弧顶：不优先。

## 阶段 1：诊断与杠杆审计

每笔结算（及结构回测行）带：MFE/MAE（% 与 R）、TP1/TP2/Runner/TP1 后保本/初始 SL、持仓时间、手续费/滑点、强平与是否超过保证金、出场原因。同柱优先级仍是 **强平/止损 → 止盈**。

在 100x 下，若止损远于强平价（约 0.6%：1/100−0.4% MMR），旧模型会把亏损算成超过 1u 保证金（回测中 BTC/ETH 平均亏损曾到 1.10u / 1.38u）。现在先按强平价了结并标记 `liquidated`，再把 ROE 封顶在 -100。

```
# 在 discord-collector 目录，PYTHONPATH 含该目录
python -m oi_mornitor.scripts.export_trade_diagnostics path/to/structure_job.json -o ./diag_out
```

输出 CSV + JSON + 审计文本（命中率、强平异常、费率假设）。

## 阶段 2：消融（不加新指标）

对已有交易明细测试：删除二次探底、只保留完整流动性、HTF 对齐、4h 方向、OI 过滤（无数据记 `oi_unavailable` 并放行）及其组合。关注「排除了哪些亏损单」，不是最大化回测收益。

```
python -m oi_mornitor.scripts.run_strategy_ablation path/to/trades.json -o ablation_report.json
```

## 阶段 3：三个独立策略（不是只读标签）

各有入场、SL、TP、仓位、超时、禁止条件。入场为确认柱收盘后的**下一根开盘**，特征只用已收盘 K，摆动点无前瞻。

1. **趋势回调延续**（优先）：4h 均线一致且价格在有利侧；1h 收盘 BOS（非仅影线）；回踩缩量；OI 无明确不利；方向 K 确认；SL 在回踩结构外（可与 ATR 对照，`sl_profile=structure|atr`）；禁止 4h 反转或突破后迅速收回。报告请将 ETH 单独汇总，焦点币 BTC/DOGE。
2. **严格流动性反转**：必须 Sweep + Reclaim + CHoCH；SL 在 sweep 极值外；目标区间中位再对侧。仅 sweep 不可交易。
3. **震荡均值回归**：严格区间（上/下/中），只在边缘，假突破收回；有效突破后停止；趋势不得标成震荡。

```
python -m oi_mornitor.scripts.run_independent_strategies --symbol BTCUSDT --df1h 1h.csv --df4h 4h.csv --sl-profile structure -o indep_out
```

止盈默认仍为分批 1.5R/3R + runner（记录命中），可用 1.5/2/3R 对照，**先不要改默认倍数**。

## 阶段 4：组合脚手架（未验证）

`strategy/decision_layer.py` 按 4h/1h 环境分发策略，重叠持仓按优先级去重（不可把各策略盈亏直接相加）。预留 3 个月开发 / 1 个月验证 / 1 个月测试的滚动窗口。**组合收益不得当作已验证结果。**

## 机会评估

每笔候选带结构化评估（4h 趋势、1h 结构、OI、回踩量能、决策 long/short/wait/skip 与理由）。`feature_flags` 供消融与 `expectancy_combo.py` 聚合条件期望。**没有人工赋分胜率**；权重须经历史训练与样本外验证。

## 前端

结构回测页：暂停形态标注「已暂停」（仍可勾选做研究）；默认勾选不含暂停项；结果表可显示环境/出场/MFE·MAE；任务级「出场诊断」与导出命令。

## 6m 回测快照（情境闸）

- 报告：[`backtest-6m-opt-context-gate-2026-11-12.md`](./backtest-6m-opt-context-gate-2026-11-12.md)（`b7216c4`，2026-11-12 13:37 HKT）
- 对照旧版 1u：[`backtest-6m-lev-1u-2026-11-12.md`](./backtest-6m-lev-1u-2026-11-12.md)
- 摘要：结构层少亏但仍为负；独立三策略仅 UNI 合计为正；二次探底仍是主拖累；射击之星样本过小。
