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

### 4.1 条件实验室（规划）

长下影线等分桶 A/B/C/D/E、仅 A、仅 B、A+B 增量评估：**研究方案**，P1 实现回测引擎后再落数。禁止在同一测试集反复调参后宣称有效（文档约束，非本 PR 代码）。

---

## 5. 优先级路线图

| 优先级 | 内容 |
|--------|------|
| **P0（已做）** | B 标签分类与激活规则；A/B 方向一致性；流动性五态；Shadow Veto 三态；三类策略 schema + 当前数据匹配 |
| **P1（规划）** | 多周期 Context；三类策略**独立回测**；条件期望与样本量；可能 promoted 至调度器（需人工决策） |
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
| PA API 摘要 | `docs/agent-decision-pa.md` |

更细的拐点 / Vegas 图表说明见 [signal-logic.md](./signal-logic.md)。
