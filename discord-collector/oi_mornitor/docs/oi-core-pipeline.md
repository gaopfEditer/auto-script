# OI 核心管线总览（方案1）

> **角色**：说明 `oi_mornitor` 如何把 **形态 / 量能 / OI / 共振** 当作因子，经 **硬门禁 + LLM 第二审判** 后进入「形态信号列表」与纸面结算。  
> **非目标**：不自动 Bitget 实盘下单；完整 TradingAgents 图不在实时扫描内运行。

## 分层模型

| 层级 | 名称 | 输入 | 输出 | 主要模块 |
|------|------|------|------|----------|
| **L0** | 因子扫描 | K 线、OI 雷达、量能、结构 | 候选 `alert` 字典 | `pattern_monitor.py`、`strategy/candle_signals.py`、`strategy/structure_signals.py`、`radar.py` |
| **L1** | 列表硬门禁 | 候选 alert | 是否允许入库/展示 | `pattern_emit_gate.py`、`pattern_stats_admission.py`、`signal_policy.py`、`pattern_push_gate.py` |
| **L2** | 第二审判 | B 档及以上候选 + 因子快照 | `gate_result` + LLM `action` | `ai_judge_bridge.py`、`pattern_second_trial.py` → **ezcoin-adapter**（默认 `http://127.0.0.1:5179`） |
| **L3** | 组合风控 | — | — | **未实现**（预留） |

纸面结算（V2）在入库之后独立运行：`pattern_settle_profile.py` / 前端 `patternAlertWinRate.ts`，与是否实盘无关。

## 端到端数据流（Live）

```
pattern_monitor 扫描
  → alert（L0 因子）
  → passes_pattern_card_emit_gate + passes_stats_admission（L1）
  → attach_confluence（共振分 / 档）
  → evaluate_second_trial（L2，仅 B 档及以上且开启时调 adapter）
  → record_alert_from_push + ticker（列表 + 胜率库）
  → 前端核实 / apply_settle_updates 回写 outcome
```

Telegram 推送仍走 `telegram_push_allowed_or_record_observation`（含 MTF 等），与胜率「正式行」判定相互独立但因子同源。

## 雷达异动历史（L0 旁路 · 仅展示/回看）

与形态 L1/L2 **独立**：热钱雷达每轮 `scan_once` 仍只反映**当前池**状态；同时把命中事件写入历史，供页面回看约 **4 小时**（默认）。

| 类型 | 含义 | 写入时机 |
|------|------|----------|
| **OI 异动** | 5m/15m OI 达阈值（与 `AlertFeed` 派生口径一致） | 每轮扫描对全池评估行 upsert |
| **价格异动** | 5m/15m 价变达 `OI_PRICE_SPIKE_PCT_*` | 同上 |
| **榜单异动** | 价格/OI/合约流入流出 Top N **新进入**榜单 | 与上一轮 Top 集合 diff |

- **模块**：`radar_anomaly_history.py`（`ingest_radar_scan` 由 `radar.py` 扫描末尾调用）
- **存储**：`oi_mornitor/data/radar_anomaly_history.json`（进程内存 + 落盘；过期按 `last_seen_ts` 清理）
- **API**：`GET /api/snapshot` → `radar_anomaly_history`（`oi_price` + `board` + `retention_sec`）
- **前端**：`AlertFeed` 合并服务端历史 + 本地缓存 + 本轮 live；筛选 **全部 / OI / 价格 / 榜单**
- **与实时关系**：Toast / `hot_tickers` 仍是瞬时告警；历史流用于「这段时间发生过什么」，不触发下单

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `OI_RADAR_ANOMALY_RETENTION_SEC` | `14400`（4h） | OI/价格/榜单统一保留时长 |
| `OI_RADAR_ANOMALY_MAX_ITEMS` | `600` | OI+价格条目软上限 |
| `OI_RADAR_BOARD_HISTORY_MAX` | `400` | 榜单事件软上限 |
| `OI_RADAR_BOARD_TOP_N` | `7` | 与矩阵榜 Top 7 对齐 |

## 正式行 vs 观察档

| 条件 | 列表 | 纸面结算 | 头条胜率 | UI |
|------|------|----------|----------|-----|
| 未过 L1（停推类型、冷却、T3·15m MA144 等） | 通常不入库 | — | — | — |
| 共振 **C** 或 `confluence_observation_only` | 入库 | 正常 | **不计** | 灰显 |
| 共振 **B+** 但 L2 未过（门禁拒 / LLM 非 LONG·SHORT / adapter 不可达） | 入库 | 正常 | **不计** | 灰显，`second_trial_observation_only` |
| 共振 **B+** 且 L2 `formal=true` | 入库 | 正常 | **计入** | 正常 |
| `OI_SECOND_TRIAL_ENABLED=0` | 同旧口径：B+ 即正式（仅 L1） | 正常 | B+ 计入 | 正常 |

L2 正式默认要求（`OI_SECOND_TRIAL_ENABLED=1` 时）：

1. `gate_result == pass`（ezcoin-adapter 硬门禁）  
2. LLM `action ∈ OI_SECOND_TRIAL_FORMAL_ACTIONS`（默认 `LONG,SHORT`）  
3. 已实际调用 LLM（默认 **t1/t2** 调模型；**t3** 默认不调 LLM → 不能升为正式行，除非 `OI_SECOND_TRIAL_T3_LLM_SAMPLE_PCT>0` 命中采样）

adapter **不可达**时：`gate_result=unavailable`，**降级观察**，不假装过审。开发可设 `OI_SECOND_TRIAL_BYPASS=1`（默认关）。

去重主键（胜率 / ticker）：`type:symbol:kline_close_time:kind:side`（`pattern_alert_stats.alert_stats_key`）。

## 模块索引

| 路径 | 职责 |
|------|------|
| `pattern_monitor.py` | 扫描蜡烛/结构/MA144 等，调用 `ingest_live_pattern_alert` |
| `pattern_emit_gate.py` | 统一入库门控 + 第二审判编排 |
| `pattern_stats_admission.py` | 冷却、反向锁、T3·15m MA144、观察档判定 |
| `pattern_alert_stats.py` | 胜率库、结算回写（禁止无 admission 插条） |
| `ai_judge_bridge.py` | `build_ezcoin_snapshot` / `call_adapter_judge` |
| `pattern_second_trial.py` | `evaluate_second_trial`、LLM 配额与去重 |
| `server.py` | `GET/POST /api/ai-judge/backtest-btc` 探针 |
| `ezcoin-adapter`（独立进程，默认 **5179**） | 硬门禁 + slim 5 席 LLM |

## 回测 vs AI 探针

| 入口 | 用途 |
|------|------|
| 前端 `/backtest` + `/api/backtest/structure/*` | **结构回测**：历史 K 线、形态命中、分组胜率（规则门控，默认不走 L2） |
| `/api/ai-judge/backtest-btc` | **AI 探针**：固定 BTC 快照调用 adapter，验证联通与延迟，不是全历史回测 |

## 关键环境变量（空/非法 → 代码默认）

| 变量 | 默认 | 说明 |
|------|------|------|
| `OI_SECOND_TRIAL_ENABLED` | `1` | 关则 L2 跳过，B+ 即正式 |
| `OI_SECOND_TRIAL_BYPASS` | `0` | 仅开发：跳过 adapter |
| `OI_EZCOIN_ADAPTER_BASE_URL` | `http://127.0.0.1:5179` | adapter 根地址 |
| `OI_EZCOIN_ADAPTER_JUDGE_PATH` | `/api/judge` | 裁决 POST 路径 |
| `OI_EZCOIN_ADAPTER_TIMEOUT_SEC` | `8` | 超时秒 |
| `OI_SECOND_TRIAL_FORMAL_ACTIONS` | `LONG,SHORT` | 升为正式行的 action |
| `OI_SECOND_TRIAL_LLM_MAX_TIER` | `t2` | t1/t2 调 LLM；t3 默认不调 |
| `OI_SECOND_TRIAL_T3_LLM_SAMPLE_PCT` | `0` | t3 随机采样 LLM 比例 % |
| `OI_SECOND_TRIAL_DEDUPE_TTL_SEC` | `900` | 同 key 去重 adapter 调用 |
| `OI_CONFLUENCE_PUSH_MIN_TIER` | `B` | 共振正式档 |
| `OI_PATTERN_STATS_COOLDOWN_SAME_BARS` | `4` | 同向冷却 |
| `OI_PATTERN_STATS_COOLDOWN_OPPOSITE_BARS` | `6` | 反向锁定 |

形态因子与列表收紧的其余变量见 [signal-logic.md](./signal-logic.md)。

## TradingAgents 关系

- 完整 **TradingAgents** 仓库在本机旁路研究，**不**接入 `pattern_monitor` 全市场扫描。  
- 线上 **slim 5 席** 逻辑由 **ezcoin-adapter** 提供；`ai_judge_bridge` 只传 snapshot JSON，不传 API Key（密钥仅在 adapter 进程配置）。

## 运维检查

```bash
# adapter 探针（需 adapter 已启动）
curl -s http://127.0.0.1:8765/api/ai-judge/backtest-btc | jq .

# 形态 unittest（含第二审判 mock）
cd discord-collector && PYTHONPATH=. python3 oi_mornitor/tests/test_pattern_second_trial.py
```

历史双 key 合并：`python3 oi_mornitor/scripts/merge_pattern_alert_stats_keys.py --dry-run`
