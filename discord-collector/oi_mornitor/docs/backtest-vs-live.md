# 回测 vs Live 对齐说明

本文档记录 `structure_backtest` / `pattern_settle` 与 Live 形态卡片（`pattern_monitor`）、胜率库（`pattern_alert_stats`）、Bitget 执行之间的差异及修复状态。

## 差异总表

| 维度 | Live（实盘/胜率库） | 回测（修复前） | 修复后 |
|------|---------------------|----------------|--------|
| 信号检测 | `find_last_closed_*` + `structure_volume_confirmed` + `signal_policy` 停推 | `iter_candle_card_hits_in_range` / `detect_structure_events`，无结构量能二次过滤 | 结构信号增加 `structure_volume_confirmed`；停推类型经 `pattern_emit_gate` 统一 |
| 统一门控 | `passes_push_mtf_gate` + `is_blocked_stats_record`（TG/入库） | 扫描期未做 MTF≥2 | `passes_backtest_emit_gate`：按 `signalAt` 升序重放 peers（`OI_BT_APPLY_EMIT_GATE`） |
| signalAt | `resolve_signal_at_from_alert` → 下一根 5m open | 已用 `align_signal_at_ms` | 不变 |
| 入场价 | 告警 `price/close`（确认柱收盘附近市价） | 确认柱 **收盘** | 默认 **下一根开盘价** + 滑点（`OI_BT_ENTRY_MODE=next_bar_open`，`OI_BT_SLIPPAGE_PCT`） |
| SL/TP | `build_settle_plan`：invalid/ATR/cap + SL 地板 0.8%/0.4% | 同 `settle_signal_by_5m_bars` | 同；回测写入 `slPrice`/`tp1Price` |
| 结算步进 | 前端 `settleAlertByKlines`：5m 聚合为 15m | 始终 15m 聚合 | 默认 **5m 逐步**（`OI_BT_SETTLE_FINE_BARS`），同柱 **SL 优先** |
| TP1 保本 | Bitget staged：TP1 后 SL→入场 | 无 | `OI_BT_BREAKEVEN_AFTER_TP1`：TP1 后抬 SL 至 entry |
| 手续费/滑点 | 胜率库 `movePct` 为标的价格变动%（不含费） | 无 | 回测 `netMovePct`/`pnlPct` 扣双边 `OI_BT_FEE_PCT`（默认 0.06）+ 滑点 |
| 观察档 | 入库可带 `observation_only`，汇总排除 | 未排除 | `passes_backtest_emit_gate` 排除观察档 |
| dedupe / 冷却 | `_card_seen` + `_card_last_emit` | `CardFunnelState`（liveFunnel） | 仍按任务顺序扫描；**MTF 门控**改为时间序重放（见下） |
| 山寨池 | flow / dip 分池 + MAIN 币股 | 日线 alt union + K 线近似 | 仍近似；有 `pool_rows` 时与 radar 一致 |
| 1h HTF 趋势 | `htf_trend_gate_ok`（射击之星） | `iter_candle_card_hits` 未走 HTF | **仍近似**（历史扫描未拉 4h/1d）；小范围 fixture 测试覆盖单路径 |
| 并发持仓/日 cap | Bitget/卡片执行层 | 无 | 纸面回测仍 **不模拟** 持仓上限 |
| 资金费率 | 交易所实时 | 无 | 未建模（可选后续） |
| 标的池 survivorship | 当日 Top200 / pool 快照 | 本地 universe 或 Bybit 快照 | `resolve_backtest_symbols` 行为不变 |

## 共享模块（避免漂移）

| 模块 | 用途 |
|------|------|
| `pattern_emit_gate.py` | TG、`record_alert_from_push`、回测统一门控 |
| `pattern_entry.py` | Live 入场解析 + 回测 next-bar-open |
| `pattern_settle.py` | 5m 步进、SL 优先、TP1 保本、成本参数 |
| `pattern_settle_profile.py` | SL/TP/核实窗 V2 |
| `backtest_trade_config.py` | `OI_BT_*` 环境变量默认值 |
| `backtest_metrics.py` | 期望 R、PF、最大连亏、回撤、三维分组 |

## 环境变量（空/非法 → 默认）

| 变量 | 默认 | 说明 |
|------|------|------|
| `OI_BT_FEE_PCT` | `0.06` | 单边手续费 % |
| `OI_BT_SLIPPAGE_PCT` | `0.03` | 单边滑点 % |
| `OI_BT_ENTRY_MODE` | `next_bar_open` | 或 `bar_close` |
| `OI_BT_SETTLE_FINE_BARS` | `true` | 5m 步进结算 |
| `OI_BT_BREAKEVEN_AFTER_TP1` | `true` | TP1 后 SL→成本 |
| `OI_BT_APPLY_EMIT_GATE` | `true` | 回测应用 MTF/停推门控 |

Python 读取：`oi_mornitor/env_parse.py` + `backtest_trade_config.py`。  
Node 镜像默认：`src/env-defaults.js` 中 `oiBacktestFeePct()` 等。

## 本地校验

### 单元测试（无需外网）

```bash
cd discord-collector/oi_mornitor
python -m pytest tests/test_backtest_live_parity.py tests/test_pattern_signal_quality.py -q
```

### 回测 vs 胜率库重叠窗口

```bash
cd discord-collector/oi_mornitor
python scripts/compare_backtest_live_stats.py \
  --stats data/pattern_alert_stats.json \
  --job-id <structure_backtest_job_id> \
  --start-ms 1700000000000 --end-ms 1701000000000
```

输出：信号 key 匹配率、 outcome 一致率。需要本地 `data/pattern_alert_stats.json` 与已完成的结构回测 job 快照；云端可能因 Binance 451 / 无数据而跳过拉 K 线。

## 结算 walk 版本（`settleVersion`）

| settleVersion | 含义 |
|---------------|------|
| 2 | 旧：5m 聚合为 15m 步进，无 TP1 保本 |
| 3 | 新：5m 逐步、同柱 SL 优先、TP1 后 SL→成本（对齐 Bitget staged） |

**影响范围**

- **浏览器 Live 核实**：仍走前端 `settleAlertByKlines`（15m 聚合）；与 Python v3 可能略有差异，直至前端同步。
- **Python**：`pattern_settle.settle_signal_batch`、结构回测、**仅 `outcome=pending` 的** `pattern_settle_recalc` 使用 v3；已结算记录 **不会** 被重算覆盖。
- 新写入的结算结果带 `settleVersion=3`；汇总胜率时请按版本分层，避免与旧库静默混算。

环境变量：`OI_PATTERN_SETTLE_FINE_BARS`、`OI_PATTERN_SETTLE_BREAKEVEN_TP1`（默认开）。

## 共振分与回测双口径

- 全量信号：`job.summary`（通过基础门控 + 已结算）
- **实际会推 TG**：`job.pushed_summary`（`confluenceWouldPush`，门槛 `OI_CONFLUENCE_PUSH_MIN_TIER`，默认 B+）
- 胜率入库：`pattern_emit_gate.ingest_live_pattern_alert`（扫描侧）；TG 推送：`would_telegram_push` / `telegram_push_allowed_or_record_observation`

## 已知残余偏差

1. 回测按 `(symbol, interval)` 任务顺序扫描，dedupe 顺序与 Live 单轮 `scan_ts` 全市场扫描可能略有不同；MTF 门控已按时间序重放修正。
2. 山寨 flow/dip 分池、1h HTF、倒锤子/MAIN 镜像量能路径未完全历史复刻。
3. Bitget 强平/补挂失败/裸仓处置不在纸面结算内；仅 TP 阶梯 + TP1 保本 + 成本近似执行层。
