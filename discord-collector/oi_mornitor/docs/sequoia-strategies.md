# Sequoia 策略（加密 + 美股合约）

把 Sequoia-X 选股思路接到 `oi_mornitor` 的**形态+量能**旁路：同一套 `strategy_sequoia` 信号参数，**币圈 / 美股合约**分轨道回测与胜率统计。实盘扫描默认关；**不推 Telegram**。

检测后可在**加密所**开对应 USDT 本位美股/ETF 杠杆合约（`equity_pool` 白名单符号）。

## 双轨道默认（务必分开）

| 轨道 | `--track` | 宇宙 | 固定止损 | 报告杠杆 |
|------|-----------|------|----------|----------|
| 币圈 | `crypto` | BTC/ETH + 主流山寨 | **5%** | **20x** |
| 美股合约 | `us_equity` / `us` | `equity_pool` 白名单 ∩ 本地 parquet | **5%** | **10x** |

环境变量：`OI_SEQUOIA_BT_SL_PCT` / `OI_SEQUOIA_BT_LEVERAGE`（币）；`OI_SEQUOIA_BT_US_SL_PCT` / `OI_SEQUOIA_BT_US_LEVERAGE`（美）。


## 币圈 filtered 档案（`--profile filtered` / `--filter leaders_htf`）

在 **不改动** 默认 `--track crypto`（28 主流 · 20x）的前提下，可切到过滤档案做一次对照回测：

| 项 | 规则 |
|----|------|
| 宇宙 | `leaders_BTC_ETH`（仅 BTCUSDT + ETHUSDT） |
| HTF 确认 | 仅当最近已收盘 **4h close > SMA(20)** 时放行 1h 多头信号 |
| 入场 / 止损 | 仍为信号下一根 1h open；**5% 固定 SL**；超时约 5 根（与 baseline 同） |
| 冷却 | 同币同向 **12h** 内不重复开仓 |
| 量能 | `volume < 1.0 × vol_sma20` 视为缩量，丢弃该突破/信号 |
| 报告杠杆 | **5x**（示意 DD×5、100 元保证金盈亏）；非 20x |

实现：`strategy_sequoia/filters.py` + `run_sequoia_pipeline(profile=...)`；落盘目录 `data/sequoia_backtest/crypto_filtered/`，避免覆盖 baseline 的 `crypto/latest_summary.json`。

```bash
# 过滤档案（5x · BTC/ETH · HTF/冷却/缩量）
./oi_mornitor/venv/bin/python oi_mornitor/scripts/run_sequoia_backtest.py \
  --track crypto --profile filtered --mode both --interval 1h

# 等价别名
./oi_mornitor/venv/bin/python oi_mornitor/scripts/run_sequoia_backtest.py \
  --track crypto --filter leaders_htf --mode both --interval 1h

# baseline 仍可用
./oi_mornitor/venv/bin/python oi_mornitor/scripts/run_sequoia_backtest.py \
  --track crypto --mode both --interval 1h
```

## 策略 ID

| ID | typeLabel | 摘要 |
|----|-----------|------|
| `turtle_trade` | 海龟突破·多 | N 高突破 + 量能 + 阳线 |
| `ma_volume` | 均量金叉·多 | 均线金叉 + 放量 |
| `high_tight_flag` | 高紧旗形·多 | 拉升后窄幅缩量 |
| `limit_up_shakeout` | 大阳洗盘·多 | 大阳后阴线守前收 |
| `uptrend_limit_down` | 趋势恐慌阴·多 | 趋势中恐慌放量阴 |
| `rps_breakout` | 相对强度突破·多 | RPS 高分位 + 近高点 |

## 胜率 / 流水线

1. Alert：`sequoia_card` + `type_label`（`strategy_sequoia.bridge`）
2. 持久化回测：`backtest.sequoia_pipeline.run_sequoia_pipeline(track=...)`
   - 入场：`next_bar_open` + `OI_BT_*` 成本
   - 结算：`settle_signal_by_5m_bars` + **显式固定 SL%**（默认 5）
   - 汇总：`summarize_backtest_extended`
   - 落盘：`data/sequoia_backtest/<track>/`
3. 可选入库：`--record-stats` → `pattern_alert_stats`（仍不推 TG）
4. 快速对照：`--mode fixed`（固定止损 + `hold_bars` 超时，无 BE/trail）

### 杠杆示意

- 保证金盈亏（元）≈ `价格涨跌% × 轨道杠杆 × 保证金(默认100)`
- `maxDD% × 杠杆 ≥ 100%` → `blowup_risk`（示意打穿；未模拟强平引擎）
- 胜率库原生 `pnlPctLive` 仍可能是 BTC 100x / 山寨 20x；**报告统一用轨道杠杆**（币 20 / 美 10）

## K 线

- 首选 `data/backtest_klines`（常链到 RamDisk）
- 空则自动回退 `data/backtest_klines.ssd-bak/parquet/`
- 美股宇宙：`strategy_sequoia/universe.py` ← `equity_pool` 别名 + 本地有 1h/5m 的合约（如 `NVDAUSDT`、`QQQUSDT`、`AMDSTOCKUSDT`）

默认 TF：**1h**。

## 怎么跑

```bash
cd /Users/maotouying/frontend/code/1.operations/auto-script/discord-collector

# 币圈：5% SL · 20x 示意
./oi_mornitor/venv/bin/python oi_mornitor/scripts/run_sequoia_backtest.py \
  --track crypto --mode both --interval 1h

# 美股合约：5% SL · 10x 示意
./oi_mornitor/venv/bin/python oi_mornitor/scripts/run_sequoia_backtest.py \
  --track us_equity --mode both --interval 1h

# 两轨一次跑完
./oi_mornitor/venv/bin/python oi_mornitor/scripts/run_sequoia_backtest.py \
  --track both --mode pipeline --interval 1h

# 仅快速固定止损矩阵
./oi_mornitor/venv/bin/python oi_mornitor/scripts/run_sequoia_backtest.py \
  --track crypto --mode fixed --stop 5 --hold-bars 5
```

API：

```python
from oi_mornitor.backtest import run_sequoia_pipeline, track_defaults

print(track_defaults("crypto"))     # sl=5, lev=20
print(track_defaults("us_equity"))  # sl=5, lev=10
run_sequoia_pipeline(track="crypto")
run_sequoia_pipeline(track="us_equity")
```

与 `run_three_way_backtest`（OI 三路）并行不互斥；Sequoia 结果在 `data/sequoia_backtest/`。

## 代码位置

| 路径 | 作用 |
|------|------|
| `strategy_sequoia/` | 信号、桥接、扫描 |
| `strategy_sequoia/universe.py` | 币/美宇宙 |
| `backtest/sequoia_pipeline.py` | 持久化流水线 |
| `backtest/strategies.py` | `fixed_stop_only` |
| `equity_pool.py` | 美股白名单 / 别名 |
| `scripts/run_sequoia_backtest.py` | CLI |
| `data/sequoia_backtest/<track>/` | job 落盘 |
