# 巨鲸 kolvip 临时信号源（HTTP API 优先）

巨鲸助手 Pro（`https://kolvip.vip/web`）是 **临时** 替代 Discord 信号频道监听的来源。与 Discord Gateway **并存**：环境变量开关切换，**不删除** Discord 配置。

**推荐**：`x-wtoken` + `/api-v1/webu/*` 拉消息 → 建卡 → 清算 → 与现有 eval 同口径。CDP DOM 仅 token 兜底或 `KOLVIP_FETCH_MODE=cdp`。

---

## 1. 开关与切回 Discord

| 变量 | 默认 | 含义 |
|------|------|------|
| `SIGNAL_INGEST_SOURCE` | `kolvip` | **互斥**：`kolvip` 巨鲸建卡且 Discord 信号频道不建卡；`discord` 仅 Gateway 建卡 |
| `KOLVIP_ENABLED` / `KOLVIP_API_ENABLED` | `kolvip` 源下默认 API 开 | 开启巨鲸信号源 |
| `KOLVIP_FETCH_MODE` | `auto` | `api` / `cdp` / `auto`（API 优先） |
| `KOLVIP_API_BASE_URL` | `https://kolvip.vip/api-v1` | API 根 |
| `KOLVIP_API_WTOKEN` | 空 | Header `x-wtoken`（勿提交 git） |
| `KOLVIP_API_TOKEN_FILE` | `data/kolvip-api-token.json` | token 或 localStorage 导出 |
| `KOLVIP_API_CDP_TOKEN_SYNC` | `1` | 从 CDP 读 `wv.wtoken` |
| `KOLVIP_API_WTOKEN_PRIORITY` | `file-first` | `cdp-first`：先 CDP 再 `KOLVIP_API_TOKEN_FILE` 兜底 |
| `KOLVIP_CDP_CONNECT_URL` | 空→`CDP_CONNECT_URL` | kolvip 专用 Chrome（如 `http://127.0.0.1:9223` 已登录 `/web`） |
| `KOLVIP_WS_ENABLED` | `1` | 订阅 `wss://…/webu/ws?token=`（与官网同路，秒级） |
| `KOLVIP_POLL_DEFER_WHEN_WS` | `1` | WS 在线时 HTTP 轮询降为兜底 |
| `KOLVIP_POLL_FALLBACK_MS` | `600000` | WS 在线时 HTTP 全量补拉间隔 |
| `KOLVIP_POLL_INTERVAL_MS` | `90000` | HTTP 轮询 tick（WS 断线或兜底时扫 8 精选频道） |
| `KOLVIP_BYPASS_DISCORD_SIGNALS` | 源开时 `1` | 旁路 Discord 同频道建卡 |
| `KOLVIP_CDP_ENABLED` | `0` | DOM 兜底 |
| `KOLVIP_CHANNEL_IDS` | 空 | 覆盖默认 8 精选 |

切回 Discord 建卡：`SIGNAL_INGEST_SOURCE=discord`（可选 `KOLVIP_ENABLED=0`）→ 重启 `pnpm run collect:ui`。

---

## 2. 实时 WebSocket（推荐）

与官网 `kolvip.vip/web` 相同：`wss://{KOLVIP_API_BASE_URL}/webu/ws?token={wtoken}`。

| `type` | 处理 |
|--------|------|
| `msg` | `data` 与 `/webu/messages` 同结构 → `discord_messages` + 建卡 |
| `hb` | 心跳，忽略 |

本地 `collect:ui` 在 `KOLVIP_WS_ENABLED=1` 时常驻连接；`GET /api/kolvip/status` 的 `ws.connected` 可看是否在线。WS 在线且 `KOLVIP_POLL_DEFER_WHEN_WS=1` 时，HTTP 仅每 `KOLVIP_POLL_FALLBACK_MS` 补扫精选 8 频道。

**防漏消息（类 Discord 主动拉取）**

| 时机 | 行为 |
|------|------|
| WS **重连** | 自动 `runOnce()` 扫精选 8 频道 |
| Show **切频道** | `show-history-warm` → kolvip `GET /webu/messages`；**库内已预热且在 TTL 内则跳过**（默认与巨鲸 **30 天** 窗口一致，读 MySQL） |
| Show **向上翻** | `POST /api/kolvip/channels/catchup`（`beforeMessageId` = 最旧 `kolvip-{ch}-{id}`，**不受 TTL 限制**） |
| 榜单 `kolvip-scan-*` 轮转 | 同上 TTL；实时仍走 **WebSocket** |

---

## 3. HTTP API

| 用途 | 方法 | 路径 |
|------|------|------|
| 频道列表 | POST | `/webu/channels` `{ read: false }` |
| 消息 | GET | `/webu/messages?channel_id=&before_id=&limit=` |
| 心跳 | GET | `/webu/ping` |

Token：localStorage `wv.wtoken`（JSON 字符串）。

- **VIP 后会话（推荐暂用）**：独立 Chrome `--remote-debugging-port=9223`，打开 `https://kolvip.vip/web` 并保持登录；`.env` 设 `KOLVIP_CDP_CONNECT_URL=http://127.0.0.1:9223`、`KOLVIP_API_WTOKEN_PRIORITY=cdp-first`。`data/kolvip-api-token.json` 仅作 CDP 不可用时的兜底。
- **离线导出**：写入 `data/kolvip-api-token.json`：`{"wtoken":"..."}`。

---

## 3. 精选跟单（8 频道）

| 逻辑名 | 巨鲸 ch | Discord channelId |
|--------|---------|-------------------|
| 大镖客 | 1 | `1444962339743989843` |
| 淑琴 | 4 | `1444962376066793513` |
| 三马 | 8 | `1444962439471955989` |
| 峰哥 | 10 | `1444963929393729686` |
| 军长 | 11 | `1444963474718462085` |
| 所长 | 12 | `1444963405185159238` |
| 胖猫社区 | 16 | `1562351038277619783` |
| 颜驰 | 22 | `1444963689194192947` |

表：`src/kolvip-cdp-config.js`。实时：`source=kolvip_api`，**可推 TG**。

**全站其它浏览频道**：回溯扫描，`channelId=kolvip-scan-{ch}`，`source=kolvip_api_scan`，`source_type=kolvip`，**不推 TG**，面板「全站备选」（eval-summary `candidates` 按 `kolvip-scan-*` 聚合）。

精选回溯：`source=kolvip_api_backfill`（19 字符，需 `discord_signal_cards.source` ≥64；collect:ui 启动时 `store.js` 会 `MODIFY COLUMN source VARCHAR(64)`）。库内不再写死 `auto`；Gateway Discord 仍为 `auto` / `source_type=discord`（`source_type` 保持 VARCHAR(32)，`kolvip` 够用）。

实时 / 回溯 ingest 会把同一批消息 **upsert** 进 `discord_messages`（Show 读的那张表），不是只建卡。`message_id` 稳定为 `kolvip-{巨鲸频道}-{dataId}`，精选频道的 `channel_id` 用映射表里的 Discord channelId（`KOLVIP_CHANNEL_IDS` 可覆盖）。未映射备选仍用 `kolvip-scan-{ch}`，不写入 Discord 服务器侧栏。

### Show 消息隔离

由 `KOLVIP_ENABLED` / `KOLVIP_API_ENABLED` / `KOLVIP_CDP_ENABLED`（`isKolvipSignalEnabled`）决定，`source` 标签保留：

| 开关 | 映射信号频道的 Show / `/api/discord/messages` / messages-snapshot |
|------|------------------------------------------------------------------|
| 开 | 只返回 `source` 以 `kolvip_` 开头（或 `KOLVIP_SIGNAL_CARD_SOURCES`）的行 |
| 关 | 隐藏上述 kolvip 行，恢复 Discord 原文 |

开启时，映射频道上的 Discord 原文会被软删（`deleted_at` + `deleted_reason=kolvip_primary`），可逆：关开关并重启 `collect:ui` 会清掉这批软删。Discord 刷新按 `message_id` 合并，**不会删掉** `kolvip_*` 行。

### 部署后补近 7 天精选消息（本机手动）

云端代理不要对 Mac 生产库跑回溯。在已配置 wtoken 的本机 `collect:ui` 上：

1. `.env`：`KOLVIP_ENABLED=1`、`KOLVIP_BACKFILL_ENABLED=1`、`KOLVIP_BACKFILL_DAYS=30`、`KOLVIP_BACKFILL_SHADOW=0`（默认 shadow 是开的，不关则不会入库）。
2. 重启 `pnpm run collect:ui`。
3. 只对 8 个精选频道调用已有接口（不要 `POST /api/kolvip/backfill/start-all`，那会排队全站备选）：

```bash
for id in 1 4 8 10 11 12 16 22; do
  curl -s -X POST http://127.0.0.1:3851/api/kolvip/backfill/start \
    -H 'content-type: application/json' \
    -d "{\"kolvipChannelId\":\"$id\"}"
done
```

回溯写入 `source=kolvip_api_backfill`。Show 在巨鲸开时只显示这些行；关掉巨鲸并重启后回到 Discord 原文。

**历史卡升级**：早期建卡可能已是 `message_id=kolvip-*` 但 `source=auto`。回溯/扫描 ingest 遇正文去重时不会重插，但会走 `upgradeKolvipSignalCardSourceFromRow` 把 `source` / `source_type` / `source_ref`（必要时 `channel_id` 改为 `kolvip-scan-*`）写回已有行；日志 `source_upgraded`，**不计入** backfill `cardsCreated`。

---

## 4. 约 30 天回溯 + eval（精选 + 全站）

| 变量 | 默认 | 含义 |
|------|------|------|
| `KOLVIP_BACKFILL_ENABLED` | `0` | 启动回溯 |
| `KOLVIP_BACKFILL_DAYS` | `30` | 窗口（天） |
| `KOLVIP_BACKFILL_ALL_CHANNELS` | `1` | 全站浏览频道排队 |
| `KOLVIP_BACKFILL_SHADOW` | `0` | `1`=仅状态机 |
| `KOLVIP_BACKFILL_BATCH_SIZE` | `40` | 每批条数 |
| `KOLVIP_BACKFILL_BATCH_COOLDOWN_MS` | `60000` | 批间冷却 |
| `KOLVIP_BACKFILL_TICK_MS` | `45000` | tick 间隔 |
| `KOLVIP_API_CHANNEL_DELAY_MS` | `800` | 多频道 API 间隔 |

流程：API 分页 → `ingestKolvipMessageBatch(mode=backfill)` → `runBatchLiquidation` → `discord_signal_cards` + progress → eval 汇总。

### 分期计划（防封）

1. **P0**：配置 wtoken → `POST /api/kolvip/catalog/sync`（`data/kolvip-channel-catalog.json`）。
2. **P1**：`KOLVIP_BACKFILL_ENABLED=1` → `POST /api/kolvip/backfill/start` `{"kolvipChannelId":"16"}`。
3. **P2**：低峰 `POST /api/kolvip/backfill/start-all`（串行全站 × ~30 天）。
4. **P3**：Show 面板 + `GET /api/kolvip/eval-summary?days=30`。

状态：`data/kolvip-backfill.json`。

### 本机 API 入口

| 方法 | 路径 |
|------|------|
| POST | `/api/kolvip/catalog/sync` |
| POST | `/api/kolvip/backfill/start` |
| POST | `/api/kolvip/backfill/start-all` |
| GET | `/api/kolvip/backfill/status` |
| POST | `/api/kolvip/backfill/pause` |
| GET | `/api/kolvip/eval-summary` |
| POST | `/api/kolvip/fetch` |

---

## 5. Show 胜率面板

`KolvipEvalPanel.vue`：**精选（跟单）** + **全站备选（按胜率排序）**。口径同 `GET /api/v1/cards/eval/summary`（自建卡 + 清算，与巨鲸站内「博主胜率分析」不是同一套）。

## 5b. 博主胜率分析（本地镜像 kolvip /webu/sig）

线上页面对应 API：

| 方法 | 路径 | 含义 |
|------|------|------|
| GET | `/webu/sig/rank?range=7\|30\|all` | 榜单 |
| GET | `/webu/sig/blogger?name=&range=` | 博主详情 + 历史 |
| GET | `/webu/sig/detail?id=` | 单子详情 |

本地只读 **`data/kolvip-sig/`**（UI 与统计不再依赖打开 kolvip.vip 该页）：

| 方法 | 路径 |
|------|------|
| GET | `/api/kolvip/sig/rank` |
| GET | `/api/kolvip/sig/blogger` |
| GET | `/api/kolvip/sig/detail` |
| GET | `/api/kolvip/sig/meta` |
| POST | `/api/kolvip/sig/sync` |

页面：`http://127.0.0.1:3851/local/manual-stats/kolvip-sig`（collect:ui 本地模块）。

定时：`KOLVIP_SIG_SYNC_INTERVAL_MS` 默认 `120000`（0 关闭）。需有效 wtoken（同消息 API）。

---

## 6. CDP DOM（可选）

`KOLVIP_CDP_ENABLED=1`、`kolvip-cdp-nav.js`（分组展开）。仅 `auto` 失败兜底或调试。

---

## 7. 胖猫单图 OCR 与优先队列

kolvip 频道 16（胖猫社区）的消息进现有信号卡管道。**带配文的消息仍走原来的文字解析。** 只有「一张图、没有配文、不是多图相册」才调用本机 PaddleOCR（`http://127.0.0.1:8866` 的 `POST /ocr`，失败再试 `POST /ocr/base64`）。图是文字截图，只从 OCR 文本里取币种、方向、收益率，不调用 Ollama。

出卡规则：币种和方向都能解析，且收益率 **小于 40** 或为负数（`-5%` 出卡，`40%` / `41%` 不出，`0%` 出）。缺任一字段只打日志。服务宕机或超时同样只打日志。

出卡之后（文字卡，以及过了上面门槛的 OCR 卡）向 `POST {PRIORITY_QUEUE_BASE_URL}/queue/priority` 入队，`source` 固定 `pangmao`。`PRIORITY_QUEUE_BASE_URL` 或 `PRIORITY_QUEUE_SECRET` 为空则跳过并只记一次日志；队列不可达不影响出卡。

文字信号允许币种和「开多 / 开空 / 做多 / 做空 / 反抽做空 / 空进去」之间夹口语（例如 `btw小心了…反抽做空` → BTW 做空）。有这些交易意图、但币种解析不出来时，仍入队一张 `signalPhase=incomplete`、`displayOnly` 的展示卡，币种留空，不编造 ticker，也不下 Bitget/WEEX。纯聊天、返佣/邀请不入队。单图 OCR 门槛不变。

合并后在跑采集的那台 Mac 上：确认 PaddleOCR 仍监听 `0.0.0.0:8866`；若 `.env` 里还写着 `DISCORD_SIGNAL_OCR_OPEN_MAX_PROFIT_PCT=66`，改成 `40` 或删掉该行。优先队列地址和 secret 配好后重启 `pnpm run collect:ui`。不要把 secret 写进仓库。

## 8. 模块索引

| 文件 | 说明 |
|------|------|
| `kolvip-api-client.js` | HTTP |
| `kolvip-api-auth.js` | wtoken |
| `kolvip-api-catalog.js` | 全站目录 |
| `kolvip-ingest.js` | Show 消息 upsert + 建卡 + 清算 |
| `kolvip-scan-config.js` | 备选虚拟 channel |
| `kolvip-cdp-service.js` | 实时轮询 |
| `kolvip-cdp-backfill.js` | 30 天回溯 |
| `kolvip-cdp-eval.js` | 面板聚合 |

维护：改行为时同步 `.env.example` 与本文。
