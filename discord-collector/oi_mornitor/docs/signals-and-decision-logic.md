# 信号清单与交易 / 决策逻辑（权威版）

> **维护约定**：本文与仓库 **当前代码** 对齐；未实现的能力标为「规划中」。  
> 最后对齐提交：`agent-decision-v2`（P0：B 组分类、方向一致性、流动性五态、Shadow Veto 三态、三类研究策略登记）。

---

## 0. 命名易混（必读）

| 名称 | 含义 | 代码入口 |
|------|------|----------|
| **Vegas A/B 组** | EMA 144/169（A 蓝）与 576/676（B 红）通道 | `pattern_detector.py`、Pine 对齐 |
| **moonshot A/B/C** | 暴涨漏斗：压缩 → 蓄势 → 触发 | `moonshot_funnel.py` |
| **综合共振 tier A/B/C/D** | 历史胜率校准的**质量分档**（TG 推送门槛） | `signal_confluence.py` |
| **Agent 决策组 A/B/C** | 既有形态管线 vs PA 结构 vs **方向一致**的共振 | `agent_decision.py` |
| **研究策略 A/B/C** | 流动性反转 / 趋势回调延续 / 震荡区间（**独立登记**，非调度器） | `pa/research_strategies.py` |

四者（及研究策略）**互不替代**；`pattern_alert_stats.confluence.tier` ≠ `agentDecision.primaryGroup` ≠ `researchStrategies.matchedIds`。

---

## 1. 能力边界总表

| 能力 | 可驱动 Bitget/WEEX 实盘？ | 说明 |
|------|---------------------------|------|
| Discord/TG **信号卡片** + 白名单 | **可以**（受开关与频道约束） | `discord-signal-card-service.js` |
| OI 形态/结构/量价 **TG 卡片** | **否**（仅 TG + 胜率库 + 研究） | `notify_telegram.py`、`pattern_alert_stats` |
| **Agent 决策 PA 层** | **否**（`readOnly: true`） | 仅标注、`agentDecision`、screener API |
| **研究策略（三类）** | **否** | `researchStrategies` 只读匹配；**无**统一调度/打分/下单 |
| **shadowVeto** | **否**（`pass` / `warning` / `veto` 仅记录） | 不调用任何下单门控 |
| **综合共振分** | **否**（文档写明非自动下单） | 影响 TG 是否推送、观察档入库 |
| **pattern_settle 纸面核实** | **否**（胜率统计） | `pattern_settle.py` |

**研究口径 vs 实盘口径**：

- `evidenceSufficient` 默认仍为 `false`；期望值与策略匹配用于**研究统计**，不驱动实盘。
- 纸面 TP/SL（`pattern_settle`）≠ 真实成交：手续费、滑点、资金费率、延迟均未在 Agent 层建模。
- PA / Agent **不**修改 `shouldPushToTradePlatform`、Bitget/WEEX、TG 自动下单白名单。

**实盘唯一入口（Node）**：解析成功的 `discord_signal_cards` → `shouldPushToTradePlatform` → Bitget/WEEX order service。

---

## 2. 四层决策模型（Agent 研究方向）

| 层 | 含义 | 本次（P0） | 规划 |
|----|------|-----------|------|
| **1 Discovery** | A + B 发现候选、方向、触发 | ✅ A/B 标注、B 分类、流动性五态 | — |
| **2 Context** | 多周期趋势、BTC、震荡/趋势、OI/费率 | 未实现完整识别 | **P1** 多周期环境 |
| **3 Setup** | 方向一致、扫荡+收回、结构确认、进场区 | 部分：方向一致性 + 策略步骤匹配 | **P1** 与回测对齐 |
| **4 Risk & Decision** | RR、费用、硬否决、样本量 | Shadow Veto 三态（只记录） | **P2** Agent 辩论、规则优化 |

核心改变：**不再**把「A、B 同时 active」等同于高质量机会；C 组共振要求 **A/B 方向一致**（位置标签不作 B 组方向确认）。

---

## 3. Agent 决策组 A / B / C（`agent_decision.py`）

默认 **关闭**：`OI_AGENT_DECISION_ENABLED=0`。`agentDecision.readOnly` 恒为 `true`。

### 3.1 A 组

既有形态 / 量价 / Vegas / TD 等（`classify_group_a`）。新增字段：

- `direction`：`long` / `short` / `neutral`（优先 `side`，其次形态启发式）

### 3.2 B 组：标签分类与激活

标签写入 `groups.B.tags`，并按 **`tagCategories`** 分为：

| 类别 | 示例 | 可作 B 方向？ | 单独能否激活 B？ |
|------|------|-------------|------------------|
| **position** | `vwap_*`、`near_ob:*`、`in_fvg:*` | **否** | **否**（仅位置不满足 `active`） |
| **structure** | `structure_up/down`、`event:bos_*`、`event:choch_*` | **是** | 可以 |
| **liquidity** | `liq_state:*`、`liq_sweep:*`、`liq_sweep_reclaim` | 仅 `reversal_confirmed` 等结构后续态 | sweep/reclaim 等可 |

**B 组 `active`**：须存在 structure 或 liquidity 核心态（**不是**仅靠调高 `OI_AGENT_DECISION_MIN_B_TAGS`）。  
**`direction`**：仅由 structure（及流动性反转确认）推断；VWAP/OB/FVG **不参与** B 方向。

**流动性五态**（`groups.B.liquidityStates` + `liq_state:{kind}:{phaseName}`）：

1. `zone_exists` — 同级流动性区域存在  
2. `touched` — 价格触及  
3. `swept` — 刺破边界（`mitigated` / `swept_at`）  
4. `reclaimed` — 收盘收回内侧  
5. `reversal_confirmed` — 随后出现同向 CHoCH/BOS  

`mitigated` ≠ 成功反转；各态在决策与策略匹配中区分对待。

### 3.3 C 组：方向一致性

| 字段 | 含义 |
|------|------|
| `classification` | `Bullish Confluence` / `Bearish Confluence` / `Conflict` / `Partial` / `None` |
| `active` / `resonance` | 仅 **方向一致** 且 A、B 均 active 时为真 |
| `legacyIntersection` | 旧语义 `A.active && B.active`（兼容对照） |
| `directionAgreement` / `directionConflict` / `neutralContext` | 布尔标记 |
| `confidenceLevel` | `high` / `medium` / `low` |

**冲突示例**：A 看空（射击之星）+ B `structure_up` → `Conflict`，**不会**标 C 共振。

`primaryGroup`：`C` > `B` > `A`（C 须新语义共振成立）。

### 3.4 Shadow Veto（仍只记录）

| `status` | 含义 |
|----------|------|
| `pass` | 无明显冲突 |
| `warning` | 风险项（如资金流与方向摩擦、趋势与近期反向事件并存） |
| `veto` | 硬 Shadow 条件（如下跌趋势做多且无阻弹结构事件） |

附 `reasons`、`hardReasons`、`warnings`。`plannedRules` 含多周期 1h/4h 否决（**未接线**，不伪造 MTF 数据）。**不**拦截 TG / 下单。

### 3.5 决策根字段（摘要）

`version`: `agent-decision-v2`；`confluenceClassification`；`directionAgreement`；`researchStrategies`；`expectancyKey`；`evidenceSufficient`（默认 false）。

---

## 4. 三类研究策略（已登记，只读）

实现：`pa/research_strategies.py` → `agentDecision.researchStrategies`。

| ID | 名称 | 意图步骤（当前 TF 可匹配部分） |
|----|------|------------------------------|
| `liquidity_reversal` | 流动性反转 | 区域 → sweep → reclaim → CHoCH/BOS → OB/FVG 区 |
| `trend_pullback_continuation` | 趋势回调延续 | LTF 趋势与 side 一致 → 回踩 OB/FVG/VWAP → BOS 或量价推进 |
| `range_mean_reversion` | 震荡区间 | 区间代理（transition/窄幅 swing）→ 边界/session → sweep/reclaim + VWAP/量价 |

每条 `matches[]` 含：`matched`、`confidence`（`full` / `partial` / `insufficient`）、`matchedSteps`、`missingContext`（如 `htf_4h_structure`、`full_range_box`）。

- **`matchedIds`**：本信号命中的策略 id 列表（可多个）。  
- **`backtestStatus`**: `planned_p1` — **无**历史回测结果写入本文或代码。  
- **`scheduler`**: `none` — **不**合并为统一 live 打分或 Bitget/WEEX 路径。

### 4.1 条件实验室（研究设计，非已有结果）

长下影线等分桶见 **§10.4 步骤 D**；产出为自行导出的 CSV/JSON，**不是**仓库内置回测结论。

> **可执行全流程**：下文 **[§10 研究回测操作手册（Playbook）](#10-研究回测操作手册-playbook)**。

---

## 5. 优先级路线图

| 优先级 | 内容 |
|--------|------|
| **P0（已做）** | B 标签分类与激活规则；A/B 方向一致性；流动性五态；Shadow Veto 三态；三类策略 schema + 当前数据匹配 |
| **P1（规划）** | 多周期 Context；三类策略**自动化回测引擎**（Playbook 可先手工跑）；条件期望与样本量；可能 promoted 至调度器（需人工决策） |
| **P2（规划）** | Agent 多空辩论；动态选工具；决策反馈与规则自优化 |

---

## 6. OI Monitor 信号来源（既有形态管线）

§2–§4 为 Agent 层；下列为 OI 扫描产出的 **A 组主来源**（未改语义，摘要保留）。

- 蜡烛卡片：`strategy/candle_signals.py`  
- 结构卡片：`strategy/structure_signals.py`  
- 量价：`volume_price/signals.py`  
- 综合共振（tier）：`signal_confluence.py`（**非** Agent C 组）

PA 原语模块表见 `pa/analysis.py`、`pa/liquidity.py`、`pa/swings.py` 等；只读 Screener：`POST /api/agent-decision/screen`。

---

## 7. 纸面核实与 Discord 实盘（未改）

- 胜率库：`pattern_alert_stats` / `pattern_settle.py`  
- 实盘：`shouldPushToTradePlatform` → Bitget/WEEX（**本 PR 未触碰**）  
- OI TG 卡片 **不** 调用 Node 下单  

---

## 8. 环境开关

| 变量 | 默认 | 作用 |
|------|------|------|
| `OI_AGENT_DECISION_ENABLED` | `0` | PA + A/B/C + 研究策略标注 |
| `OI_AGENT_DECISION_MIN_B_TAGS` | `1` | 仍生效于非纯位置场景计数；**不能**用调大该值替代分类 |
| `OI_AGENT_DECISION_PERSIST_PA` | `0` | PA JSONL |

---

## 9. 代码索引

| 主题 | 路径 |
|------|------|
| Agent A/B/C + Veto + 策略汇总 | `agent_decision.py` |
| B 标签 / 流动性五态 | `pa/b_tags.py` |
| 三类研究策略 | `pa/research_strategies.py` |
| PA 原语 | `pa/*` |
| 单元测试 | `tests/test_agent_decision_pa.py` |
| 研究导出（JSONL） | `scripts/research_export_agent_decisions.py` |
| 期望聚合 | `scripts/backfill_agent_decision_expectancy.py` |
| PA API 摘要 | `docs/agent-decision-pa.md` |
| 文档索引 | `docs/index.md` |
| **研究回测 Playbook** | 本文 **§10** |

更细的拐点 / Vegas 图表说明见 [signal-logic.md](./signal-logic.md)。纸面 vs Live 差异见 [backtest-vs-live.md](./backtest-vs-live.md)。

---

## 10. 研究回测操作手册（Playbook）

> **定位**：仅研究 / 纸面统计；**不**接入 Bitget/WEEX、`shouldPushToTradePlatform`、统一调度器。  
> **状态**：按当前仓库可跑的命令编写；**完整自动化策略回测引擎仍为 P1**。本文**不包含**任何预填胜率或期望值数字。

### 10.1 前提与路径

| 项 | 说明 |
|----|------|
| 仓库根 | `discord-collector/oi_mornitor/`（下文命令默认在此目录） |
| Python 路径 | `cd discord-collector/oi_mornitor && PYTHONPATH=..` |
| 胜率库 | `data/pattern_alert_stats.json`（`pattern_alert_stats.list_alert_stats()`） |
| 纸面结算 | `pattern_settle.py` + `pattern_settle_profile.py`；服务端批量：`POST /api/pattern-alert-stats/recalculate-v2` |
| Agent 标注 | `agentDecision` 字段；仅当扫描时 `OI_AGENT_DECISION_ENABLED=1` 且带 `pa_klines` 时写入新记录 |
| PA 快照（可选） | `data/pa_analysis/{SYMBOL}_{interval}.jsonl`（`OI_AGENT_DECISION_PERSIST_PA=1`） |
| 期望表（研究） | `data/agent_decision_expectancy.json`（`scripts/backfill_agent_decision_expectancy.py`） |
| 单元测试 | `tests/test_agent_decision_pa.py` |

**环境（研究采集，不改实盘默认）**

```bash
# discord-collector/.env — 仅在你自己的研究环境开启，勿当作生产默认
# OI_AGENT_DECISION_ENABLED=1      # 默认仍为 0；开启后新入库 alert 才带 agentDecision
# OI_AGENT_DECISION_PERSIST_PA=0   # 可选 1 → JSONL
# OI_AGENT_DECISION_EXPECTANCY_MIN_N=5   # evidenceSufficient 阈值（表内字段）
```

`agentDecision.readOnly` 恒 `true`；`evidenceSufficient` 在单条 alert 上**默认 false**，仅聚合表达到 `OI_AGENT_DECISION_EXPECTANCY_MIN_N` 时分桶标记 `evidenceSufficient: true`。

### 10.2 第 0 步：确认 PA / 决策层可用

```bash
cd discord-collector/oi_mornitor
PYTHONPATH=.. python3 -m unittest tests.test_agent_decision_pa -v
```

预期：`OK`（10 tests）。

### 10.3 第 1 步：纸面结算与胜率库字段

1. **启动 OI 服务**（若需拉 K 线 / 重算）：在 `discord-collector/` 按 [development.md](../../docs/development.md) 运行 `pnpm run oi:start` 或等价方式。
2. **批量重算 V2 结算**（纸面 TP/SL，非交易所成交）：

```bash
curl -sS -X POST 'http://127.0.0.1:8765/api/pattern-alert-stats/recalculate-v2?limit=5000' | head -c 2000
```

3. **读懂纸面 vs 实盘**（必读 [backtest-vs-live.md](./backtest-vs-live.md)）：
   - 胜率库 `movePct` / `pnlPct`：标的价格变动或规则内纸面盈亏；**不含**完整滑点/资金费率/成交延迟（结构回测可用 `OI_BT_*`，见该文档）。
   - Live 下单路径与 OI stats **独立**；Agent / 策略标签**不会**改变 Bitget/WEEX。

研究用单条记录关键字段：

| 字段 | 用途 |
|------|------|
| `signalAt` | 时间序切分 train/val/test |
| `outcome` | `take_profit` / `stop_loss` / `pending`（纸面） |
| `movePct`, `pnlPct`, `maxProfitPct` | 盈亏与 **MFE** 近似（核实窗内最大浮盈%） |
| `slPrice`, `tp1Price`, entry | 纸面风险定义；算 R 倍数 |
| `agentDecision` | A/B/C、方向、`researchStrategies.matchedIds`、`expectancyKey` |
| `confluence` | 综合共振 tier（**≠** Agent C 组） |

**MAE**：当前 stats 无独立 `maxAdversePct` 字段；Playbook 阶段用「结算 `movePct` 为负时的幅度」或 P1 引擎从 K 线重放。MFE 优先用 `maxProfitPct`。

### 10.4 第 2 步：为历史记录补算 `agentDecision`（手工回测入口）

> **P1** 将提供批量 job；**现在**用下面脚本对胜率库**只读补标注**（不写回 json，除非你自行加 `--write`）。

仓库脚本：`scripts/research_export_agent_decisions.py`（只读导出，不改胜率库）。

运行示例（**需 OI :8765 可访问币安或代理**）：

```bash
cd discord-collector/oi_mornitor
mkdir -p data/research
PYTHONPATH=.. python3 scripts/research_export_agent_decisions.py \
  --start-ms 1700000000000 --end-ms 1730000000000 \
  > data/research/agent_decisions_2024.jsonl
```

向前采集（免补算）：在研究 `.env` 设 `OI_AGENT_DECISION_ENABLED=1`，重启 OI；新 TG 入库行将自带 `agentDecision`（`pattern_emit_gate.attach_confluence_on_alert`）。

### 10.5 实验矩阵（必须分开统计，禁止混成一项总分）

#### A. 三类研究策略（互不合成）

对每条导出记录，按 `agentDecision.researchStrategies.matchedIds` **分别**建 cohort（一条可进多策略）：

| `matchedIds` | 策略 |
|--------------|------|
| `liquidity_reversal` | 流动性反转 |
| `trend_pullback_continuation` | 趋势回调延续 |
| `range_mean_reversion` | 震荡区间 |

**禁止**：把三策略胜率加权合成「总策略分」或写入调度器（`scheduler: none` 不变）。

#### B. Agent 层增量：A-only / B-only / A+B 方向一致

在同一 `signalAt` 窗口内，用 SQL 式过滤（Python 示例如下）：

| Cohort | 过滤条件 |
|--------|----------|
| **A-only** | `primaryGroup == "A"` 或 `groups.A.active && !groups.B.active` |
| **B-only** | `primaryGroup == "B"` 或 `groups.B.active && !groups.A.active` |
| **A+B 共振** | `groups.C.active` 且 `directionAgreement == true` 且 `classification` 为 Bullish/Bearish Confluence |
| **对照：旧交集** | `groups.C.legacyIntersection`（方向冲突时可能为 true 但新 C 不为 active） |

#### C. 条件实验室示例：长下影线 A–E（研究设计）

在 A 组形态上叠加 B/PA 条件（**结果须你自己跑，本文无数值**）：

| 组 | 条件（示意） |
|----|----------------|
| **A** | 仅 `kind` 含 hammer / 倒锤 / 长下影形态（`groups.A.tags`） |
| **B** | A + 放量（`volume_price` 或量能 feat） |
| **C** | A + `liq_state:*:swept` 且 `reclaimed` |
| **D** | A + `event:choch_*` 或 B 方向结构事件 |
| **E** | D + `vwap_*` 或 VWAP reclaim |

实现：在 §10.4 的 JSONL 上按 `tags` / `liquidityStates` 过滤即可。

### 10.6 指标计算（纸面口径）

对每个 cohort 单独调用 `pattern_alert_stats.summarize` 逻辑（或 `backtest_metrics.summarize_backtest_extended` 若你已转为 backtest item 形状）：

| 指标 | 来源 |
|------|------|
| 样本量 `n` | settled = `take_profit` + `stop_loss` |
| 胜率 | `wins / settled` |
| 平均盈亏 | `avgPnlPct`（`summarize`） |
| 扣费后期望 | 结构回测项用 `netMovePct`/`pnlPct`（`OI_BT_FEE_PCT`）；stats 库默认**未扣费**，手工减 `2 × fee%` 或读 [backtest-vs-live.md](./backtest-vs-live.md) |
| 最大回撤 | `backtest_metrics` 对已排序 `signalAt` 序列算 `maxDrawdownPct` |
| MFE | `maxProfitPct` |
| MAE | P1 或自算 K 线极端 |
| 分环境 | 按 `interval`、`mcapTier`、`confluence.tier`、`agentDecision.shadowVeto.status` 分组 |

**证据不足**：若 `n < OI_AGENT_DECISION_EXPECTANCY_MIN_N`（默认 5），该 cohort **必须**标注 `evidenceInsufficient: true`，**不得**写入「可推广」结论。

聚合 `expectancyKey`（已有脚本，注意 outcome 兼容）：

```bash
cd discord-collector/oi_mornitor
PYTHONPATH=.. python3 scripts/backfill_agent_decision_expectancy.py --dry-run | head
PYTHONPATH=.. python3 scripts/backfill_agent_decision_expectancy.py
# → data/agent_decision_expectancy.json
```

> **注意**：`aggregate_expectancy_from_stats` 当前过滤 `outcome in (win, loss)`；胜率库主路径为 `take_profit`/`stop_loss`。若 dry-run 行数为 0，请用 §10.7 片段按 `take_profit`/`stop_loss` 分桶，或先将 outcome 映射后再跑脚本（**不要**伪造样本）。

### 10.7 第 3 步：时间序切分与滚动样本外（强制）

```python
# 在 research JSONL 或 list_alert_stats() 结果上执行（示意）
import json
from pathlib import Path

rows = [json.loads(l) for l in Path("data/research/agent_decisions_2024.jsonl").open() if l.strip() and not l.startswith("#")]
rows.sort(key=lambda r: int(r["signalAt"]))
n = len(rows)
train, val, test = rows[: int(n*0.6)], rows[int(n*0.6): int(n*0.8)], rows[int(n*0.8):]

def metrics(chunk, pred):
    settled = [r for r in chunk if str(r.get("outcome")) in ("take_profit","stop_loss") and pred(r)]
    # ... 调用 summarize 或自算 win rate / avg pnl ...
    return {"n": len(settled)}

# 规则：仅在 train+val 上调参；test 只评估一次。
# 禁止：在 test 上改阈值后再用同一 test 报告“验证通过”。
```

**滚动样本外**：按月滑动窗口，每次用过去 60d 作 train、接下来 14d 作 test，记录各 cohort 的 test 胜率序列（P1 引擎自动化；现用手工循环）。

### 10.8 第 4 步：产出归档（字段约定）

建议写入 `data/research/runs/{YYYYMMDD}_{cohort}.json`：

```json
{
  "playbookVersion": "2026-03-26",
  "cohort": "strategy:liquidity_reversal",
  "timeSplit": "test",
  "n": 0,
  "evidenceInsufficient": true,
  "metrics": {},
  "filters": { "matchedIds": ["liquidity_reversal"] },
  "notes": "paper settle only; agentDecision.expectancyKey optional"
}
```

| 键 | 含义 |
|----|------|
| `cohort` | 策略 id 或 `agent:AB_confluence` 或 `lab:wick_E` |
| `agentDecision.expectancyKey` | 细粒度分桶（mcap×group×tags） |
| `researchStrategies.matchedIds` | 三策略并行登记 |
| `evidenceInsufficient` | `n < EXPECTANCY_MIN_N` |

### 10.9 何时可「晋升」到调度器（仅决策标准，**不实现**）

须**全部**满足（人工门禁）：

1. 三类策略**各自**在滚动 test 上 `evidenceSufficient` 且口径一致（纸面或明确标注 live 仿真）。
2. A+B 方向一致 cohort 相对 A-only 的增量期望为**正**且样本量达标（条件实验室同理）。
3. Shadow `veto` 比例与盈亏尾部已统计（仍可不拦截 live，但知情）。
4. 产品明确选择**单一**策略或显式多策略路由（非本仓库自动合并）。
5. **不改** `shouldPushToTradePlatform` 直至 Node 侧单独 PR。

### 10.10 P1 与本文关系

| 能力 | Playbook（今） | P1 引擎 |
|------|----------------|---------|
| 三策略独立 cohort | JSONL + 过滤 | 一键 job |
| A/B/AB 增量 | 手动 summarize | 报告模板 |
| 条件实验室 A–E | 标签过滤 | 配置化 YAML |
| train/val/test | 脚本片段 | 内置 + 防泄漏 |
| MAE / 资金费率 | 部分缺失 | 补齐 |

**禁止**：在 P1 完成前将 Playbook 产出数字写入产品文案或调度器默认值。
