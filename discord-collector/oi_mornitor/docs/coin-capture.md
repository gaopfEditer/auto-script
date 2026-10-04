# 币种捕获逻辑

本文说明 **哪些币会进入监控、形态 watchlist、Telegram 卡片扫描、MAIN 热门群**，以及各通道的优先级与替换规则。实现以 `radar.py`、`pattern_monitor.py`、`focus_symbols.py`、`equity_pool.py` 为准。

---

## 1. 总览

```
Binance fapi 全市场 ticker + OI
    → build_tier_pool（量级分层，TOP_N 截断）
    → pool_rows（矩阵 16 榜、hot_tickers、SSE）
         ├─ 形态 watchlist（≤50，持久化 pattern_state.db）
         ├─ 蜡烛/结构 TG 卡片（主流固定 + 山寨 Top7 池）
         ├─ MAIN 群（focus_symbols 白名单）
         ├─ 币股池（与加密分层并行）
         └─ TV BB-Wicks CDP 监听（≥4 榜共振，独立任务）
```

**原则**

- **加密 OI 分层池**与 **币股池** 互不混用；币股不计入雷达「大象/中场/监控 N」badge。
- 形态 **watchlist** 决定每轮 15m 主扫描拉哪些币的 K 线；**卡片扫描**另有主流固定表 + 山寨排行池（可部分重叠 watchlist）。
- 稳定币、warming 状态、OI &lt; 1000 万 USD 的币不会进入分层池。

---

## 2. 雷达候选池（`build_tier_pool`）

| 项 | 说明 |
|----|------|
| 数据源 | 默认 Binance `ticker/24hr` + 逐 symbol `openInterest`；失败可走 `exchange_sources` 备选所 |
| 分层 | **大象** ≥ 5000 万 USD 总持仓；**中场** 1000 万～5000 万；低于 1000 万 **排除** |
| 排序 | 按当前 OI USD 降序 |
| 规模 | `TOP_N`（约 200）截断后作为矩阵、形态、突破扫描的 **pool_rows** |
| 刷新 | 主环约 30–60s；OI 分钟缓存算 5m/15m 变动 |

`pool_rows` 上挂载 `rank_by_tf`（价格 / OI / 合约流入 / 强度等），供榜单、捕获与 UI 使用。

---

## 3. 形态 watchlist（形态页左侧，最多 50 币）

**配置**：`OI_PATTERN_WATCH_MAX`（默认 50）、`OI_PATTERN_AUTO_PICK`、`OI_PATTERN_WATCHLIST_REFRESH_SEC`（默认 7200 = 2h）、`PATTERN_CARD_RESERVED`、`PATTERN_MANUAL_RESERVED`。

### 3.1 槽位

| 类型 | 行为 |
|------|------|
| **卡片预留** | Discord/OI 接入的交易卡 `ensure_card_symbol` → 长置顶（`PATTERN_CARD_PIN_TTL_SEC`），占预留槽 |
| **手动槽** | 全局最多 1 个手动输入币（`SLOT_MANUAL`），满员时可挤掉可替换位 |
| **置顶 pin** | 用户右键置顶 ≥1 天，刷新时 **不踢** |
| **热榜额度** | `MAX - 卡片预留 - 手动空位`；由 `pick_hot_flow_and_oi` 填充 |

### 3.2 热榜选币（`pick_hot_flow_and_oi`）

在 **非 warming** 且非稳定币的 `pool_rows` 上：

1. 按配置周期 TF（默认与 `PATTERN_WATCHLIST_REFRESH_TF` 一致）取 **合约流入** 正幅度 Top 一半；
2. 再取 **OI 正幅度** Top 填满 `count`；
3. 仍不足 → **随机大象池**（`pick_random_heavyweight`）。

用于：空列表初始化、2h 刷新、满员补齐、用户「热钱重选」。

### 3.3 定时刷新（`refresh_watchlist_from_hot`）

每 **2h**（可 `force`）：

1. **保留**：置顶、手动槽、`protect_extra`（如沙盒持仓）；
2. **替换**：其余未保护位 → 新的流入+OI 热榜（不超过 hot_cap）；
3. 若未满 soft_cap，**短暂保留**当前列表里未进场旧币（不挤卡片预留）。

**可踢状态**（满员腾位）：`EXPIRED`、`SEARCHING_TOP` 等未进场状态（见 `_EVICTABLE_PATTERN_STATUSES`）；已 LH/等待 HL/扳机阶段视为进场，优先保留。

### 3.4 雷达联动（每轮 `scan`，立即 ingest）

| 入口 | 条件 | 行为 |
|------|------|------|
| `ingest_gainers_oi_intersection` | **涨幅榜** ∩ **持仓正榜**（同 TF） | 加入并置顶 |
| `ingest_oi_anomaly_multiboard` | OI 告警/hot **且** 矩阵 **≥2 榜**（`PATTERN_MULTI_BOARD_MIN`） | 加入并置顶；满员踢未进场 |
| `ingest_oi_amplified` | `is_alert`/`is_hot` 或 \|pct_5m\|/\|pct_15m\| ≥ `PATTERN_OI_AMPLIFY_PCT` | 同上 |
| `ingest_moonshot_candidates` | 潜力暴涨漏斗 B/C 态高分 | 占监听槽（与主环共享 50 上限） |

### 3.5 用户操作

- `POST /api/patterns/watch`：追加；满员走 `_evict_one_replaceable` 或手动预留溢出。
- 手动槽 / 置顶 / 移除 / 热钱重选：见 `PatternMonitorEngine` API。

---

## 4. Telegram 蜡烛/结构卡片扫描宇宙

引擎：`PatternMonitorEngine._scan_candle_pattern_cards`（与 watchlist **部分独立**）。

### 4.1 主流（`CANDLE_CARD_MAJOR_SYMBOLS`）

- 默认 **BTC / ETH / SOL**（及 `config` 扩展）。
- 周期：**15m / 1h / 4h**（30m 已停）。
- 角色：**flow + dip 均可**（射击之星、倒锤子、顶部/底部结构按 `signal_policy` 过滤）。

### 4.2 山寨动态池（`CANDLE_CARD_ALT_TOP_N` 默认 7）

在 **非主流**、非 stable、非 warming 的 pool_rows 上，按 `CANDLE_CARD_ALT_RANK_TF`（通常 15m）：

| 池 | 选法 | 扫描信号侧重 |
|----|------|----------------|
| **流入 TopN** | `contract_flow` 幅度 | 射击之星、**顶部结构** |
| **涨幅 TopN** | `price` 幅度 | **倒锤子**、底部结构看多（不与 flow 重复时单独扫） |

周期：**15m / 1h**（`CANDLE_CARD_ALT_INTERVALS`）。

池子未暖好时，短暂回退 **watchlist 非主流币**（最多 `2×TopN`）仅作流入池。

### 4.3 K 线缓存

按 `(symbol, interval)` 缓存，`CANDLE_CARD_REFRESH_SEC` 控制刷新；结构扫描需要更长历史（`STRUCTURE_KLINE_LIMIT`）。

---

## 5. MAIN 热门群（`MAIN_CARD_TELEGRAM_CHAT_ID`）

与形态卡片群（`OI_CANDLE_CARD_TELEGRAM_CHAT_ID`）分离。

| 项 | 说明 |
|----|------|
| 币种 | `focus_symbols.json` ∪ `MAIN_CARD_DEFAULT_SYMBOLS`（默认 **BTC/ETH** + **QQQ/SOXL** + 美股七巨头等；见 `focus_symbols.py` 合并逻辑） |
| 周期 | `MAIN_CARD_INTERVALS`：**15m / 1h / 4h** |
| 类型 | `MAIN_CARD_TYPE_PREFIXES`：射击之星、倒锤子、量价确认、量价推进等前缀匹配 |
| 过滤 | `main_card_policy.is_main_card_eligible` + 全局 `signal_policy`（如停推「量价推进·空」） |

量价 ticker 扫描：`volume_price.ticker_bridge.scan_volume_price_ticker_alerts`，HTF K 线门控（如量价确认·空须 1h Vegas DOWN）。

---

## 6. 币股并行池（`equity_pool`）

| 项 | 说明 |
|----|------|
| 开关 | `OI_EQUITY_ENABLED` |
| 入池 | 白名单 × 交易所别名；24h 成交额 ≥ `OI_EQUITY_MIN_TURNOVER_USD`；**无 OI 可入池** |
| 刷新 | `OI_EQUITY_SCAN_INTERVAL_SEC`（默认 300s），与主环错峰 |
| 形态 | `OI_EQUITY_KLINE_INTERVALS`（默认 1h/4h）；禁用 oi异动/V*/连续插针/moonshot |
| 时段 | `OI_EQUITY_SIGNAL_SESSION_ONLY=1` 时非美股时段只更新图表，不 `record_alert` |
| TG | 默认关 `OI_EQUITY_CARD_TELEGRAM` |

---

## 7. 潜力暴涨漏斗（占 watchlist 槽）

- 宇宙：默认雷达 `TOP_N`，非全市场（`OI_MOONSHOT_FULL_SCAN=0`）。
- A 池慢环 1h；B/C 随形态 15m 更新。
- **状态机**占槽：`COMPRESS` → 蓄势 B → C 放量 → `FIND_TOP` / `INVALID`。
- 详见 [signal-logic.md §11](./signal-logic.md#11-潜力暴涨漏斗abc)。

---

## 8. TradingView 多榜 CDP 监听

- 条件：矩阵 **≥4 榜** 同时出现（`tv_alert_sync.py`）。
- 动作：Playwright CDP `:9222` 为币创建 **15m + 1h** TV 提醒（与 OI 形态 watchlist 独立任务）。

---

## 9. 配置速查

| 变量 | 含义 |
|------|------|
| `OI_PATTERN_WATCH_MAX` | watchlist 硬上限 |
| `OI_PATTERN_WATCHLIST_REFRESH_SEC` | 热榜刷新间隔 |
| `OI_PATTERN_MULTI_BOARD_MIN` | OI 异动多榜最少榜数 |
| `OI_PATTERN_OI_AMPLIFY_PCT` | OI 放大阈值 |
| `OI_CANDLE_CARD_*` / `MAIN_CARD_*` | 卡片与 MAIN 主流/周期/TopN |
| `OI_EQUITY_*` | 币股池 |
| `OI_MOONSHOT_*` | 漏斗 |

完整列表见仓库 `discord-collector/.env.example` 中 `OI_` 段。

---

## 10. 相关文件

| 内容 | 路径 |
|------|------|
| 分层池 | `radar.py` → `build_tier_pool` |
| watchlist / 卡片任务 | `pattern_monitor.py` |
| watch 持久化 | `pattern_state_tracker.py` · `data/pattern_state.db` |
| MAIN 白名单 | `focus_symbols.py` · `main_card_policy.py` |
| 币股 | `equity_pool.py` · `equity_pattern.py` · `radar._equity_loop` |

信号如何判定、如何推送、如何进胜率列表 → [signal-logic.md](./signal-logic.md)。
