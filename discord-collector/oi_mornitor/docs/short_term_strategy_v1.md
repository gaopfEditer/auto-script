# 短线策略 V1

这是一套**可回测的研究框架**，参数是起点，**不是已经验证的盈利承诺或最佳参数**。
它加在现有 OI / 形态 / 均线 / Vegas / 市场环境数据之上，作为决策层，而不是再造一套指标。

优化目标：单笔净期望转正、盈亏比不长期低于 1、利润因子在样本外大于 1、更少但更高质量的交易。**不是**追求 55% 胜率。机会评分只作解释与过滤，没有手工加总的「AI 判断」胜率权重。

## 默认设定（用户未回答偏好问题时的锁定值）

| 项目 | V1 默认 |
|------|---------|
| 场地 | USDT-M 永续（合约优先） |
| 持仓 | 灵活短线 5 分钟–4 小时 |
| 周期栈 | 4H 环境 · 1H 结构 · 15M 机会形成 · 5M 执行 |
| 宇宙 | 加密货币，**不含美股代币**（E 档存根并默认跳过，不套用 A 档加密参数） |
| 单笔风险（权益中值） | A 0.40% · B 0.30% · C 0.18% · D 0.10%。仓位 \(=\frac{E\times r}{\|P-S\|}\) |
| 杠杆/强平 | 沿用现有口径：BTC/ETH/SOL 100x，山寨 20x；亏损封顶在保证金 |
| ATR | **ATR(15 分钟)**，不是「15 百万」 |
| ATR 止损中值 | A 1.4× · B 1.6× · C 1.75× · D 用结构止损 + 滑点缓冲 |
| 分批止盈 | A 25%@1R / 35%@2R / 40%跟踪；B 35%@1R / 35%@1.8R / 30%跟踪；C 35%@0.8R / 40%@1.5R / 25%更紧跟踪；D 50%@0.8R / 30%@1.5R / 20%严格跟踪 |
| TP1 后 | **不**自动把剩余仓位移到保本 |
| 同柱 | 先止损再止盈（悲观） |
| 并发风险 | 高度相关同向持仓的单笔风险预算之和上限 1.20% 权益，超出则跳过新开仓 |
| 二次探底 | **默认暂停**（`OI_PAUSE_BOTTOM_SECONDARY=1`） |
| 射击之星（含连续走平） | **默认启用**，须过情境闸；可用 `OI_PAUSE_SHOOTING_STAR=1` 整类暂停 |
| 情境闸代码 | 保留 |

结构止损过远（宽于档位 ATR 上限 × 1.15）或第一档计划止盈低于约 0.8R，直接放弃。入场后不扩大止损、不补仓。剩余仓位风险有上限。

## 分层

市值排名只是初分组，**流动性说了算**：市值 + 近 30 日日均成交额 + 盘口深度（若有）。

- **A** BTC、ETH：可更多依赖整体市场状态。
- **B** 大市值山寨（SOL、DOGE 等）：要求 BTC 方向不冲突，相对强弱确认。
- **C** 中市值：必须有明确结构、真实成交量、盘口支持。
- **D** 小市值：不能只看 K 线形态；无盘口深度时默认跳过（`depth_missing=true`），不虚构深度。
- **E** 美股代币：独立策略，默认宇宙排除。

实现见 `strategy/short_term_v1/tiers.py`，扩展现有 `mcap_tier`。

## 五类机会与放弃规则

统一识别器（不同档位流动性和风险参数不同）：

1. `liquidity_sweep_reclaim`：扫单后收回 + CHoCH。**仅扫单不是入场**（复用严格流动性反转）。
2. `breakout_pullback`：放量**收盘**突破后回踩不破（复用趋势回调延续；**仅影线刺破拒绝**）。
3. `absorption`：主动成交增加但价格停滞，须等结构确认。依赖 CVD；缺失则跳过并标记，不假装检出。
4. `relative_strength`：BTC 上涨不急着做多落后币；BTC 回落观察相对强势（B 档尤其适用）。
5. `liquidation_exhaustion`：清算潮后等待强制成交衰减并收回结构。清算打印本身不是反转；无历史则跳过并标记。

放弃规则是一等公民过滤器：BTC 4H 下跌不追山寨暴涨、落后币不盲目做多、OI 升而价格停滞则等待、放量不足不追突破、盘口变薄则减仓或取消（无深度则跳过该条并标记）、极端资金费+拥挤降低追单、小币长上影不立即反向、美股代币脱锚或默认排除。

## 成交模型与数据缺口

- 入场：**下一根开盘 + 不利滑点**，不是只用收盘价成交。默认手续费 0.06%/边、滑点 0.03%/边（`OI_BT_FEE_PCT` / `OI_BT_SLIPPAGE_PCT`）。
- 滑点超过 0.15%/边视为**未成交，保守跳过**（没有订单簿回放时，不假设限价全部成交，也不按更差价格强行成交）。
- **现货 K 线仅作永续价格代理**；基差未建模。资金费率有序列才计入，否则标记未建模、不虚构。
- 回测与实盘成交会有偏差，报告里会注明。
- 杠杆/强平/保证金封顶复用现有 `pattern_settle` / `trade_leverage` 口径。

## 消融实验（同一引擎，不是五套复制内核）

相同区间、手续费、滑点、杠杆、成交规则；建议再做滚动样本外。

| 实验 | 内容 |
|------|------|
| A | 现有形态 + 均线 + Vegas（二次探底仍排除；射击之星默认纳入） |
| B | A + BTC 市场状态过滤 |
| C | B + OI / 资金费 / 清算确认（有数据才要求；缺失则标记） |
| D | C + 扫流动性收回 / CVD / 吸收 |
| E | D + 分档止损止盈与风险预算（完整 V1）。A–D 共用一套中间退出参数，以便隔离过滤条件 |

关注：净收益、利润因子、单笔期望、最大回撤、按币种/档位/环境拆分、成交与回测偏差。避免只在 BTC 牛市有效、震荡就持续亏损。

## 怎么跑

在 `discord-collector` 目录，使用项目虚拟环境（系统 Python 缺 aiohttp）：

```bash
PYTHONPATH=. oi_mornitor/venv/bin/python -m oi_mornitor.scripts.run_short_term_strategy_v1 --help

PYTHONPATH=. oi_mornitor/venv/bin/python -m oi_mornitor.scripts.run_short_term_strategy_v1 --dry-run

PYTHONPATH=. oi_mornitor/venv/bin/python -m oi_mornitor.scripts.run_short_term_strategy_v1 \
  --symbols BTCUSDT,ETHUSDT \
  --start 2026-05-01 --end 2026-11-01 \
  --experiment E --fee 0.06 --slippage 0.03 \
  --out oi_mornitor/data/short_term_v1/my-run
```

结果写到 `oi_mornitor/data/short_term_v1/<日期时间>/`（`summary.json` + `summary.md`）。`--dry-run` 只用合成夹具证明引擎能启动，不是行情结论。

**界面**：`/oi` 回测页「5. 短线策略 V1」。选择实验 A–E、宇宙（默认不含美股代币）后启动。需后端已加载本模块（如有需要请重启 8765 上的 oi_mornitor，不要动 deal-manage / python-ai-operate）。前端改动需重新 `npm run build`。接口：

- `GET /api/backtest/short-term-v1/options`
- `POST /api/backtest/short-term-v1`
- `GET /api/backtest/short-term-v1/latest`
- `GET /api/backtest/short-term-v1/jobs`
- `GET /api/backtest/short-term-v1/{job_id}`

（亦提供 `/api/backtest/stv1/...` 别名。）

每笔接受或拒绝的候选都会序列化为统一决策对象（含档位、环境、入场/止损/分批止盈、证据、失效条件、`skipped` / `skip_reason`）。文档中的价格只是格式示例。

## 模块位置

`oi_mornitor/strategy/short_term_v1/`：`tiers`、`abort`、`setups`、`decision`、`sizing`、`exits`、`fills`、`ablation`、`engine`、`runner`。
复用：`market_regime`、严格流动性反转、趋势回调延续、`mcap_tier`、`pattern_pause`、`pattern_settle` / 诊断、`opportunity_score`（不把人工分当胜率）。
