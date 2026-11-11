# 信号清单与交易 / 决策逻辑（权威版）

> **维护约定**：本文与仓库 **当前代码** 对齐；未实现的能力标为「规划中」。  
> 最后对齐分支：`cursor/agent-decision-pa-layer-63b2`（Agent 决策 PA 只读层）。

---

## 0. 命名易混（必读）

| 名称 | 含义 | 代码入口 |
|------|------|----------|
| **Vegas A/B 组** | EMA 144/169（A 蓝）与 576/676（B 红）通道 | `pattern_detector.py`、Pine 对齐 |
| **moonshot A/B/C** | 暴涨漏斗：压缩 → 蓄势 → 触发 | `moonshot_funnel.py` |
| **综合共振 tier A/B/C/D** | 历史胜率校准的**质量分档**（TG 推送门槛） | `signal_confluence.py` |
| **Agent 决策组 A/B/C** | **本 PR**：既有形态管线 vs PA 结构 vs 二者共振 | `agent_decision.py` |

四者**互不替代**；`pattern_alert_stats.confluence.tier` ≠ `agentDecision.primaryGroup`。

---

## 1. 能力边界总表

| 能力 | 可驱动 Bitget/WEEX 实盘？ | 说明 |
|------|---------------------------|------|
| Discord/TG **信号卡片** + 白名单 | **可以**（受开关与频道约束） | `discord-signal-card-service.js` |
| OI 形态/结构/量价 **TG 卡片** | **否**（仅 TG + 胜率库 + 研究） | `notify_telegram.py`、`pattern_alert_stats` |
| **Agent 决策 PA 层** | **否**（`readOnly: true`） | 仅标注、`agentDecision`、screener API |
| **shadowVeto** | **否**（只记录） | 不调用任何下单门控 |
| **综合共振分** | **否**（文档写明非自动下单） | 影响 TG 是否推送、观察档入库 |
| **pattern_settle 纸面核实** | **否**（胜率统计） | `pattern_settle.py` |
| **卡片评估 / 回测** | **否** | `card-eval-*`、`card-backtest-*` |

**实盘唯一入口（Node）**：解析成功的 `discord_signal_cards` → `shouldPushToTradePlatform` → Bitget/WEEX order service。OI Python 侧**无**交易所下单代码。

---

## 2. OI Monitor 信号（按来源）

### 2.1 雷达 / 资金 context（非形态卡片）

| ID | 名称 | 检测内容 | 触发（摘要） | 周期 | 主要输入 | 输出字段 | 实盘 |
|----|------|----------|--------------|------|----------|----------|------|
| `hot_ticker` | OI 热钱异动 | OI USD / % 异动 | `OI_USD_LIMIT` / `OI_PCT_LIMIT` 等 | 5m/15m 扫描 | `fapi` ticker、OI | `hot_tickers[]` SSE | 研究 / Toast |
| `price_spike` | 价格尖刺 | 短周期涨跌幅 | `PRICE_SPIKE_PCT_*` | 5m/15m | K 线 | 雷达左栏 | 研究 |
| `matrix_breakout` | 矩阵突破回踩 | TopN 带量突破 + 回踩扳机 | `matrix_breakout.py` | 15m 等 | K 线量 | `breakout_alerts` | 研究 / Toast |
| `derivatives_context` | 费率 / OI 体制 | 资金费率、OI 价格关系 | 拉取 `premiumIndex` 等 | 随扫描 | 衍生品 REST | 注入 `capitalFlow` 等 | 仅特征 / 共振 |

### 2.2 蜡烛形态卡片（A 组主来源）

| kind / type_label | 名称 | 检测 | 周期 | 主要输入 | alert 字段 | TG/胜率 | 实盘 |
|-------------------|------|------|------|----------|------------|---------|------|
| `shooting_star` | 射击之星 | BB 下轨 + 上影/实体比 + Vegas 邻近等 | 15m–4h（池配置） | OHLCV、BB、Vegas | `candle_pattern_card` | ✅ 可推 TG | 否 |
| `inverted_hammer` | 倒锤子 | 中轨下 + 下影 Dominance | 同上 | 同上 | 同上 | ✅ | 否 |
| `consecutive_flat_shooting_star` | 连续走平射击之星 | 连续上影形态 | 主流币周期池 | 同上 | `type_label` | ✅ | 否 |
| `oi_anomaly` | 柱级 OI 异动倒锤 | 蜡烛 + OI 柱异动 | 扫描周期 | OHLCV + OI | `oi_anomaly: true` | ✅（旧 combo 文案可关） | 否 |

**代码**：`strategy/candle_signals.py` → `pattern_monitor._emit_candle`  
**门控**：`pattern_emit_gate`、`OI_PATTERN_PUSH_MTF_MIN`、`signal_policy`

### 2.3 结构形态卡片（A 组）

| kind | type_label | 检测（摘要） | 周期 | 输出 | TG | 实盘 |
|------|------------|--------------|------|------|-----|------|
| `hs_vegas_break` | 顶部结构确认 | 头肩 + Vegas 破位 | 1h/4h 等 | `structure_pattern_card` | ✅ `OI_STRUCTURE_CARD_TELEGRAM` | 否 |
| `m_top_vegas_break` | 顶部结构确认 | M 顶 + Vegas | 同上 | 同上 | ✅ | 否 |
| `bottom_secondary_test` | 底部二次探底确认 | 二次探底 | 同上 | 同上 | ✅ | 否 |
| `spring_2b` | 破底翻确认 | 2B / Spring | 同上 | 同上 | **停推**（门控屏蔽） | 否 |
| `liquidity_sweep` | 顶部结构确认（legacy 结构 sweep） | 流动性掠夺形态 | 同上 | 同上 | ✅（部分 policy 可挡） | 否 |
| `curvature_decay` | 顶部结构确认 | 圆弧动量衰减 | 同上 | 同上 | ✅ | 否 |

**代码**：`strategy/structure_signals.py` → `pattern_monitor._emit_structure`  
**说明**：此为 **legacy 图表结构 sweep**，与 **B 组 PA `liq_sweep:*`** 公式不同（见 §4）。

### 2.4 量价信号（A 组）

| vp_type | type_label | kind 内核 | 周期 | formal / 观察 | 输出 | TG |
|---------|------------|-----------|------|---------------|------|-----|
| `vp_cont_thrust` | 量价推进·多/空 | continuation + thrust | 15m（桥接 1h/4h） | `vp_formal` | `volume_price_card` | MAIN 可选 |
| `vp_cont_confirm` | 量价确认·多/空 | continuation + confirm | 同上 | 同上 | 同上 | 同上 |
| `vp_rev_climax` | 高潮反转·多/空 | reversal + climax | 同上 | 观察档可标「（观察）」 | `observation_only` | 受限 |
| `vp_rev_effort` | 努力无果反转·多/空 | reversal + effort_no_result | 同上 | 同上 | 同上 | 受限 |

**代码**：`volume_price/signals.py`、`ticker_bridge.py`（`MIN_SCORE=0.75`）  
**失效价**：`invalid_level` → 胜率库 / 结算 V2

### 2.5 其它 OI 形态管线

| ID | 名称 | 说明 | 周期 | 产出 | 实盘 |
|----|------|------|------|------|------|
| `rev_vol_card` | 末端放量 | `REV_VOL_CARD_TELEGRAM` | 15m+ | TG + stats | 否 |
| `ma144_reversal` | 144 均线附近反转 | `OI_MA144_MAIN_ENABLED` | 1h/4h 等 | 仅 MAIN 群 | 否 |
| `equity_pattern` | 币股形态 | `OI_EQUITY_*` | 1h/4h | stats `assetClass=equity` | 否 |
| `pattern_lh_trigger` | LH→HL 扳机（旧） | 主扫描**已不跑**状态机 | — | 图表线保留 | 否（legacy） |
| `moonshot_compress/coil/trigger` | 暴涨漏斗 | A 压缩 B 蓄势 C 触发 | 15m | SSE `pattern.moonshot` | 否 |
| `td_setup` | TD Sequential |  attach 到 alert | 随卡片 | `tdSetup`, `tdLabel` | 否（特征） |
| `ai_judge` | AI 多周期判决 | 外连 adapter HTTP | 15m–1d | `ai_judge_btc_signals.json` | 否 |

### 2.6 综合共振（质量分，非 Agent 决策组）

| 输出 | 含义 | 驱动行为 |
|------|------|----------|
| `confluence.score` 0–100 | 加性特征 + 百分位 | 列表展示 |
| `confluence.tier` A/B/C/D | 分档 | `OI_CONFLUENCE_PUSH_MIN_TIER` 控制 **TG 推送**；不足可 `confluence_observation_only` 入库 |
| `confluence.combos` | 组合特征名 | 与 `confluence_features.py` 一致 |

**明确**：`signal_confluence.py` 文件头 — **非自动下单**。

---

## 3. B 组：PA 价格行为信号（本 PR，`oi_mornitor/pa/`）

> 默认 **关闭**（`OI_AGENT_DECISION_ENABLED=0`）。仅当开启且在 alert 上带有 `pa_klines`（扫描 stash）或 API 传入 K 线时计算。

### 3.1 原始 PA 结构（算法版本见 `pa/params.py`）

| 模块 | ID / 事件 | 检测定义 | 输入 | 存储 |
|------|-----------|----------|------|------|
| swings | `HH/LH/HL/LL` | 分形 swing，`SWING_LOOKBACK=2` | 已收盘 OHLC | `structure.swings` |
| structure | `bos_bullish` / `bos_bearish` | 收盘突破前 swing 高/低（顺势） | closes + swings | `structure.events` |
| structure | `choch_bullish` / `choch_bearish` | 逆势突破 → 趋势转换 | 同上 | 同上 |
| structure | `trend` | `up` / `down` / `transition` | 事件序列 | `structure.trend` |
| liquidity | `equal_highs` / `equal_lows` | 同级 swing 聚类 `EQUAL_LEVEL_TOLERANCE_PCT` | swings | `liquidity.zones` |
| liquidity | sweep | 价穿 zone 带 `SWEEP_EXCEED_PCT` | highs/lows | `mitigated`, `swept_at` |
| liquidity | reclaim | sweep 后收盘回到 zone 外 | closes | `reclaimed` |
| obfvg | `order_block` | BOS/CHoCH 前最后一根反向 K 线区间 | events + OHLC | `obfvg.order_blocks` |
| obfvg | `fvg` | 三根 K 线跳空，`FVG_MIN_GAP_PCT` | OHLC | `obfvg.fvgs` |
| vwap | session VWAP | **UTC 自然日**重置，typical price×volume | OHLCV | `vwap.current`, `position` |
| vwap | reclaim | 前一根与当根跨越 VWAP | 同上 | `vwap.reclaim` |
| sessions | killzone | UTC `asian/london/newyork` 高低 | 时间戳 | `sessions.sessions` |

**不可变快照（可选）**：`OI_AGENT_DECISION_PERSIST_PA=1` → `data/pa_analysis/{SYMBOL}_{tf}.jsonl`（`effective_from` + `algo_version`）。

### 3.2 B 组 **决策标签**（`classify_group_b` 写入 `groups.B.tags`）

| 标签前缀 | 条件（摘要） |
|----------|----------------|
| `structure_up` / `structure_down` | PA trend 与方向一致 |
| `event:bos_*` / `event:choch_*` | 近 `since_bars=12` 内结构事件与方向一致 |
| `liq_sweep:equal_highs/lows` | zone 已 mitigated |
| `liq_sweep_reclaim` | zone `reclaimed=true` |
| `near_ob:bullish/bearish` | 现价距未 mitigated OB  ≤ `OI_AGENT_DECISION_NEAR_OB_PCT`% |
| `in_fvg:bullish/bearish` | 收盘在活跃 FVG 带内 |
| `vwap_above/below/at` | 相对 session VWAP |
| `vwap_reclaim_above/below` | VWAP 回收 |

**B 组 active**：`len(tags) >= OI_AGENT_DECISION_MIN_B_TAGS`（默认 1）。

### 3.3 只读 Screener（研究）

`POST /api/agent-decision/screen` — 过滤器 AST：`volume_change`, `price_change`, `structure_event`, `liquidity_sweep_occurred`, `near_order_block`, `funding_rate`, `oi_change`, `above_below_vwap`（`pa/screener.py`）。**不下单**。

---

## 4. C 组：Agent 决策共振（A ∩ B）

| 字段 | 规则 |
|------|------|
| `groups.C.active` | `groups.A.active && groups.B.active` |
| `primaryGroup` | `C` > `B` > `A`（优先级） |
| `agentDecision.readOnly` | 恒为 `true` |

**附加位置**：`pattern_emit_gate.attach_confluence_on_alert`（需 `OI_AGENT_DECISION_ENABLED=1`）。  
**持久化**：`pattern_alert_stats` 记录 `agentDecision`（不含 `pa_klines`）。

**A 组 active 规则（摘要）**：形态/结构/量价卡片类型、或 `extract_confluence_features` 产出的 `type:` / `kind:` / `feat:` / `combo:` 标签。

---

## 5. 期望矩阵、shadow veto、证据不足

| 机制 | 现状 | 实盘影响 |
|------|------|----------|
| `expectancyKey` | `mcap|primaryGroup|side|interval|B:tags|A:tags` | 无 |
| `evidenceSufficient` | 默认 `false`；表由脚本聚合 | 无 |
| `backfill_agent_decision_expectancy.py` | 读 stats 已结算行 → `data/agent_decision_expectancy.json` | 研究 |
| `EXPECTANCY_MIN_N`（env） | 样本 ≥ N 才认为「证据充分」（表内字段） | 无 |
| **shadowVeto** | 结构 trend 与方向冲突；`capitalFlow` 派发 vs 多单 | **仅记录**，不阻断 TG/下单 |
| **硬否决自动 blocking** | **未实现**（规划中） | — |
| 条件期望表（市值×超卖×结构×OI） | **部分**：confluence 校准 + agent expectancy hook；**全量 backfill** 非本 PR 范围 | 研究 |

---

## 6. 纸面核实 / 失效与 TP·SL（OI stats）

适用：`pattern_alert_stats` 中 `source=telegram_push` 等形态记录（**非**交易所持仓）。

| 阶段 | 逻辑 | 代码 |
|------|------|------|
| 登记 | TG 推送后 `record_alert_from_push` | `pattern_alert_stats.py` |
| 核实窗 | 15m 默认 6h 等 | `pattern_settle_profile.resolve_verify_delay_ms` |
| SL/TP 规划 | 结构 / VP / 默认 preset + ATR cap | `pattern_settle_profile.py` |
| 结算 | 5m 步进触价 | `pattern_settle.py` |
| 结果 | `outcome` win/loss/pending | 供胜率与期望脚本 |

**invalid_level**：结构/量价 alert 可带；结算 V2 可参与 SL。

---

## 7. Discord 信号卡片与实盘下单（Bitget / WEEX）

### 7.1 卡片来源

| 来源 | 解析 | 存储 |
|------|------|------|
| Discord Gateway / CDP / 开放 API | `discord-signal-parsers.js` | `discord_signal_cards` |
| Telegram `#prom` 等 | 合并窗 10min | 同上 |
| 外送 OI | `card-external-sink` | OI `cards/engine`（**不接下单**） |

卡片**不携带** `agentDecision`（除非未来显式桥接；**当前未实现**）。

### 7.2 何时可实盘下单

同时满足（摘要）：

1. `shouldPushToTradePlatform(platform, channelId)` 为真  
   - `isAutoTradeChannel`：Discord `BITGET_AUTO_TRADE_CHANNEL_IDS` / WEEX 列表，或 Telegram `channel_profiles.json` 的 **`placeAnOrder`**（非 `send`）  
   - Debug `tradePlatformToggles` 中对应平台为开  
2. **非**主流币自动交易排除：`isAutoTradeExcludedMajorSymbol`（BTC/ETH 等不下）  
3. `discord-signal-card-service` 建卡 / TPSL 更新路径触发 `bitgetOrder` / `weexOrder`  
4. 分频道 **staged-trade** 解析（如 pangmao、altcoin_king）走 `discord-signal-staged-trade.js`  

**TPSL / tick**：`bitget-tpsl-guard.js`、`bitget-order-from-signal.js`；WEEX 镜像模块。

### 7.3 与 OI / Agent 决策关系

| 管线 | 关联 |
|------|------|
| OI TG 形态 | **不调用** Node 下单 |
| Agent PA | **不调用** Node 下单；**不修改** `trade-platform-toggles` |
| 综合共振 | 仅影响 OI TG 推送，不打开 Bitget |

---

## 8. 环境开关速查

| 变量 | 默认 | 作用 |
|------|------|------|
| `OI_AGENT_DECISION_ENABLED` | `0` | PA + A/B/C 标注 |
| `OI_AGENT_DECISION_PERSIST_PA` | `0` | PA JSONL |
| `OI_CONFLUENCE_PUSH_MIN_TIER` | 见 config | TG 共振门槛 |
| `BITGET_AUTO_TRADE_CHANNEL_IDS` | 部署配置 | Discord 自动交易白名单 |
| Telegram `placeAnOrder` | profiles 文件 | TG 群自动交易白名单 |

---

## 9. 规划中（代码中尚无或未接线）

- Agent 决策 **硬否决** 拦截 TG / 下单（当前仅 shadow 记录）  
- `agentDecision` 自动回填 `evidenceSufficient` 于每条 stats（当前仅聚合脚本）  
- PA screener **无人值守** 告警推送到 TG（当前仅 HTTP API）  
- 全历史条件期望表 backfill（市值×超卖深度×结构×OI）大规模任务  
- Discord 卡片与 OI `agentDecision` **双向同步**  

---

## 10. 相关代码索引

| 主题 | 路径 |
|------|------|
| Agent A/B/C | `agent_decision.py`, `agent_decision_bridge.py` |
| PA 原语 | `oi_mornitor/pa/*` |
| 形态扫描 | `pattern_monitor.py` |
| TG 推送 | `notify_telegram.py`, `pattern_emit_gate.py` |
| 胜率库 | `pattern_alert_stats.py` |
| 共振质量分 | `signal_confluence.py`, `confluence_features.py` |
| 实盘卡片 | `discord-signal-card-service.js`, `trade-platform-toggles.js` |
| 单元测试 | `tests/test_agent_decision_pa.py` |

更细的拐点 / Vegas 图表说明见 [signal-logic.md](./signal-logic.md)。PA 层 API 摘要见 [agent-decision-pa.md](./agent-decision-pa.md)。
