# oi_mornitor 信号 · 拐点 · 通知逻辑说明

本文档整理 `oi_mornitor` 内全部业务信号、图表标注（次高点 / 扳机线 / Vegas / 射击之星等）、**交易卡片生命周期** 与通知通道，方便对照 Pine（`tradingview-bollinger-wicks.pine` / Vegas 双通道）与前端图表。

---

## 1. 总览：业务链路 + 形态图 + 卡片

```
RadarService.scan_once (~30–60s)
  ├─ OI 热钱异动           → hot_tickers（Toast + AlertFeed）
  ├─ 矩阵突破回踩           → breakout_alerts（BreakoutToast）
  ├─ 形态 LH→HL→扳机        → pattern.pattern_alerts（PatternToast）
  ├─ 形态∩柱级OI           → pattern_alerts type=candle_pattern_oi（Toast；TG 旧文案默认让位卡片）
  ├─ 多周期形态卡片         → pattern_alerts type=candle_pattern_card → Telegram 卡片群
  ├─ 回踩/Vegas/射击之星    → pattern.pullback_alerts（后端有、前端 Toast 未接）
  └─ 交易卡片生命周期       → pattern.card_orders（卡片看板 · CardLifecyclePanel）

图表 /api/patterns/chart
  → candles + BB + Vegas EMA + price_lines(H_max/LH/扳机…) + markers(拐点/锤子/射击之星)
```

**通知通道速查**

| 信号 | SSE 字段 | 前端 Toast | Telegram |
|------|----------|------------|----------|
| OI 热钱 | `hot_tickers` | 雷达页 ✅ | ❌ |
| 矩阵突破扳机 | `breakout_alerts` | 雷达页 ✅ | ❌ |
| 形态多头爆发 | `pattern.pattern_alerts` | 形态页 ✅ | ❌ |
| 形态卡片（射击之星/OI倒锤子） | `pattern.pattern_alerts` `candle_pattern_card` | 形态页 ✅ | ✅ `OI_CANDLE_CARD_TELEGRAM_CHAT_ID` |
| **MAIN 热门精选**（默认 BTC/ETH） | 同上 + 量价 ticker | — | ✅ `MAIN_CARD_TELEGRAM_CHAT_ID` · `main_card_policy`：15m/1h/4h 射击之星/倒锤子/量价确认/量价推进 |
| 结构卡片（头肩/探底/2B/Sweep） | `pattern.pattern_alerts` `structure_pattern_card` | 形态页 ✅ | ✅ 同群 · `OI_STRUCTURE_CARD_TELEGRAM`（不进 MAIN） |
| 形态信号结算摘要（4h） | 胜率库 `pattern_alert_stats` | 形态列表 | ✅ `MAIN_CARD_TELEGRAM_CHAT_ID` · 北京 04/08/12/16/20/24 |
| 回踩/射击之星 | `pattern.pullback_*` | ❌ 未接 | 仅 `run_coin_monitor --telegram` |
| 形态信号列表胜率 | `pattern_alert_stats` + Ticker | 形态页 ✅ | ✅ 4h 结算摘要 |

---

## 2. 形态拐点逻辑（LH / 扳机线 / HL）

对应引擎：`pattern_detector.py` + `pattern_monitor.py`  
图表：`build_pattern_chart_payload` → 前端 `PatternChartPanel`

### 2.1 关键价位定义

| 代号 | 中文 | 如何得到 | 图表表现 |
|------|------|----------|----------|
| **H_max** | 绝对高点 | 最近两个 pivot high 中的较高者（或状态机写入） | 红色水平线 + ① 箭头 |
| **LH** | 次高点 | 第二个 pivot high，且 `LH < H_max` | 黄色水平线 + ② 箭头 |
| **L₁** | 洗盘低点 | LH 之后第一个（或最近）pivot low | 浅红水平线 + 上箭头 |
| **HL** | 更高低点 | 第二个 pivot low，且 `HL > L₁` | 绿色水平线 + ③ 箭头 |
| **扳机线 / 夹角高点** | Trigger | L₁→HL 区间内的 **最高价** | 蓝色虚线水平线 + 「夹角高点」圆点 |
| **HH** | 多头爆发收盘 | 收盘突破扳机线后的确认价 | 绿色 ④ 箭头 |

Pivot 窗口：`PATTERN_PIVOT_WINDOW`（默认 11，居中 rolling max/min）。

### 2.2 状态机

```
SEARCHING_TOP
    │  detect_stage1_lh：两高点形成 LH + (BB 上轨插针 或 MACD 高位走弱)
    ▼
STAGE_1_LH_DETECTED（次高点确认）
    │  继续找 HL
    ▼
WAITING_FOR_HL（等待更高低点）
    │  detect_stage2_trigger：
    │    HL > L₁
    │    收盘 > 扳机线（夹角高点）
    │    量 ≥ vol_sma20 × PATTERN_STAGE2_VOL_MULT(1.5)
    │    MACD 金叉且柱扩大
    ▼
TRIGGER_SIGNAL（多头爆发）→ trigger_emitted=true，本币不再评估
    超时 PATTERN_WATCH_MAX_SEC(14400) → EXPIRED
```

### 2.3 阶段细节

**阶段 1 — 次高点（LH）**

- 条件：最近两 pivot high 满足后高 < 前高 → 记为 LH / H_max  
- 滤波（满足其一即可）：
  - **BB-Wicks 上轨插针**：`high > bb_upper` 且收盘回到轨内，上影线/实体 ≥ `PATTERN_WICK_RATIO`(0.3)
  - **MACD 高位走弱**：死叉或红柱缩短

**阶段 2 — 更高低点 + 扳机**

1. 形成 **HL > L₁**  
2. 计算 **扳机线** = L₁～HL 之间最高价（夹角反弹高点）  
3. 收盘 **带量突破** 扳机线  
4. MACD 金叉放大 → 发 `pattern_bull_continuation` 告警

### 2.4 去重 / 持久化

- **主形态扫描已不再跑 LH→HL→扳机状态机**（仅图表仍画 H_max/LH/扳机线）；`pattern_bull_continuation` 不进 ticker/胜率库  
- DB：`data/pattern_state.db`（历史字段保留）  
- 回踩策略 `PullbackStrategyEngine` 独立；默认 `OI_PULLBACK_SCAN_ENABLED=0`

---

## 3. Vegas 双通道（与 Pine 对齐）

Pine 参考：

```pine
study("Vegas双通道", overlay=true)
a=12   // 过滤线 绿
b=144  // A组1 蓝
c=169  // A组2 蓝
d=576  // B组1 红
e=676  // B组2 红
```

| 线 | 周期 | 颜色 | 用途 |
|----|------|------|------|
| 过滤线 | EMA 12 | 绿 `#00e676` | 短周期过滤（策略 mid 可不计入） |
| A 组 | EMA 144 / 169 | 蓝 `#2196f3` | 中轨通道 |
| B 组 | EMA 576 / 676 | 红 `#ef5350` | 长轨通道 |

**配置**：`OI_STRATEGY_VEGAS_FILTER=12`，`OI_STRATEGY_VEGAS_PERIODS=144,169,576,676`  
**策略用法**（`strategy/pullback.py`）：回踩锚点候选含 `vegas_mid`（A/B 四线均值，不含过滤线）  
**BB-Wicks Pine**：信号名「V」前缀表示价格贴近 A/B 通道（容差占布林带宽 %），过滤线不参与 V 判定。

图表 API 字段：`vegas: { filter, a1, a2, b1, b2 }`（`{time,value}[]`）。

---

## 4. 射击之星 / 倒锤子（对齐 BB-Wicks Pine）

实现：`strategy/indicators.py`  
图标注：`pattern_detector.build_pattern_chart_payload` → markers `kind=shooting_star|inverted_hammer`

### 4.1 射击之星（看跌）

```
上影线 ∈ [实体×1.5, 实体×max_ratio]   # STRATEGY_SHOOT_WICK_RATIO / MAX
下影线无 或 下影线×2 < 上影线
at_lower（近布林下轨）时必须收阴，其它位置阴阳皆可
```

### 4.2 倒锤子（看涨，射击之星倒置）

```
下影线 ≥ 实体 × ratio(1.5)
上影线 < 下影线 / 3
须在布林中轨之下；若已是射击之星外形则不再标倒锤子
```

**卡片/列表推送（2026-09）**：与射击之星对称——中轨下 + 前序跌幅 ≥3%；**不再要求柱级 OI**。OI 异动仅图表 tag `(oi异动)`，不进 typeLabel / 胜率库。

图例：射击之星品红下行箭头；倒锤子青色上行箭头。

---

## 5. 其它三条信号机（通知侧）

### 5.1 OI 热钱

- 阈值：`|ΔUSD|≥OI_USD_LIMIT` 或 `|Δ%|≥OI_PCT_LIMIT`（5m/15m 门控评估）  
- 冷却 900s：同向抑制；反向或 15m 升级放行  
- Toast：`ToastStack`（会话内按 symbol 永久 seen）

### 5.2 矩阵突破回踩

- Stage1 真突破写库不弹；Stage2 缩量回踩 supply_wall → `breakout_trigger`  
- Toast：`BreakoutToastStack`

### 5.3 回踩 / Vegas / 射击之星策略

- Stage1：`is_valid_breakout` 或反转背景  
- Stage2：缩量贴 wall / BB 中轨 / Vegas 中线 → 多；或顶部射击之星 → 空  
- **默认关扫描**：`OI_PULLBACK_SCAN_ENABLED=0`（仅 SSE 无 Toast 的半开状态已停用；要调参再显式开启）
- CLI：`python -m oi_mornitor.scripts.run_coin_monitor --telegram`

### 5.4 多周期形态 / 结构 Telegram 卡片

- 引擎：`PatternMonitorEngine._scan_candle_pattern_cards`
  - 蜡烛：`candle_signals.find_last_closed_candle_card_hits` + `notify_telegram.format_candle_card_message`
  - 结构：`structure_signals.find_last_closed_structure_hits` + 顶部/底部模板
- **主流**（默认 BTC/ETH/SOL）：`15m/1h/4h`（30m 已停）
- **山寨**：流入 Top7 → 射击之星 / 顶部结构；涨幅 Top7 **仅**倒锤 / 结构看多（不与追涨空叠）
- 蜡烛：过滤后射击之星、无 OI 倒锤子；**停推** `(oi异动)`、V*、射击之星（2）、连续插针、形态∩OI 短线
- 结构：头肩/M顶 + **破位质量**（≥0.6×ATR 或连续收中轨下）；Sweep 须放量且收在前高下；**圆弧顶不进自动卡片**
- 量价 ticker：停推「量价推进·空」；「量价确认·空」须 1h Vegas DOWN
- 统一策略：`signal_policy.py`（ticker / 胜率库 / 卡片共用）
- 群：`OI_CANDLE_CARD_TELEGRAM_CHAT_ID`；开关 `OI_CANDLE_CARD_TELEGRAM` / `OI_STRUCTURE_CARD_TELEGRAM`
- 去重：同币同周期同类型同开盘时间只推一次
- **结算摘要**：北京时间 `04/08/12/16/20/24` 点，把形态信号列表本档 4h + 当日累计推到 `MAIN_CARD_TELEGRAM_CHAT_ID`（开关 `OI_STATS_SETTLE_TELEGRAM`）

**2026-09 准确率调优过滤（均可在 `config.py` 经环境变量开关/调参）**

- 射击之星位置过滤：收盘须在 BB 上轨区（`basis + 0.85×带宽`）或贴近 Vegas A/B 通道，否则不推
  - `OI_CANDLE_SHOOT_REQUIRE_POSITION`（默认开）
- 趋势背景：射击之星要求信号前 `OI_CANDLE_SHOOT_TREND_LOOKBACK`(20) 根累计涨幅 ≥
  `OI_CANDLE_SHOOT_TREND_MIN_PCT`(3%)；倒锤子要求前 `OI_CANDLE_HAMMER_TREND_LOOKBACK`(20) 根
  累计跌幅 ≥ `OI_CANDLE_HAMMER_TREND_MIN_PCT`(3%)
- 结构破位量能确认：头肩顶 / M顶 触发 K 成交量 ≥ `OI_STRUCTURE_BREAK_VOL_MULT`(1.3) × MA20
- 圆弧顶斜率归一化：斜率按窗口均价相对变化（%/根），当前 20 根斜率对比 10 根前窗口；
  阈值 `OI_STRUCTURE_CURVE_UP_SLOPE`(0.05) / `OI_STRUCTURE_CURVE_DOWN_SLOPE`(0.0) /
  `OI_STRUCTURE_CURVE_DECEL`(-0.08)，消除主流/山寨价格尺度差异
- 推送节流：同币同周期同方向在 `OI_CARD_PUSH_COOLDOWN_BARS`(4) 根 K 内只推一次（发送成功才计时）
- 蜡烛卡片文案补参考位：看跌给「上方防守=前20根高点 / 下方参考=布林中轨」，看涨给「下方防守=前20根低点 / 上方参考=布林中轨」

### 5.5 入场条件明细（胜率列表 typeLabel）

以下为 Telegram / ticker / 胜率库里常见类型的**达成条件**（实现以代码为准）。

#### A. 底部二次探底确认（多）— `bottom_secondary_test`

实现：`structure_signals._detect_bottom_reversal`

| 步骤 | 条件 |
|------|------|
| 恐慌柱 L1 | 量 ≥ **2.0×MA20**，且（下影 > 振幅×**0.4** **或** 大阴实体 > 振幅×**0.5**） |
| 二次低点 L2 | L1 后第 **3～25** 根内；**L1×0.98 ≤ L2 ≤ L1×1.03**（贴前低） |
| 确认柱 | **阳线**且收盘位置 ≥ 振幅 **70%**，**或**阳包阴吞没 |
| 入场 | 确认柱收盘价；防守 `min(L1,L2)` |

#### B. 破底翻确认（多）— `spring_2b`

实现：`structure_signals._detect_spring_2b`

1. swing low 前低 L1（窗 order=5）  
2. 之后某根 **低点 < L1**（假破）  
3. 刺破后 **1～3** 根内：收盘 **> L1** 且为阳线，量 ≥ **1.3×MA20**  
4. 入场=收回确认柱收盘；防守=刺破低点  

#### C. 顶部结构确认（空）— 多种子形态同标签

| 子形态 | 要点 |
|--------|------|
| 头肩+Vegas | 头 > 两肩；两肩价差 ≤ **3%**；右肩后 **15** 根内实体跌破 Vegas 中轨（或破颈线且收在中轨下）；量 ≥ **1.3×MA20** |
| M顶+Vegas | 两峰价差 ≤ **3%**、中间明显回落；之后实体跌破 Vegas 中轨；量 ≥ **1.3×MA20** |
| 流动性掠夺 | 上影刺破前高后收阴且收 < 前高；上影 ≥ 振幅 **25%**；OI 异动 **或** 量≥1.3×MA20 |
| 圆弧动量衰竭 | 近 20 根相对斜率：前段上涨 → 当前走平/下行；近高未创新高；收阴且收 < Vegas 中轨 |

#### D. 射击之星 / 连续走平射击之星（空）

实现：`candle_signals.find_last_closed_candle_card_hits` + `indicators.detect_shooting_star`

- 外形：上影 ∈ [1.5×实体, max]；下影很短  
- 位置：收盘在 BB 上轨区（中轨+0.85×带宽）或近 Vegas A/B  
- 趋势：前 **20** 根涨幅 ≥ **3%**  
- 「（2）」：重复窗内再次出现 → 类型名「连续走平射击之星」  

#### E. 倒锤子（多）

- 外形：下影 ≥ 1.5×实体，上影 < 下影/3；收盘在中轨下  
- **仅**柱级 OI 异动时推送  
- 趋势：前 **20** 根跌幅 ≥ **3%**  

#### F. 形态多头爆发（多）— LH→HL→扳机

见上文 §2：HL>L₁、带量破扳机线、MACD 金叉放大。

---

## 6. 图表标注图例（形态页）

| kind | 含义 | 视觉 |
|------|------|------|
| `h_max` | 绝对高点 | 红线 + ↓ |
| `lh` | 次高点 | 黄线 + ↓ |
| `l1` | 洗盘低 | 粉线 + ↑ |
| `hl` | 更高低点 | 绿线 + ↑ |
| `mid_peak` / `trigger` | 夹角高点 / 扳机线 | 蓝虚线 + ○ |
| `hh` | 爆发确认 | 绿 ↑ |
| `bb_wick` | BB 上插针 | 紫 ○ |
| `shooting_star` | 射击之星 | 品红 ↓ |
| `inverted_hammer` | 倒锤子 | 青 ↑ |
| Vegas EMA | 过滤/A/B | 绿/蓝/红折线 |

---

## 7. 关键文件

| 内容 | 路径 |
|------|------|
| 形态拐点 / 扳机 / 图表 payload | `pattern_detector.py` |
| 形态状态机 + watchlist（每 2h 合约流入+OI 爆发刷新，未进场可替换） | `pattern_monitor.py` / `pattern_state_tracker.py` |
| Vegas / 射击之星 / 倒锤子指标 | `strategy/indicators.py` |
| 回踩策略 | `strategy/pullback.py` |
| **交易卡片** | `cards/engine.py` + `cards/card_tracker.py` + `cards/card_parser.py` |
| **形态列表胜率入库** | `pattern_alert_stats.py` |
| **形态列表统一出场** | `pattern_settle.py` + `frontend/src/utils/patternAlertWinRate.ts` |
| **列表入场规则文案** | `frontend/src/utils/patternEntryRules.ts` |
| 配置 | `config.py`（`PATTERN_*` / `STRATEGY_*` / `CARD_*` / `OI_CARD_WS_*`） |
| 图表 UI | `frontend/src/components/PatternChartPanel.tsx` |
| 卡片看板 UI | `frontend/src/components/CardLifecyclePanel.tsx` |
| Pine 对照 | 仓库根目录 `tradingview-bollinger-wicks.pine` |

---

## 8. 已知缺口

1. Pullback 告警进了 SSE，形态页尚无 Toast。  
2. 主雷达不发 Telegram。  
3. 形态 / 回踩 TRIGGER 后不自动重置。  
4. `_last_alerts` 仅本轮，非历史 inbox（卡片订单在 SQLite `card_orders`）。

---

## 9. 交易卡片生命周期（collector → OI）

实现：`cards/engine.py` · `cards/card_tracker.py` · `cards/card_parser.py`  
前端：形态页「卡片看板」· `CardLifecyclePanel.tsx`

- **接入**：discord-collector `CARD_SINK` → WS `OI_CARD_WS_PATH`（默认 `/ws/cards`）或 `POST /api/cards`
- **不做纸面模拟开单**：仅登记卡片、刷新市价、更新生命周期阶段（监听 / 近场 / 挂单 / 入场 / 止盈 / 止损）
- **市价卡**：接入后标记为挂单，下一轮扫描按现价写入 `fill_price` 并进入「入场」
- **限价卡**：距入场区 ≤ 近场阈值 →「近场」→ 触价 →「入场」；主流 BTC/ETH 或杠杆≥80 为 **0.2%**，山寨小杠杆约 **1%**
- **出场判定**：按卡片 SL / 多级 TP 与现价比较更新阶段，**不下单、不计纸面 PnL**
- **市价刷新**：`POST /api/cards/prices` 或后台 `CARD_PRICE_REFRESH_SEC`（默认 5 分钟）

## 10. 形态信号列表：入场与出场逻辑总览

> **用途**：形态页底部 **Ticker / 胜率弹窗** 用的核算口径；与 §9 **卡片生命周期看板** 独立。  
> 列表回答：「这条 TG 推送的信号，若按统一规则进场，3h 内算胜还是负？」

### 10.0 数据流

```
信号产生（形态扫描 / TG 推送 / 交易卡片归档）
    → record_alert_from_push / record_card_from_archive
    → pattern_alert_stats.json（outcome=pending）
    → 前端 verifyDueAlertStats（每 15m）或弹窗手动重核
    → settleAlertByKlines（对齐 pattern_settle.settle_signal_batch）
    → POST /api/pattern-alert-stats 回写 outcome / movePct / pnlPct
    → Ticker 着色 · 胜率弹窗 · 4h 结算摘要 TG
```

| 环节 | 实现 |
|------|------|
| 入库（形态/结构 TG 卡） | `pattern_alert_stats.record_alert_from_push` ← `notify_telegram` |
| 入库（discord-collector 交易卡） | `record_card_from_archive` ← `POST /api/pattern-alert-stats/record-card` |
| 核实窗口 | 信号后 **3h**（`verifyAt = signalAt + 3h`） |
| 步进节奏 | 每 **15m** 拉 Binance 15m K 重算；未满 3h 且未触发则保持 `pending` |
| 前端规则文案 | `frontend/src/utils/patternEntryRules.ts`（弹窗「入场规则」） |
| 前端结算 | `frontend/src/utils/patternAlertWinRate.ts` |
| 后端结算（回测等同源） | `pattern_settle.py` |

**关键原则**：各信号类型的差异只在 **§10.2 入场价/方向**；**§10.3 出场规则对所有入库信号统一**，不按 typeLabel 分叉（含 TG 交易卡）。

---

### 10.1 入库条件（谁进列表）

| 来源 | `source` | 必要条件 |
|------|----------|----------|
| 蜡烛/结构 TG 卡片 | `telegram_push` | 能解析 `long/short`；有 `entry`（见下表）；非 legacy 带量突破 |
| discord-collector 交易卡 | `telegram_card` | 有 `cardId`、方向、数字 `entry`（execution / parsedJson） |

**不入库 / 已停用**（`signal_policy.py` 统一判定；**启动时从胜率库 / ticker 物理删除**，24h 弹窗不再展示）

- Legacy：`pattern_bull_continuation` / 带量突破扳机
- 周期 **`30m`**
- **`破底翻确认` / `spring_2b`**
- 蜡烛停推：`(oi异动)`、V*、射击之星（2）、连续插针、形态∩OI 短线（`candle_pattern_oi` / `oi_anomaly`）
- 结构停推：圆弧顶（`curvature_decay`）
- 量价停推：「量价推进·空」（`vp_cont_thrust` 空）
- 无法解析方向或入场价

---

### 10.2 各信号类型的入场定义

入场价一律取 **信号 K 线收盘价**（或卡片归档时的 `entryPrice` / `price` / `close`），除非另有说明。  
「防守位」仅作推送文案/图表参考，**列表核算不使用**自定义 SL，统一走 §10.3 的 ±5%。

| typeLabel（列表展示） | 方向 | 入场价 | 触发要点（实现） |
|----------------------|------|--------|------------------|
| **底部二次探底确认** | 多 | 确认柱收盘 | L1 恐慌放量 → L2 贴 L1（±3%）→ 阳线确认（`structure_signals._detect_bottom_reversal`） |
| **破底翻确认** | 多 | 收回柱收盘 | Spring/2B：假破 L1 后 1～3 根内收回（**已不进胜率库**） |
| **顶部结构确认** | 空 | 破位柱收盘 | 子形态：头肩/M顶+Vegas 中轨跌破、流动性掠夺、圆弧顶衰竭（`structure_signals`） |
| **射击之星** | 空 | 信号柱收盘 | 上影≥1.5×实体；BB 上轨区或近 Vegas；前 20 根涨幅≥3% |
| **连续走平射击之星** | 空 | 同上 | 短窗内第二次射击之星 |
| **倒锤子** | 多 | 信号柱收盘 | 下影≥1.5×实体；收盘在中轨下；**须柱级 OI 异动**；前 20 根跌幅≥3% |
| **形态多头爆发** | 多 | 扳机确认收盘 | LH→HL→带量破扳机线（§2；legacy 突破已从库剔除） |
| **TG 交易卡** | 卡方向 | 卡片 `entry` | `typeLabel`≈频道名；须归档时已有数字入场价 |

详细条件与 §5.4 / §5.5、`patternEntryRules.ts` 一致。调整入场检测改 **扫描侧**；调整列表盈亏改 **§10.3** 或杠杆口径。

---

### 10.3 统一出场规则（列表专用）

**所有**进入 `pattern_alert_stats` 的记录共用同一套 **`settle_signal_batch`**，与信号类型无关。

| 项 | 默认值 | 说明 |
|----|--------|------|
| 止损 | **±5%**（相对入场价） | 剩余仓位一次性触发即全平该部分 |
| TP1 | **+3%** | 平 **30%** 仓位（加权计入 movePct） |
| TP2 | **+7%** | 再平 **30%** |
| Runner | 余 **40%** | TP2 触达后启动；从极值 **回撤 5%** 跟踪止盈（多：高点下移线；空：低点上移线） |
| 核实 K 线 | **15m** | 5m 源数据会聚合为 15m |
| 最长窗口 | **3h** | 超时仍有剩余 → 按窗口末 **收盘价** 结算余仓 |
| 价格对齐 | 自动 scale | 入场与 K 线量级差 >50× 时尝试对齐（防 1000PEPE 等） |

**Outcome 判定**

- `take_profit`：加权 `movePct > 0`
- `stop_loss`：加权 `movePct < 0`
- `flat`：\|movePct\| ≈ 0
- `pending`：未满 3h 且未触发 SL/TP/Runner
- `error`：无 K 线等

**盈亏展示（弹窗/TG 摘要）**

- `movePct` = 各档 **价格变动 %** 按 30/30/40 加权
- `pnlPct` = `movePct × 杠杆`（保证金 ROE 近似）
- 杠杆：**BTC/ETH/SOL → 100x**；其余山寨 → **20x**

> **注意**：§10.3 为列表专用统一出场；与 §9 卡片 SL/TP 阶段展示**不是同一套核算**。改列表胜率只动 `pattern_settle.py` + `patternAlertWinRate.ts`。

---

### 10.4 与交易卡片 / 潜力暴涨的关系

| 系统 | 入场 | 出场 | 关系 |
|------|------|------|------|
| **列表胜率** | §10.2 信号价或卡片 entry | §10.3 统一 3/7% + Runner | 事后回溯，不下单 |
| **卡片看板（§9）** | collector 推送的 entry / 市价 | 卡片 SL + TP 阶段展示 | 实时监听，不纸面开单 |
| **潜力暴涨 B/C** | 漏斗状态 | 仅警报与占槽 | 不占列表 typeLabel |

TG **交易卡**同时可能：① 登记胜率库（有 entry 时）；② 推送到 OI 卡片看板。两者独立核算。

### 10.5 调参索引（后续改规则看这里）

| 目标 | 文件 / 变量 |
|------|-------------|
| 某类信号 **能不能推送** | `pattern_monitor.py` · `candle_signals.py` · `structure_signals.py` · `config.py` `OI_CANDLE_*` / `OI_STRUCTURE_*` |
| 信号 **入场条件文案** | `frontend/src/utils/patternEntryRules.ts` · 本文 §5.5 |
| 列表 **TP/SL/Runner** | `pattern_settle.py`（`TP_LEVELS_PCT` / `BATCH_WEIGHTS` / `DEFAULT_SL_PCT` / `RUNNER_TRAIL_PCT`）· `patternAlertWinRate.ts` 同名常量 |
| 列表 **核实窗口** | `pattern_alert_stats.py` `_VERIFY_DELAY_MS` · `patternAlertWinRate.ts` `ALERT_VERIFY_DELAY_MS` |
| 列表 **杠杆口径** | `pattern_alert_stats._leverage` · `patternAlertWinRate.ts` `LEV_100_BASES` |
| 入库 **黑名单** | `pattern_alert_stats.record_alert_from_push` |
| 卡片生命周期 | §9 · `cards/engine.py` |
| 4h 结算 TG 摘要 | `pattern_alert_settle_report.py` · `OI_STATS_SETTLE_TELEGRAM` |

---

## 11. 潜力暴涨漏斗（A/B/C）

并行于 LH→HL 拐点机；字段挂在 `pattern.moonshot*`。核心：**先找死久了还在抬的盘子，再只做放量收盘离开平台的那一下**；竖起后切「寻找顶部」，不追中段。

### 11.1 猎场

- 默认宇宙：雷达 `TOP_N`（≈200），**不是**全市场
- 中场 OI 优先；踢稳定币、24h 涨幅过热前排、低 `quote_volume`
- OI 不足不否决
- 监听硬上限仍为 **50**；A 池可更大，按 **漏斗状态**占槽（B/C 态优先）
- 全市场：`OI_MOONSHOT_FULL_SCAN=1`（默认关；每 2h 约 +700～900 次 K，有 418 风险）

### 11.2 状态机（2026-09 起不再使用数值评分）

| 状态 | 含义 | 动作 |
|------|------|------|
| `COMPRESS` | 压缩观察 | 只盯不买 |
| `WAIT_HL` / `LH_NEAR` / `READY_BREAK` | 蓄势 B | 警报 |
| `IN_POSITION` | C 放量收盘突破 | 警报 |
| `FIND_TOP` | 已竖直/量高潮 | 只减不加 |
| `INVALID` | 跌回 HL/平台 | 冷却 3～5 天 |

进 B/C、占监听槽、发警报 **仅看状态**，不再计算 0～10 分；左侧列表只展示 **状态标签 + reasons**，不展示分数。

### 11.3 扫描节奏

- A：独立慢环 `OI_MOONSHOT_A_INTERVAL_SEC`（默认 7200），1h K，与主环错峰
- B/C：形态 watchlist 每轮 15m K 复用更新，几乎不增请求

开关：`OI_MOONSHOT_ENABLED`（默认开）、`OI_MOONSHOT_FULL_SCAN`（默认关）。

---

## 12. 币股并行池（equity_pool）

与加密 OI 分层 **完全并行**：**不**进入 `build_tier_pool()`、**不**计入 `eligible_count` / 大象·中场·监控 badge；SSE 独立字段 + badge「币股 N」。

| 项 | 说明 |
|----|------|
| 入池 | 白名单 × 交易所别名；24h 成交额 ≥ `OI_EQUITY_MIN_TURNOVER_USD`；无 OI 可入池 |
| 刷新 | 独立慢环 `OI_EQUITY_SCAN_INTERVAL_SEC`（默认 300s），与主环 30–60s 错峰 |
| 形态 | 仅 `OI_EQUITY_KLINE_INTERVALS`（默认 1h/4h）；禁用 `*(oi异动)*`、V*、连续插针、moonshot |
| 时段 | `OI_EQUITY_SIGNAL_SESSION_ONLY=1` 时非美股时段只更新图表标注，不 `record_alert` |
| 胜率 | `asset_class=equity` · 杠杆 `OI_EQUITY_STATS_LEVERAGE`（默认 5x）· 核实窗 4h |
| TG | 默认关 `OI_EQUITY_CARD_TELEGRAM=0` |
| 关闭 | `OI_EQUITY_ENABLED=0` 时行为与加币股前一致 |

关键文件：`equity_pool.py` · `equity_pattern.py` · `radar._equity_loop` · `pattern_alert_stats.record_equity_alert_from_scan`。
