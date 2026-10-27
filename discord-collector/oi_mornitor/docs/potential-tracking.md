# 潜力发现 · 一周跟踪（复盘用）

## 目的

潜力扫描（五模型）负责**发现**候选；本模块在信号入选时写入快照，并在默认 **7 天**窗口内记录走势，用于事后修正模型与阈值。**不触发下单**，与实盘执行解耦。

## 数据流

```
潜力扫描命中 → register_model_signal（快照 + 开跟踪窗）
       ↓
每轮扫描末尾 → run_potential_checkpoint_pass（+1d/+3d/+7d）
       ↓
窗满或同模型新信号覆盖 → run_potential_outcome_pass 终点结算
       ↓
oi_mornitor/data/potential_outcomes.json
       ↓
GET /api/potential-tracking · 形态页「潜力发现」列表 outcome 字段
```

## 入选快照（`snapshot`）

- 模型、方向、周期、阶段、评分与 `score_reasons`
- 关键因子摘要：`oi_chg_pct`、`fund_pctile`、`vol_z` 等（见 `potential_outcome_tracker._snapshot_from_result`）

入场价在首次检查点或满窗结算时，用信号 K **收盘价**（与 `potential_outcome_eval` 一致）。

## 检查点与满窗

| 时点 | 含义 |
|------|------|
| +1d / +3d / +7d | 自 `signal_time_ms` 起算，到达后写入 `return_pct`（窗内终点盈亏）、`mfe_pct`、`mae_pct` |
| 满窗 | `OI_POTENTIAL_TRACK_DAYS`（默认 7）× 24h，整窗 MFE/MAE 与 `end_pnl_pct` |

K 线粒度默认 `15m`（`OI_POTENTIAL_OUTCOME_KLINE_IV`）。

## 「符合预期」口径（满窗结算）

可环境变量调参，代码默认：

- **多/空**：`end_pnl_pct ≥ OI_POTENTIAL_TRACK_EXPECT_MIN_RETURN_PCT`（默认 1.5%）且 `max_drawdown_pct ≤ OI_POTENTIAL_TRACK_EXPECT_MAX_MAE_PCT`（默认 8%）
- **neutral**：`max_profit_pct` 达最小收益门槛，且 MAE 不超过上限

实现：`potential_outcome_expect.evaluate_track_expectation`。

## 与发现列表解耦

`OI_POTENTIAL_TRACK_DECOUPLE_DISCOVERY=1`（默认）：币从扫描列表离池或进入 `exiting` **不会**缩短 7 天窗；仅「同模型新 K 线信号」会提前结案（`renewed`）。设为 `0` 可恢复旧行为（衰竭/离池提前结算）。

## 环境变量（须在 `.env` 中显式默认时见 `.env.example`）

| 变量 | 默认 | 说明 |
|------|------|------|
| `OI_POTENTIAL_OUTCOME_ENABLED` | 1 | 总开关 |
| `OI_POTENTIAL_TRACK_DAYS` | 7 | 跟踪天数 |
| `OI_POTENTIAL_TRACK_CHECKPOINT_DAYS` | 1,3,7 | 检查点日序 |
| `OI_POTENTIAL_TRACK_DECOUPLE_DISCOVERY` | 1 | 跟踪与发现解耦 |
| `OI_POTENTIAL_TRACK_EXPECT_MIN_RETURN_PCT` | 1.5 | 预期最小收益 % |
| `OI_POTENTIAL_TRACK_EXPECT_MAX_MAE_PCT` | 8 | 预期最大不利波动 % |
| `OI_POTENTIAL_OUTCOME_HOURS` | （空） | 若设置则覆盖天数换算的小时数 |

## 本地验证

```bash
cd discord-collector
# 单测
python -m unittest oi_mornitor.tests.test_potential_outcome -v

# 跑一轮扫描 + 检查点/结算（需能访问币安合约 K 线）
pnpm run oi:potential-scan

# 查看历史
curl -s http://127.0.0.1:8765/api/potential-tracking | jq '.items[:3]'
```
