# 巨鲸 kolvip 临时信号源（HTTP API 优先）

巨鲸助手 Pro（`https://kolvip.vip/web`）是 **临时** 替代 Discord 信号频道监听的来源。与 Discord Gateway **并存**：环境变量开关切换，**不删除** Discord 配置。

**推荐**：`x-wtoken` + `/api-v1/webu/*` 拉消息 → 建卡 → 清算 → 与现有 eval 同口径。CDP DOM 仅 token 兜底或 `KOLVIP_FETCH_MODE=cdp`。

---

## 1. 开关与切回 Discord

| 变量 | 默认 | 含义 |
|------|------|------|
| `KOLVIP_ENABLED` / `KOLVIP_API_ENABLED` | `0` | 开启巨鲸信号源（推荐 `KOLVIP_ENABLED=1`） |
| `KOLVIP_FETCH_MODE` | `auto` | `api` / `cdp` / `auto`（API 优先） |
| `KOLVIP_API_BASE_URL` | `https://kolvip.vip/api-v1` | API 根 |
| `KOLVIP_API_WTOKEN` | 空 | Header `x-wtoken`（勿提交 git） |
| `KOLVIP_API_TOKEN_FILE` | `data/kolvip-api-token.json` | token 或 localStorage 导出 |
| `KOLVIP_API_CDP_TOKEN_SYNC` | `1` | 无 token 时从 CDP 读 `wv.wtoken` |
| `KOLVIP_POLL_INTERVAL_MS` | `90000` | 实时轮询（精选 8 频道） |
| `KOLVIP_BYPASS_DISCORD_SIGNALS` | 源开时 `1` | 旁路 Discord 同频道建卡 |
| `KOLVIP_CDP_ENABLED` | `0` | DOM 兜底 |
| `KOLVIP_CHANNEL_IDS` | 空 | 覆盖默认 8 精选 |

切回 Discord：`KOLVIP_ENABLED=0` → 重启 `pnpm run collect:ui`。

---

## 2. HTTP API

| 用途 | 方法 | 路径 |
|------|------|------|
| 频道列表 | POST | `/webu/channels` `{ read: false }` |
| 消息 | GET | `/webu/messages?channel_id=&before_id=&limit=` |
| 心跳 | GET | `/webu/ping` |

Token：localStorage `wv.wtoken`（JSON 字符串）。写入 `data/kolvip-api-token.json`：`{"wtoken":"..."}`。

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

精选回溯：`source=kolvip_api_backfill`。库内 `discord_signal_cards.source` 不再写死 `auto`；Gateway Discord 仍为 `auto` / `source_type=discord`。

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

`KolvipEvalPanel.vue`：**精选（跟单）** + **全站备选（按胜率排序）**。口径同 `GET /api/v1/cards/eval/summary`。

---

## 6. CDP DOM（可选）

`KOLVIP_CDP_ENABLED=1`、`kolvip-cdp-nav.js`（分组展开）。仅 `auto` 失败兜底或调试。

---

## 7. 模块索引

| 文件 | 说明 |
|------|------|
| `kolvip-api-client.js` | HTTP |
| `kolvip-api-auth.js` | wtoken |
| `kolvip-api-catalog.js` | 全站目录 |
| `kolvip-ingest.js` | 建卡 + 清算 |
| `kolvip-scan-config.js` | 备选虚拟 channel |
| `kolvip-cdp-service.js` | 实时轮询 |
| `kolvip-cdp-backfill.js` | 30 天回溯 |
| `kolvip-cdp-eval.js` | 面板聚合 |

维护：改行为时同步 `.env.example` 与本文。
