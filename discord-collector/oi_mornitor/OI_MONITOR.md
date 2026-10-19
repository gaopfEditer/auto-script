# OI Monitor 综合说明（实时热钱雷达）

> **关系说明（请先读）**
>
> | 文档 | 角色 |
> |------|------|
> | **本文 `OI_MONITOR.md`** | **实时 OI 异动主文档**：数据源 → 缓存/差分 → 信号字段 → 告警冷却 → `/api/hot` / SSE / Toast / 可选 webhook；**§9 OI异动共识与特征；§10 三层入场逻辑**（OI×价四象限）。以 `config.py` 当前默认值为准。 |
> | [`docs/signal-logic.md`](docs/signal-logic.md) | 形态/蜡烛/结构/Vegas/胜率/TG 卡片等**全业务信号**；其中 §5.1「OI 热钱」仅摘要，细节以本文为准。 |
> | [`docs/coin-capture.md`](docs/coin-capture.md) | **币种如何进池**：分层池、形态 watchlist、MAIN/币股/TV；不展开 OI 差分与冷却状态机。 |
> | [`docs/backtest-vs-live.md`](docs/backtest-vs-live.md) | 回测 vs Live 对齐（与热钱告警无直接关系）。 |
> | [`README.md`](README.md) | 安装启动、API 速查；**环境变量表部分已过时**，阈值请以本文 / `config.py` 为准。 |
> | [`SIGNAL_LOGIC.md`](SIGNAL_LOGIC.md) | 仅跳转到 `docs/`，勿再编辑。 |
>
> 实现权威：`radar.py`（`BinanceOIRadar` / `RadarService`）、`config.py`、`server.py`、`exchange_sources.py`、`rank_metrics.py`、`market_matrix.py`、`market_snapshot.py`。`notify_telegram.py` **不推送纯 OI 热钱**（TG 用于形态/结构卡片等）。

---

## 1. 一页总览：数据 → 信号 → 触发 → 推送

```
交易所 REST（默认备选所优先：Bybit→OKX→Bitget→Gate；可选币安优先）
  ticker/24hr + openInterest
       │
       ▼
build_tier_pool：OI×价 → heavyweight / midweight；TOP_N 截断 → pool
       │
       ▼  每 SCAN_INTERVAL_SEC（默认 150s）RadarService.scan_once
OIRadarCache（分钟级 deque）差分 → 5m/15m（及 30m~1d 榜单用）
       │  POLL_5M_SEC / POLL_15M_SEC 门控评估
       ▼
阈值：|ΔUSD|≥OI_USD_LIMIT 或 |Δ%|≥OI_PCT_LIMIT
  + 脏点清洗（OI_DELTA_MAX_PCT_*）
  + AlertCooldownStateMachine（冷却 / 反转 / 15m 升级）
  + Z-Score 历史异常（individual_strength_score / is_historic_anomaly）
  + global_intensity_rank / global_volume_rank
       │
       ▼
is_alert=True → hot_tickers（_last_hot）
       │
       ├─ GET /api/hot 、 GET /api/snapshot.hot_tickers
       ├─ SSE GET /api/stream（整包 snapshot，含 hot_tickers）
       ├─ 前端 ToastStack + AlertFeed（雷达页；会话内按 symbol 永久 seen）
       ├─ pattern_monitor：OI 异动 ∩ 多榜 / amplify → 形态 watchlist
       └─ 可选 scripts/grok_oi_webhook_forward.py → 外部 webhook
            （内置 Telegram 对纯 OI 热钱：否）
```

---

## 2. 数据源与候选池

### 2.1 主路径（`BinanceOIRadar.get_active_market_pool`）

| 优先级 | 行为 |
|--------|------|
| **默认** | `OI_USE_BINANCE_POOL_FIRST` 未开（默认 `0`）→ **先走备选所** `exchange_sources.fetch_fallback_feed`（顺序 `OI_FALLBACK_SOURCES`，默认 `bybit,okx,bitget,gate`），一次拿到 ticker + OI，减轻币安 IP 限频。 |
| 备选全空 | 降级币安 `GET /fapi/v1/ticker/24hr`（无 symbol）+ 并发 `openInterest`（`OI_OI_BATCH_CONCURRENCY`，默认 8）。 |
| 币安 418/硬封 | `_mark_binance_banned`，冷却 `OI_BINANCE_BAN_COOLDOWN_SEC`（默认 1800s）内优先备选所。 |
| 强制币安优先 | `OI_USE_BINANCE_POOL_FIRST=1` 时先币安，失败再 fallback。 |

备选所行统一字段：`symbol` / `lastPrice` / `quoteVolume` / `priceChangePercent` / `openInterest`。  
**跨源切换**时 `OIRadarCache` 会清空该币历史（单位/口径常不可比）。

现货 / 合约 **Taker 净流**仍尽量走币安 K 线（`taker_flow.py`）；币安冷却中则用内存缓存，影响 `flow_by_tf` / `rank_by_tf` 主力榜，不阻断 OI 差分告警。

### 2.2 量级分层（`market_snapshot.classify_oi_tier`）

总持仓 USD = `oi_base × last_price`。

| 档位 | 常量 | 默认门槛（`config.py`） |
|------|------|------------------------|
| **大象** `heavyweight` | `OI_TIER_HEAVY_MIN_USD` | ≥ **5000 万** |
| **中场** `midweight` | `OI_TIER_MID_MIN_USD` | ≥ **500 万** 且 &lt; 大象 |
| **排除** | — | &lt; 中场下限 |

池按 OI USD 降序，再 `OI_TOP_N`（默认 **200**，0=不截断）截断为 `pool_rows`。  
稳定币等由 `filter_usdt_perpetuals` / `is_stablecoin_symbol` 过滤。  
**币股池**（`equity_pool.py`）与加密分层并行，不并入 `build_tier_pool`，不计入大象/中场 badge（见 `docs/coin-capture.md`）。

> 注意：部分旧文档仍写「中场 ≥1000 万」；**以 `config.py` 默认 500 万为准**。

### 2.3 采集循环

| 环节 | 周期 / 门控 | 说明 |
|------|-------------|------|
| 主环 `RadarService._loop` | `OI_SCAN_INTERVAL_SEC` 默认 **150** | `scan_once`：池 → OI 评估 → 矩阵 → 突破 → 形态… |
| OI 缓存写入 | 每轮扫描对每个 pool 币 `cache.update` | `OI_CACHE_MAXLEN` 默认 1440（约 24h 分钟点，按扫描节奏实际更稀） |
| 5m 窗口评估 | `OI_POLL_5M_SEC` 默认 **60** | `_poll_flags`：距上次 ≥ 间隔才算 5m 触发候选 |
| 15m 窗口评估 | `OI_POLL_15M_SEC` 默认 **180** | 同上 |
| Z-Score 样本写入 | `OI_5M_RECORD_INTERVAL_SEC` 默认 300 | 每币约每 5 分钟记一次 5m ΔUSD |
| 冷启动 / warming | 历史不足 5m | `status=warming`，`is_hot/is_alert=False`，不参与告警与全局排名 |

---

## 3. 处理管线（单币 `_evaluate_symbol`）

1. 取当前 `OISnapshot(ts, oi_base, price)`。  
2. 用近期锚点 / 窗口上限 **清洗脏历史**（见 §3.1）。  
3. `cache.update` 写入当前点。  
4. 相对 5m / 15m 基线算 `delta_*_usd`、`pct_*`、`pct_price_*`。  
5. 多周期 `oi_by_tf` / `price_by_tf`（5m/15m/30m/1h/4h/1d）。  
6. 若本轮 `eval_5m`：Z-Score + 是否历史异常。  
7. 阈值 → 冷却状态机 → `is_hot` / `is_alert` / `type`。  
8. 全池结束后：`rank_engine.enrich`、`_apply_global_rankings`、`GlobalTrendAuditor.audit`。  
9. `hot_tickers = [r for r in evaluated if r["is_alert"]]`。

### 3.1 脏点 / 口径跳变防护

| 常量 | 默认 | 作用 |
|------|------|------|
| `OI_DELTA_MAX_PCT_5M` | 25 | 5m 窗口 \|Δ%\| 超限 → 差分置 0 / 丢基线 |
| `OI_DELTA_MAX_PCT_15M` | 40 | 15m 同上 |
| `OI_DELTA_MAX_PCT` | 80 | 更长窗口 |
| 近期中位锚点 | — | 相对 anchor 超 5m 上限 → **整币 cache.clear** 重采 |
| ΔUSD 自洽 | — | \|ΔUSD\| 远超「past_oi×现价×pct」→ 丢弃差分 |

ΔUSD 定义：**合约数变化 × 现价**（不计价格自身涨跌对名义的影响）。

### 3.2 关键输出字段（热钱行）

| 字段 | 含义 |
|------|------|
| `pct_5m` / `pct_15m` | OI 变动率 % |
| `delta_5m_usd` / `delta_15m_usd` | OI 变动名义 USD |
| `pct_price_5m` / `pct_price_15m` | 同窗口价变 % |
| `oi_tier` | `heavyweight` / `midweight` |
| `triggered_windows` | 冷却放行后的窗口列表（如 `["5m"]`） |
| `raw_triggered_windows` | 仅过阈值、尚未考虑冷却 |
| `is_hot` | `raw_windows` 非空（含被抑制） |
| `is_alert` | 冷却允许发出 → **进入 hot_tickers** |
| `is_suppressed` | 过阈值但冷却抑制 |
| `alert_reason` | `new` / `cooldown_expired` / `direction_reversal` / `15m_escalation` / `suppressed(...)` |
| `type` | `OI_PUMP` / `OI_DUMP` / `SUPPRESSED` / `NORMAL` / `WARMING` |
| `status` | `pump` / `dump` / `suppressed` / `normal` / `warming` |
| `individual_strength_score` | 5m ΔUSD 相对本币历史的 Z-Score |
| `is_historic_anomaly` | Z &gt; `OI_ZSCORE_THRESHOLD`（默认 3.0）且样本够 |
| `global_intensity_rank` | 全池 \|pct_5m\| 降序排名 |
| `global_volume_rank` | 全池 `current_oi_usd` 降序 |
| `oi_by_tf` / `price_by_tf` / `flow_by_tf` / `rank_by_tf` | 多周期与榜单衍生 |

### 3.3 强度与榜单衍生（非告警门控）

- **告警强度（冷却升级用）**：`intensity = abs(pct)`（5m 或 15m 主候选）。  
- **Z-Score / 历史异常**：`OI5mChangeHistory`，与告警阈值独立；UI 可标 💥。  
- **`rank_by_tf.*.intensity_score`**：`rank_metrics.RankMetricsEngine` — 变动率相对 24h 历史 Z-Score，再在本扫描批次归一化到 0–100（持仓/价格/合约流入/现货等 domain）。  
- **`magnitude_usd`**：OI 为 \|ΔOI\|×价；主力为 Taker 净流等。  
- **四宫格矩阵** `market_matrix`：`oi_pumps` / `oi_dumps` / `top_gainers_oi` / `top_losers_oi`（Top `OI_MATRIX_TOP_N`，默认 7）。  
- **全场 meta**：`global_oi_net_inflow`、`long_short_bias`、`risk_regime`（`risk_on`/`risk_off`/`mixed`），以及 `capital_confluence` / `capital_intensity`（15m 现货+合约合流）。

价格尖刺左栏另用 `OI_PRICE_SPIKE_PCT_5M` / `_15M`（与 OI 告警阈值独立）。

---

## 4. 告警 / 触发规则

### 4.1 阈值

```
triggered ⇔ |delta_usd| ≥ OI_USD_LIMIT  OR  |pct| ≥ OI_PCT_LIMIT
```

| 环境变量 | config 常量 | 默认 |
|----------|-------------|------|
| `OI_USD_LIMIT` | `OI_USD_LIMIT` | **500_000** |
| `OI_PCT_LIMIT` | `OI_PCT_LIMIT` | **2.5** |

5m / 15m 共用同一对阈值；是否评估由 `POLL_*` 门控。

### 4.2 冷却状态机（`AlertCooldownStateMachine`）

`active_alerts[symbol] = AlertRecord(ts, window, direction, intensity)`  
`direction`：`pump`（ΔUSD≥0）/ `dump`。  
主候选：优先 **15m**，再比 intensity。

| 场景 | `should_emit` | `alert_reason` |
|------|---------------|----------------|
| 首次触发 | ✅ | `new` |
| 距上次 ≥ `OI_ALERT_COOLDOWN_SEC`（默认 **300**） | ✅ | `cooldown_expired` |
| 冷却内 **方向反转** | ✅ | `direction_reversal` |
| 冷却内 **15m 同向且 intensity 更高** | ✅ | `15m_escalation` |
| 其余冷却内重复 | ❌ | `suppressed(…)` |

过期记录约在 `2×cooldown` 后 prune。

> `docs/signal-logic.md` §5.1 / 旧 README 仍写冷却 900s：以 **`config.py` 默认 300s** 为准。

### 4.3 `hot_tickers` 定义

仅 `is_alert=True` 的行。`get_hot_tickers()` = 再跑一轮 `scan_once` 后返回该列表。  
被抑制币仍在 `all_tickers` / AlertFeed 侧可显示为抑制态。

### 4.4 与下游的耦合（非 Telegram）

- **形态 watchlist**：`ingest_oi_anomaly_multiboard`（OI 告警/hot 且矩阵 ≥ `OI_PATTERN_MULTI_BOARD_MIN`）；`ingest_oi_amplified`（`|pct|≥OI_PATTERN_OI_AMPLIFY_PCT` 等）。详见 `docs/coin-capture.md`。  
- **equity / capital**：币股独立扫描；`capital_bias` 进 snapshot meta，不单独发 OI Toast。

---

## 5. 输出通道

| 通道 | 路径 / 组件 | OI 热钱 |
|------|-------------|--------|
| REST | `GET /api/hot` | `{ hot_tickers, scan_ts }` |
| REST | `GET /api/snapshot` | 含 `hot_tickers`、`all_tickers`、`meta`、`market_matrix`… |
| SSE | `GET /api/stream` | 周期推送完整 snapshot（间隔 `max(5, SCAN_INTERVAL_SEC)`） |
| 前端 Toast | `ToastStack` | `is_alert`；会话内 **按 symbol 永久 seen**；展示 TTL 12s；最多叠 5 |
| 前端列表 | `AlertFeed` | 合并 live 异动，本地缓存 |
| 矩阵 | `GET /api/matrix` | 四宫格，非 Toast |
| Telegram | `notify_telegram.py` | **不推送纯 OI 热钱**（形态/结构/MAIN/结算等才推） |
| 可选 webhook | `scripts/grok_oi_webhook_forward.py` | 轮询 `/api/hot`，对未见过的 `is_alert`/`is_hot` POST 到 `OI_GROK_WEBHOOK_URL` |

启动：`launcher.py` / `run.py` → `server.main`；`on_startup` 挂后台扫描。

---

## 6. 配置旋钮（OI 热钱相关）

以下默认值来自 **`config.py`（以代码为准）**。完整 `OI_*` 还含形态/沙盒/回测等，见 `.env.example`；此处只列热钱雷达主干。

### 6.1 数据源与池

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `OI_FAPI_BASE_URL` | `https://fapi.binance.com` | 币安 U 本位 |
| `OI_SPOT_BASE_URL` | `https://api.binance.com` | 现货 Taker |
| `OI_BYBIT_BASE_URL` / `OI_OKX_*` / `OI_BITGET_*` / `OI_GATE_*` | 各所公共 API | 备选 |
| `OI_FALLBACK_SOURCES` | `bybit,okx,bitget,gate` | 备选顺序 |
| `OI_FALLBACK_MIN_TICKERS` | 30 | 备选最少 ticker 数 |
| `OI_BINANCE_BAN_COOLDOWN_SEC` | 1800 | 币安封禁冷却 |
| `OI_USE_BINANCE_POOL_FIRST` | `0` | `1`=币安优先（环境变量，radar 内读） |
| `OI_TIER_MID_MIN_USD` | 5_000_000 | 中场下限 |
| `OI_TIER_HEAVY_MIN_USD` | 50_000_000 | 大象下限 |
| `OI_TOP_N` | 200 | 监控池上限，0=不限 |
| `OI_HEAVY_POOL_LIMIT` | 200 | heavy 列表截断 |
| `OI_OI_BATCH_CONCURRENCY` | 8 | 币安 OI 并发 |
| `HTTPS_PROXY` / 代理相关 | — | 国内访问常需 |

### 6.2 阈值、窗口、冷却、清洗

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `OI_USD_LIMIT` | 500000 | ΔUSD 阈值 |
| `OI_PCT_LIMIT` | 2.5 | Δ% 阈值 |
| `OI_PRICE_SPIKE_PCT_5M` | 2.0 | 价尖刺 5m（UI） |
| `OI_PRICE_SPIKE_PCT_15M` | 3.5 | 价尖刺 15m |
| `OI_DELTA_MAX_PCT` | 80 | 长窗脏点上限 % |
| `OI_DELTA_MAX_PCT_5M` | 25 | 5m 脏点上限 |
| `OI_DELTA_MAX_PCT_15M` | 40 | 15m 脏点上限 |
| `OI_SCAN_INTERVAL_SEC` | 150 | 主环周期 |
| `OI_POLL_5M_SEC` | 60 | 5m 评估门控 |
| `OI_POLL_15M_SEC` | 180 | 15m 评估门控 |
| `OI_ALERT_COOLDOWN_SEC` | 300 | 同币告警冷却 |
| `OI_CACHE_MAXLEN` | 1440 | OI 快照 deque 长度 |
| `OI_ZSCORE_HISTORY_LEN` | 288 | Z 历史长度 |
| `OI_ZSCORE_THRESHOLD` | 3.0 | 历史异常门槛 |
| `OI_ZSCORE_MIN_SAMPLES` | 5 | 最少样本 |
| `OI_5M_RECORD_INTERVAL_SEC` | 300 | Z 样本写入间隔 |
| `OI_MATRIX_TOP_N` | 7 | 四宫格条数 |
| `OI_MATRIX_REFRESH_SEC` | 30 | 矩阵刷新意图间隔 |
| `OI_REQUEST_INTERVAL_SEC` | 0.1 | 请求间隔 |
| `OI_HTTP_TIMEOUT_SEC` | 30 | HTTP 超时 |
| `OI_WEB_HOST` / `OI_WEB_PORT` | 127.0.0.1 / 8765 | Web |

### 6.3 形态联动（OI → watchlist）

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `OI_PATTERN_MULTI_BOARD_MIN` | 2 | 异动∩多榜最少榜数 |
| `OI_PATTERN_OI_AMPLIFY_PCT` | 3.0 | OI 放大入池 % |
| `OI_PATTERN_WATCH_MAX` / `OI_PATTERN_AUTO_PICK` | 50 | watchlist 上限 / 热钱挑选 |

### 6.4 可选 Grok webhook 转发

| 环境变量 | 说明 |
|----------|------|
| `OI_HOT_API` | 默认 `http://127.0.0.1:8765/api/hot` |
| `OI_POLL_SEC` | 轮询秒数，默认 3 |
| `OI_GROK_WEBHOOK_URL` / `OI_GROK_WEBHOOK_KEY` | 目标与 Bearer |
| `OI_GROK_ENV` | 可选 config.env 路径 |

---

## 7. 代码地图（热钱）

| 模块 | 职责 |
|------|------|
| `radar.py` | 缓存、评估、冷却、扫描、`get_hot_tickers`、`RadarService` |
| `config.py` | 全部阈值与周期默认值 |
| `exchange_sources.py` | Bybit/OKX/Bitget/Gate 聚合 feed |
| `market_snapshot.py` | tier 分类与 pool_meta |
| `rank_metrics.py` | magnitude / intensity_score |
| `market_matrix.py` | 四宫格 |
| `capital_bias.py` | 合流 / 力度 TopN（meta） |
| `server.py` | `/api/hot`、`/api/snapshot`、`/api/stream` |
| `frontend/.../ToastStack.tsx` | OI Toast |
| `frontend/.../AlertFeed.tsx` | 异动列表 |
| `frontend/.../useRadarSSE.tsx` | EventSource `/api/stream` |
| `scripts/grok_oi_webhook_forward.py` | 可选外送 |
| `launcher.py` / `run.py` | 进程启动 |

---

## 8. 与 README 差异速记（文档债）

| 项 | 旧 README / 部分 docs | 当前 `config.py` |
|----|----------------------|------------------|
| `OI_USD_LIMIT` | 1_500_000 | **500_000** |
| `OI_PCT_LIMIT` | 5.0 | **2.5** |
| `OI_ALERT_COOLDOWN_SEC` | 900 | **300** |
| `OI_TIER_MID_MIN_USD` | 10_000_000 | **5_000_000** |
| `OI_SCAN_INTERVAL_SEC` | 60 | **150** |
| `OI_POLL_5M_SEC` / `_15M` | 300 / 900 | **60 / 180** |
| `OI_OI_BATCH_CONCURRENCY` | 40 | **8** |
| `OI_TOP_N` | 0 | **200** |
| 默认池数据源 | 文档常写币安优先 | **默认备选所优先** |

调参时改环境变量或 `.env`，以进程加载的 `config.py` 为准；改文档请同步本文。

---

## 9. OI异动共识与特征

> **用途**：把 `OI_PUMP` / `OI_DUMP`（只看持仓方向）与同窗口 `pct_price_*`（价变）叠成可读的「资金共识」象限，方便雷达 Toast / AlertFeed / 可选 webhook 解读。  
> **依据**：`radar.py`（`_evaluate_symbol`、`AlertCooldownStateMachine`、`GlobalTrendAuditor`）+ `config.py` 阈值；辅以 2026-10-19 当日 live `/api/hot`、`/api/snapshot` 样本与 webhook `forward_state` 频次。  
> **局限**：系统**不落盘**长期 OI×价四象限历史库；`oi-supervisor.log` 看板只有泵/撤标签无价向；webhook `seen` 仅 `symbol|windows|alert_ts`。下文「历史上」= 当日反复出现的 live/转发样本 + 代码已编码的全场语义；样本不足处已标明。

### 9.1 四象限共识（OI 方向 × 价格方向）

告警类型 **只由 OI Δ 符号决定**（主窗口优先 15m，否则 5m）：

| `type` / `status` | 判定（代码） |
|-------------------|--------------|
| `OI_PUMP` / `pump` | 放行窗口内 `primary_delta > 0`（ΔUSD≥0 → cooldown `direction=pump`） |
| `OI_DUMP` / `dump` | `primary_delta ≤ 0`（`direction=dump`） |

**价向不进 `type`**，读共识必须再看 `pct_price_5m` / `pct_price_15m`（或 `price_by_tf`）。经典衍生品解读与本仓库 `GlobalTrendAuditor` 对齐如下：

| 模式（共识名） | OI | 价 | 市场含义（一句话） | 代码字段对应 | 全场 meta |
|----------------|----|----|-------------------|--------------|-----------|
| **多头加仓** | ↑ | ↑ | 涨价同时开仓增加 → 多头主动建仓 | `OI_PUMP` + `pct_price_*>0` | `long_short_bias.long_build_count++`（仅统计 **OI 过阈值的泵**） |
| **空头加仓 / 空头压制** | ↑ | ↓ | 跌价同时开仓增加 → 空头主动砸盘/加空 | `OI_PUMP` + `pct_price_*<0` | `short_suppress_count++`；主导时常 `dominant=short`、文案「空头主动压制占优」 |
| **空头平仓 / 空头回补** | ↓ | ↑ | 涨价同时持仓减少 → 空头回补推升 | `OI_DUMP` + `pct_price_*>0` | **不计入** long_build/short_suppress（审计只扫 OI 泵） |
| **多头平仓 / 长仓离场** | ↓ | ↓ | 跌价同时持仓减少 → 多头止损/减仓离场 | `OI_DUMP` + `pct_price_*<0` | 同上；常与 `global_oi_net_inflow<0`、`risk_off` 同现 |

价≈0（`pct_price_*≈0`）时共识弱，视为「OI 单边噪音」，勿强行归入四象限。

**当日 live 印象（2026-10-19 约 19:40 CST，阈值附近样本）**：过阈值象限以 **OI↑价↓**、**OI↓价↓** 为主；**OI↑价↑** 偶发（如 ZEC）；**OI↓价↑** 当轮近阈值样本几乎未见。全场 meta 一度为 `short_suppress` 占优 + `risk_off`，与「空头压制 / 多头离场」同向。

### 9.2 每种模式的典型特征

共用门槛（5m/15m 相同）：`|delta_*_usd| ≥ OI_USD_LIMIT(50万)` **或** `|pct_*| ≥ OI_PCT_LIMIT(2.5)`；评估门控 `POLL_5M_SEC=60` / `POLL_15M_SEC=180`。

| 特征维 | 多头加仓 | 空头加仓/压制 | 空头回补 | 多头平仓/离场 |
|--------|----------|---------------|----------|---------------|
| OI 方向 / `type` | ↑ / `OI_PUMP` | ↑ / `OI_PUMP` | ↓ / `OI_DUMP` | ↓ / `OI_DUMP` |
| 价向字段 | `pct_price_5m/15m > 0` | `< 0` | `> 0` | `< 0` |
| 窗口 | 单 5m 多为试探；**5m+15m 同向**更稳 | 同左；15m 同向压制更「共识」 | 相对少见，需 15m 确认 | 熊段常见；大象大额 ΔUSD 即使 \|%\| 小也有信息 |
| 幅度直觉 | 中场 \|%\| 易 ≥2.5%；大象常靠 \|ΔUSD\|≥50万 | 同左；跌中加仓越狠越像压制 | \|ΔUSD\| 大 + 价明显回升 | 中场大跌幅 DUMP（如 \|pct_15m\|≫2.5%）= 撤离加速 |
| 强度排名 | `global_intensity_rank` 靠前（\|pct_5m\| 全池序） | 同左 | 同左 | 同左；极端 DUMP 常占强度榜前列 |
| 档位 `oi_tier` | `heavyweight` 叙事权重大；`midweight` 易「假共识」 | 同左 | 同左 | 中场暴跌 DUMP 噪音比例更高，宜看 ΔUSD |
| 历史异常 | `is_historic_anomaly`（Z>`OI_ZSCORE_THRESHOLD`3.0）多为 **泵侧** 💥 | 同左 | DUMP 的 Z 常为负 | **注意**：代码 `z > threshold` **不含大负 Z**，极端撤离可无 💥（如 Z≪0 仍 `false`） |
| Z 字段 | `individual_strength_score` | 同左 | 同左 | 大负值仍有解读价值，勿只看布尔异常 |

冷却放行原因 `alert_reason`（与象限正交，描述「为何再次弹出」）：

| `alert_reason` | 含义 | 对共识的暗示 |
|----------------|------|--------------|
| `new` | 该币冷却簿无记录 | 初次异动，先看象限再定强弱 |
| `cooldown_expired` | ≥`OI_ALERT_COOLDOWN_SEC`(300s) | 同向叙事可能仍在延续 |
| `direction_reversal` | 冷却内 pump↔dump | **资金方向翻脸**，原象限共识作废/反转 |
| `15m_escalation` | 冷却内同向且 15m intensity 更高 | **短窗升级中窗**，同向共识加强 |
| `suppressed(…)` | 冷却内重复 | 已计过一次，列表可显示但不出 Toast |

### 9.3 强共识 vs 噪音

**更像强共识（由强到弱）**

1. **同向双窗 + 升级**：`triggered_windows` 含 `5m,15m`，且 `alert_reason=15m_escalation`（或刚 `new` 后很快双窗）。  
2. **OI×价同属一清晰象限**，价向与 OI 不同号或同号都「干净」（\|`pct_price_*`\| 不要贴零）。  
3. **大象** `heavyweight` + 大 \|ΔUSD\|（哪怕 \|%\|&lt;2.5% 靠美元门槛触发）— 如主流币反复进出 hot。  
4. **泵侧历史异常**：`is_historic_anomaly=true` 且 `OI_PUMP`（例：HYPE 类 Z≫3）。  
5. **与全场一致**：`meta.long_short_bias` 与个币象限同向（如个币空头压制 + 全场 `short`/`risk_off`）。  
6. **强度靠前**：`global_intensity_rank` 小（前列）且非 warming。

**更像噪音 / 降权**

| 噪音型 | 特征 | 处理建议 |
|--------|------|----------|
| 冷却重复 | `is_suppressed` / `suppressed(Ns/300s)` | 已知情，勿当新共识 |
| 价向贴零 | \|`pct_price_*`\|≈0 | OI 单边，不做四象限结论 |
| 中场暴 %、小名义 | `midweight` + 高 \|%\|、\|ΔUSD\| 刚过线 | 易插针；要 15m 或与矩阵/主流同向再信 |
| 单 5m 闪现 | 仅 `5m`、无 15m、无 escalation | 等待中窗或冷却后再看 |
| 方向反转抖动 | 短时多次 `direction_reversal` | 共识未稳 |
| 脏点边界 | 接近 `OI_DELTA_MAX_PCT_5M/15M`（25/40）被清洗前后 | 口径跳变，勿解读 |
| 主流币「常驻热」 | BTC/ETH 因 \|ΔUSD\| 大高频进 webhook | 看 \|%\|、价向、全场 meta，勿条条当事变 |
| 只看 `type` | 忽略 `pct_price_*` | **一定会误读**（泵含多头加仓与空头压制） |

频次旁证（不足当回测）：当日 webhook `forward_state` 约 **236** 次告警键（约 15:56–19:37 CST），窗口分布约 `5m,15m` 100 / 仅 `15m` 88 / 仅 `5m` 48；头部币 BTC/ETH/ZEC/SOL/XRP/NEAR 反复出现 → 「双窗 + 主流」是默认高频形态，筛选强共识更要靠 **象限清晰度 + escalation/异常**，而非单纯进 hot。

### 9.4 速查表（中文）

| 你看到 | 先当成 | 再确认 |
|--------|--------|--------|
| `OI_PUMP` + 价↑ | 多头加仓 | 双窗？大象？全场 long_build？ |
| `OI_PUMP` + 价↓ | 空头加仓/压制 | 是否 `15m_escalation`？全场 short_suppress？ |
| `OI_DUMP` + 价↑ | 空头回补 | 样本通常少；要 15m 与正价向 |
| `OI_DUMP` + 价↓ | 多头离场 | 中场大跌幅谨慎；看 ΔUSD 与净流出 |
| 仅 `OI_PUMP`/`OI_DUMP` 无价 | **未知共识** | 必须补 `pct_price_*` |
| `SUPPRESSED` | 旧消息回声 | 一般不升维 |
| `is_historic_anomaly` | 泵侧极端 | DUMP 极端可能无此旗标 |

实现索引：`radar.py` → `_evaluate_symbol`（字段组装）、`AlertCooldownStateMachine.evaluate`（冷却）、`GlobalTrendAuditor.audit`（多头建仓/空头压制计数）、`OI5mChangeHistory.z_score_and_record`（Z / 历史异常）。配置默认见本文 §4 / §6。


## 10. 三层入场逻辑

> **目的**：原始 OI 异动（过阈值即告警/`is_alert`）历史上常见**胜率偏低、期望为负**。本章三层过滤器把「热钱异动」收成「可入场信号」：先定性共识，再滤掉量价背离，最后用 K 线形态确认才推送/入场。  
> **回测对比**（修改前 vs 三层过滤后的信号数、胜率、期望）见同文档回测章节（实现后写入；若尚未落库，以当次回测脚本输出为准）。  
> **现网开关**：建议用环境变量控制（如 `OI_ENTRY_FILTER_V2=1` 开启）；默认关闭时行为与原始 OI 告警一致。

### 10.1 总览

| 层级 | 名称 | 作用 | 未通过时 |
|------|------|------|----------|
| L1 | 四个共识分类器 | 给每个 OI 异动打标签（多空建仓/平仓语义） | 仍保留异动，但打上 `consensus` 字段；分类失败则标 `unknown` |
| L2 | 量价背离过滤 | OI 升 + 价格横盘过久 → 降权或剔除 | **不进入 L3**（过滤）或降权后仅作观察 |
| L3 | 形态确认 | 等待射击之星 / 倒锤子 / 吞没 | **超时作废**，不产生有效入场、不推送入场类通知 |

数据流（开启三层时）：

```
OI 异动候选 (5m/15m, OI_PUMP|OI_DUMP)
  → L1 共识标签
  → L2 量价背离检查（不通过则停）
  → L3 进入 wait_pattern；形态命中 → 有效入场信号
  → 超时 → 作废
```

---

### 10.2 第一层：四个共识分类器

**类型**：纯规则，无阈值参数。  
**输入**：同一窗口内的 OI 方向（`OI_PUMP`=升 / `OI_DUMP`=降）与价格方向（`pct_price_5m` 或 `pct_price_15m`，与触发窗口对齐；双窗时优先用与 `window` 一致的价变）。  
**价格符号约定**：`>0` 涨，`<0` 跌，`≈0` 见第二层横盘定义（本层若价变绝对值为 0，可标 `flat` 并交给 L2）。

| 模式 ID | 条件 | 中文名 | 市场解释 |
|---------|------|--------|----------|
| `long_build` | OI↑ 且 价↑ | 多头加仓 | 涨价同时开仓增加，多头主动建仓 |
| `short_build` | OI↑ 且 价↓ | 空头加仓 | 跌价同时开仓增加，空头砸盘加空（亦称空头压制） |
| `short_cover` | OI↓ 且 价↑ | 空头回补 | 涨价同时减仓，空头平仓/回补推升 |
| `long_exit` | OI↓ 且 价↓ | 多头离场 | 跌价同时减仓，多头止损/减仓离场 |

**触发条件**：任意已通过原始 OI 阈值（或回测样本中的异动点）的事件，均应打上上述四类之一（或 `unknown`/`flat`）。  
**过滤条件**：本层**不丢弃**信号，只分类。  
**字段建议**：`consensus` / `consensus_label`（上表中文名）。

---

### 10.3 第二层：量价背离过滤

**目标**：OI 在上升，但价格在**两个连续窗口**内都接近横盘 → 视为无效/弱资金推动，**降权或直接过滤，不进入第三层**。

#### 规则

1. 仅当 L1 显示 **OI 上升**（`OI_PUMP`，含 `long_build` / `short_build` 的 OI↑ 侧）时检查本层。  
2. 「横盘」定义（建议默认，可配置）：

| 参数 | 建议默认值 | 含义 |
|------|------------|------|
| `OI_ENTRY_FLAT_ABS_PCT` | `0.15` | 单窗口 `|pct_price|` ≤ 该值（单位：%）视为横盘 |
| 连续窗口数 | `2` | **5m 与 15m 两个窗口均横盘**，或连续两个同档扫描窗口均横盘（实现二选一，文档与代码须一致；推荐：**5m 与 15m 同时 `|价变|≤阈值`**） |

3. **触发过滤**：`OI↑` 且 `5m`、`15m` 价变均满足横盘 → **过滤（默认）** 或降权（若 `OI_ENTRY_DIVERGENCE_MODE=downweight`）。  
4. **不进入 L3**：过滤模式下该异动到此结束；降权模式可保留观察字段但不发入场推送。

| 参数 | 建议默认 | 说明 |
|------|----------|------|
| `OI_ENTRY_DIVERGENCE_MODE` | `filter` | `filter`=丢弃；`downweight`=保留但降权 |
| `OI_ENTRY_FLAT_ABS_PCT` | `0.15` | 横盘绝对百分比阈值（%） |

**OI 下降**（`OI_DUMP`）不强制走本层背离过滤（横盘减仓另议；默认跳过 L2 进入 L3 或按实现注明）。

---

### 10.4 第三层：形态确认

**目标**：OI 共识且过 L2 后，**不立即入场**；进入等待态，直到 K 线出现下列形态之一才产生**有效入场信号**并推送。

#### 固定形态列表（后续可增删）

| 形态 ID | 中文 | 说明（实现以项目 pattern/candle 模块为准） |
|---------|------|------------------------------------------|
| `shooting_star` | 射击之星 | 上影长、实体小，常见于冲高回落 |
| `inverted_hammer` | 倒锤子 | 下影语境下的倒锤形态（实现按现有检测器） |
| `engulfing` | 吞没 | 阳吞阴或阴吞阳（多空方向宜与 L1 共识同向时加权） |

> 以上三者为 **§10 OI 入场 L3** 固定集合（与 §13 二次预警形态一致：**无大锤子**）。增删时改本表 + allowlist + §0/§13，并更新回测。

#### 状态机

| 状态 | 含义 |
|------|------|
| `wait_pattern` | L1+L2 通过后进入；等待形态 |
| `entry_ready` | 形态命中 → 有效入场，可推送 |
| `expired` | 超时未出现形态 → **作废**，不入场不推送 |

| 参数 | 建议默认 | 说明 |
|------|----------|------|
| `OI_ENTRY_PATTERN_TIMEOUT_SEC` | `900`（15 分钟） | 等待形态超时；也可按 K 线根数 `OI_ENTRY_PATTERN_TIMEOUT_BARS`（如 3 根同周期） |
| `OI_ENTRY_PATTERN_TF` | 与信号窗口对齐（5m 信号看 5m K，15m 看 15m） | K 线周期 |
| `OI_ENTRY_PATTERNS` | `shooting_star,inverted_hammer,engulfing` | 允许形态 allowlist |

**触发有效入场**：`wait_pattern` 期间检测器命中 allowlist 内任一形态。  
**过滤/作废**：超时仍无形态 → `expired`。

**推送策略（建议）**：

- 原始 OI Toast/webhook：可由开关决定是否仍推「热钱异动」。  
- **入场类推送**：仅 `entry_ready` 时发送（与「异动提醒」分离，避免噪声）。

---

### 10.5 与原始逻辑的关系

| 项目 | 原始 OI 异动 | 三层入场 |
|------|--------------|----------|
| 触发 | USD/PCT 阈值 + 冷却等 | 在原始候选之上叠加 L1–L3 |
| 输出 | `hot_tickers` / Toast / 可选 webhook | 另输出 `entry_signal`（或等价字段） |
| 目标指标 | 覆盖率、及时性 | **胜率、期望**（见回测章） |

---

### 10.6 实现与配置索引（供改代码的 bot）

| 项 | 位置（预期） |
|----|----------------|
| 开关 | `OI_ENTRY_FILTER_V2`（0=关，1=开） |
| L1 分类 | 共识函数（可与 §9 四象限一致） |
| L2 横盘 | `OI_ENTRY_FLAT_ABS_PCT`、`OI_ENTRY_DIVERGENCE_MODE` |
| L3 形态 | pattern/candle 检测 + `OI_ENTRY_PATTERNS` + 超时参数 |
| 文档回测 | 同文件「回测」章节：信号数 / 胜率 / 期望，修改前 vs 后 |

**维护约定**：只看本章即可理解三层语义；改阈值或增删形态时同步改参数表与 allowlist，并重跑回测更新结论表。

---



---


---

## 0. 产品策略快照（2026-10-19 通话确认 · 其他 bot 必读）

> 本章覆盖并取代当日口头约定；改行为时同步改本章与实现。

| # | 约定 | 状态 |
|---|------|------|
| 1 | **OI 异动实时预警停用**（webhook / 聊天推送 / 不依赖前端 Toast 的对外告警均停） | ✅ 例程 `oi` 已 pause；`grok_oi_webhook_forward.py` 已停 + `~/.grokbot/oi-webhook/DISABLED` |
| 2 | **OI 数据采集继续**：`run.py --backend-only` 的 `/api/hot` + SSE 照常跑，供观察与回测落盘 | ✅ |
| 3 | **回测验证前不对纯 OI 异动做推送**；三路回测对比胜率/期望后再决定是否恢复 | 进行中（A/B blocked，见 §11/§12） |
| 4 | **回测三场景**：`A_pure_oi` / `B_oi_pattern` / `C_kol_pattern`，同一进出场口径比信号数·胜率·期望 | 框架已落地；A/B 待 OI 历史 |
| 5 | **KOL 二次预警**（直播逻辑，见 §13）：卡片打「关注」标签的 KOL → 币进关注列表 → 列表币出现约定形态时由 **crypto mornitor** 发二次预警 | 接线中（2026-10-19）：`kol_secondary_alert.py` + `scripts/grok_kol_secondary_forward.py`；关注名单暂用临时种子；webhook 未配则 dry-run→`alerts.jsonl` |
| 6 | **龙头直通**：`BTC` / `ETH` / `QQQ`（及对应交易对如 BTCUSDT 等）被任一 KOL 提到 → **直接进关注列表**，同样走二次预警 | ✅ 已在 `kol_secondary_alert` 实现（`KOL_LEADER_SYMBOLS`） |
| 7 | **回测数据源未验证前禁止用未经验证数据报胜率** | ✅ 门禁见 §11.5 |
| 8 | **形态列表（二次预警）**：**倒锤子（inverted_hammer）/ 吞没（engulfing）/ 射击之星（shooting_star）**；**大锤子（hammer）已从列表移除** | ✅ 以本章为准 |

**恢复 OI 推送**：删 `DISABLED` → 重启 forwarder → `resume` 例程 folder `oi`（须用户明确要求）。

---

## 11. 三路回测场景（纯 OI / OI+形态 / KOL+形态）

> **目的**：用历史数据对比三种选币+入场规则的信号数、胜率、期望收益，指导是否恢复推送以及推哪一类。  
> **门禁**：未经验证的 OI 历史 **不得** 用于 A/B 胜率；C 可在 K 线重叠窗单独跑，但不得冒充「三路谁更优」。

### 11.1 三路定义

| 场景 ID | 选币 | 入场触发 | 对比指标 |
|---------|------|----------|----------|
| `A_pure_oi` | 全市场 OI 异动 | OI 信号即入场（不做形态等待） | 信号数、胜率、期望 |
| `B_oi_pattern` | 同 A | OI 后经 §10 L1/L2，再等形态确认（§10 L3 allowlist） | 同上 |
| `C_kol_pattern` | KOL 关注名单提到的币（+ 龙头直通，见 §13） | 关注列表币出现 **倒锤子 / 吞没 / 射击之星** 之一（**不含大锤子**） | 同上 |

> **口径对齐（2026-10-19 晚通话）**：C 臂与 §13 二次预警形态一致 = `inverted_hammer,engulfing,shooting_star`。此前试跑曾用 `hammer,engulfing`（已过时）；重跑时须改 `KOL_PATTERNS` 并更新 §12。

三者必须同一套手续费/滑点/持仓/结算定义（见现有 `backtest_*` / `backtest_three_way.py`）。

### 11.2 脚本与产物

| 项 | 路径 |
|----|------|
| 框架 | `oi_mornitor/backtest_three_way.py` |
| 入口 | `oi_mornitor/scripts/run_three_way_backtest.py`（`--discover-only` 仅盘点 OI） |
| 摘要 | `data/three_way_backtest/latest_summary.json` |

### 11.3 KOL / 卡片数据源（供选币）

| 源 | 路径 / 库 | 用途 |
|----|-----------|------|
| TG 档案 | `auto-script/telegram/channel_profiles.json`（含 `send` 列表） | 频道名 ↔ chat_id；**≠** 最终关注名单 |
| TG 实时 | `discord-collector/data/telegram-live.sqlite` → `telegram_live_messages` | 原文抽币兜底 |
| Discord 信号卡 | MySQL `discord_collector.discord_signal_cards`（`symbol`,`channel_id`,`signal_at`…） | **主推荐**：已解析 symbol |
| 关注标签 | **待接**：用户生成卡片时给 KOL 打「关注」→ 写入可查询字段/表（见 §13.2） | 正式 allowlist |

临时试跑曾用「Discord 高产频道 + channel_profiles.send」——结果须标「临时名单」。

### 11.4 跑数结果（2026-10-19）

| 场景 | 状态 | 信号数 | 胜率 | 期望(pnl%) | 备注 |
|------|------|--------|------|------------|------|
| A_pure_oi | **blocked** | — | — | — | 无规范 OI 事件落盘；日志缺数值；与 K 线无重叠 |
| B_oi_pattern | **blocked** | — | — | — | 同 A |
| C_kol_pattern | 单臂试跑 | 410（结算 405） | 44.2% | -14.91 | **临时名单** + 当时 patterns=`hammer,engulfing`（**已过时**）；PF 0.65；**非三路对比** |

### 11.5 历史 OI 数据门禁

| 来源 | 结论 |
|------|------|
| 内存 `OI_CACHE` | 不可回测 |
| `data/oi-supervisor.log*` | 约 10-17～10-19；可抽告警行但缺 oi/delta/price → **不可作 A/B** |
| 规范落盘 `data/oi_events.jsonl`（建议字段：`ts_ms,symbol,oi_up|pct_oi,price,…`） | **尚无**；落地后可解锁 |
| K 线 `/Volumes/RamDisk/backtest_klines` | 约止于 **2026-08-15 UTC**；与 10 月 OI 日志 **无重叠** |

**解锁 A/B**：① 可验证 OI 事件流 ② K 线与 OI **同一时间窗**（续 K 或回填历史 OI）。在此之前 **禁止** 报 A/B 胜率。

### 11.6 其他 bot 改动清单

1. 落地 `oi_events.jsonl` + 对齐 K 线 → 重跑三路 → 更新 §11.4 / §12。  
2. 将 C/`KOL_PATTERNS` 改为 `inverted_hammer,engulfing,shooting_star`（去掉 hammer）后重跑 C。  
3. 用用户「关注」标签替换临时 allowlist。  
4. 实现 §13 直播二次预警 → crypto mornitor 推送。

---

## 12. 三路回测跑数记录（流水）

| 项 | 值 |
|----|-----|
| 跑数时间 | 2026-10-19 19:59 Asia/Shanghai |
| 脚本 | `backtest_three_way.py` + `scripts/run_three_way_backtest.py` |
| 参数（当时） | fee 0.06%/边 · slip 0.03%/边 · entry `next_bar_open` · C: TF=15m · lookahead=24 · **patterns=hammer,engulfing（已过时，见 §0/§11）** |
| K 线上界 | 2026-08-15T13:15:00Z |
| OI 日志窗 | 2026-10-17 ～ 2026-10-19 |
| A/B | blocked |
| C | signals=410 · settled=405 · winRate=44.2% · avg pnlPct=-14.91 · PF=0.65 |
| 产物 | `data/three_way_backtest/latest_summary.json` |
| 再跑 | `cd discord-collector && ./oi_mornitor/venv/bin/python oi_mornitor/scripts/run_three_way_backtest.py` |

---

## 13. KOL 二次预警（直播逻辑 · crypto mornitor）

> **与 §11 回测的关系**：§11 用历史比期望；**本章是线上要接的实时规则**。形态以 §0 为准（无大锤子）。  
> **推送责任方**：**crypto mornitor（本 Grok Bot）** 向用户发消息；**不依赖** oi_mornitor 前端 Toast。系统/手机通知走 Grok Bot 自带通知（见 §13.5）。

### 13.1 流程

```
用户生成信号卡片时给 KOL 打「关注」标签
        ↓
该 KOL 后续提到的币种 → 写入「关注列表」（watchlist）
        ↓
龙头直通：BTC / ETH / QQQ（含 *USDT 等交易对映射）被任意 KOL 提到 → 直接进关注列表
        ↓
关注列表中的币，K 线出现下列形态之一：
  • 倒锤子 inverted_hammer
  • 吞没 engulfing
  • 射击之星 shooting_star
  （大锤子 hammer：已移除，不要再加回）
        ↓
crypto mornitor 发出「二次预警」
```

### 13.2 关注标签与名单

| 项 | 说明 |
|----|------|
| 打标时机 | **用户在生成卡片时** 给该 KOL 打「关注」 |
| 存储（待实现） | 建议独立表/JSON：`kol_id` / `channel_id` / `display_name` / `followed_at` / `active`；卡片侧写 `followed=true` 或关联 id |
| 关注列表币 | `{symbol, sources:[{kol_name, channel_id, mentioned_at}], leader?:bool}` |
| 龙头集合 | 默认 `BTC, ETH, QQQ`（实现时归一化到交易对，如 BTCUSDT、QQQ 股票/差价合约符号以项目现有映射为准） |

### 13.3 二次预警触发与内容

**触发**：关注列表内 symbol，在约定周期（默认 **15m**，`KOL_ALERT_TF`）对**已收盘**最后一根 K（默认倒数第二根；`KOL_ALERT_INCLUDE_FORMING=1` 才含未收盘当根）检出：

- `inverted_hammer` 或 `engulfing` 或 `shooting_star`

形态命中即告警；**异常放量与 EMA144 仅作附加上报字段，不作门控**。

**消息字段（必填）**：

| 字段 | 含义 |
|------|------|
| KOL 名 | 带入关注列表的来源 KOL（龙头直通可写「龙头直通」+ 提及者） |
| 币种 | symbol |
| 形态 | 倒锤子 / 吞没 / 射击之星 |
| 异常放量 | **前一根或当根**相对近期均量是否异常放量（阈值可配置；须写明用的是前根还是当根） |
| EMA144 位置 | 现价相对 EMA144：上方 / 下方 / 附近（附距离% 更佳） |

可选：周期、K 线时间、卡片链接。

### 13.4 与 OI 热钱推送的隔离

| 类型 | 是否对外推送（2026-10-19） |
|------|---------------------------|
| 纯 OI 异动（hot_tickers） | **否**（采集保留） |
| 形态/结构 Telegram 卡片 | 按 `notify_telegram` / 现有开关（与本章二次预警独立） |
| KOL 二次预警 | **是** → 由 crypto mornitor 发到用户（聊天；配合 Bot 通知） |

### 13.5 crypto mornitor 系统通知能力（不依赖 auto-script 前端）

| 端 | 能力 | 条件 |
|----|------|------|
| **PC（macOS）** | 可进 **通知中心**：Bot 发来未读/完成/等待你时，Grok Bot 桌面可弹系统通知 + Dock 角标 | ① 本 Bot **Notifications 打开**（对话详情里，或让 Bot 打开）② 系统设置 → 通知 → Grok Bot → 允许通知/角标 |
| **手机（iOS/Android）** | 可有 **推送**（与桌面同一套「Bot 有更新」） | ① 安装 Grok Bot App 同账号 ② 本 Bot Notifications 开 ③ 系统通知权限开；推送仍在逐步放量 |
| **局限** | **不能**单独调用「自定义 Notification Center API」绕过聊天；通知内容即 Bot 发给你的那条消息摘要。Grok Bot **前台聚焦时通常抑制**弹窗（侧栏/角标仍提示）。 | — |
| **与前端 Toast** | oi_mornitor `ToastStack` 仅网页内浮层，**关标签即无**；二次预警 **不依赖** 它 | — |

**接线建议**：例程或监控任务检测到 §13.3 条件 → `SendToUser` 发出结构化二次预警文案 → 用户若已开 Notifications，则 PC/手机自动收到系统级提醒。

**缺什么（实现清单）**：

1. 卡片「关注」打标 UI/API + 持久化。 — **待做**（当前用临时种子 `followed_kols.json`：Discord 高产 + `channel_profiles.send`，与 `backtest_three_way` 同口径；`KOL_FOLLOW_ALL_RECENT=0`）  
2. 关注列表服务（含龙头直通）。 — ✅ `data/kol_secondary/watchlist.json` + 龙头直通  
3. 形态+放量+EMA144 检测钩子（可复用 `pattern_monitor` / 指标，去掉 hammer）。 — ✅ `kol_secondary_alert.py`（patterns=`inverted_hammer,engulfing,shooting_star`）  
4. 唤醒 crypto mornitor 的通道：webhook 例程 / 轮询 / 本机脚本 POST（类似已停用的 OI forwarder，但只转发二次预警）。 — ✅ `scripts/grok_kol_secondary_forward.py`；`~/.grokbot/kol-secondary/config.env`；无 URL 时 dry-run 写 `alerts.jsonl`（例程「KOL二次预警」URL 待填）  
5. 用户侧确认本 Bot Notifications + 系统权限。 — **待你确认**

### 13.6 配置旋钮（建议名 · 供改代码）

| 键 | 建议默认 | 说明 |
|----|----------|------|
| `KOL_SECONDARY_ALERT_ENABLED` | `1` | 总开关 |
| `KOL_FOLLOW_PATTERNS` | `inverted_hammer,engulfing,shooting_star` | **禁止**再加入 `hammer` |
| `KOL_LEADER_SYMBOLS` | `BTC,ETH,QQQ` | 龙头直通 |
| `KOL_ALERT_TF` | `15m` | 形态周期 |
| `KOL_VOL_LOOKBACK` / `KOL_VOL_MULT` | 如 20 / 2.0 | 异常放量：当根或前根 vs 均量 |
| `KOL_EMA_PERIOD` | `144` | EMA 位置 |
| `KOL_GROK_WEBHOOK_URL` / `KOL_GROK_WEBHOOK_KEY` | （空=dry-run） | crypto mornitor 例程 webhook |
| `KOL_POLL_SEC` | `45` | 轮询间隔 |
| `KOL_FOLLOW_ALL_RECENT` | `0` | `1`=任意频道提及都进列表（调试） |
| `KOL_EMA_NEAR_PCT` | `1.5` | EMA「附近」阈值 % |
| `KOL_ALERT_INCLUDE_FORMING` | `0` | `1`=含未收盘当根；默认只看**已收盘**倒数第二根 |

**实现文件（2026-10-19）**：`oi_mornitor/kol_secondary_alert.py`、`oi_mornitor/scripts/grok_kol_secondary_forward.py`、`~/.grokbot/kol-secondary/config.env`、`oi_mornitor/data/kol_secondary/`。

---

## 14. 文档维护约定

- **权威顺序**：§0 产品策略 > 分章细节 > 代码默认值；冲突时先改文档再改代码并注明日期。  
- 改形态列表、停/恢复推送、回测门禁、关注标签 schema 时：**必须**更新 §0 对应行与本章。  
- 回测数字只写进 §11.4 / §12，并标明数据区间与是否临时名单。  
- 其他 bot 改逻辑前先读 §0 + §13；不要恢复纯 OI 推送，除非用户明示且更新 §0。

