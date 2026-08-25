# 开放卡片 API（`/api/v1/cards`）

后台：`http://127.0.0.1:3851`（`COLLECTOR_UI_PORT`）

鉴权（二选一，密钥与后台 `CARDS_API_KEY` 一致；未配置 env 时默认 `Gpf123456`）：

- `X-Cards-Api-Key: <CARDS_API_KEY>`
- `Authorization: Bearer <CARDS_API_KEY>`

筛选参数与前端卡片归档页（`/cards`）、评估页（`/eval`）一致。

---

## 查询卡片列表 `GET /api/v1/cards`

返回完整卡片（含 `execution`、`progress`、`backtest` 执行情况）。

### 示例

```bash
# 近 7 天、Discord + Telegram、博主频道、BTC
curl -s "http://127.0.0.1:3851/api/v1/cards?days=7&sources=discord,telegram&channelId=1234567890123456789&symbol=BTC&limit=200" \
  -H "X-Cards-Api-Key: your-secret-key"

# 今天（与前端「今天」一致）
curl -s "http://127.0.0.1:3851/api/v1/cards?from=2026-08-25T00:00:00.000Z" \
  -H "X-Cards-Api-Key: your-secret-key"

# 自定义时间窗
curl -s "http://127.0.0.1:3851/api/v1/cards?from=2026-08-01T00:00:00.000Z&to=2026-08-25T23:59:59.999Z" \
  -H "X-Cards-Api-Key: your-secret-key"
```

### 查询参数

| 参数 | 说明 |
|------|------|
| `days` | 近 N 天（默认 30；与 `from`/`to` 二选一） |
| `from` | 起始时间 ISO（信号时间 `signalAt`，缺省 `createdAt`） |
| `to` | 结束时间 ISO（默认当前） |
| `sources` | 来源列表，逗号分隔，如 `discord,telegram,x`（也可用 `source` 单值） |
| `channelId` | 博主 / 频道 id（也可用 `channel_id`） |
| `symbol` | 币种，如 `BTC`（也可用 `coin`） |
| `status` | 卡片状态，通常 `active` |
| `limit` | 条数上限（默认 200，最大 500） |
| `sinceId` | 增量拉取：仅返回 id 大于此值的卡片 |
| `refresh` | `1` 强制刷新服务端缓存 |

响应：`{ ok, fromMs, toMs, filters, total, maxId, cards[] }`

---

## 博主 / 频道列表 `GET /api/v1/cards/channels`

与前端「博主」下拉相同，按当前筛选条件下的卡片数量排序。

```bash
curl -s "http://127.0.0.1:3851/api/v1/cards/channels?days=7&sources=discord,telegram" \
  -H "X-Cards-Api-Key: your-secret-key"
```

查询参数：`days` / `from` / `to`、`sources` / `source`、`symbol`、`status`、`refresh`

响应：`{ ok, fromMs, toMs, filters, channels: [{ channelId, channelName, count }] }`

---

## 来源列表 `GET /api/v1/cards/sources`

```bash
curl -s "http://127.0.0.1:3851/api/v1/cards/sources" \
  -H "X-Cards-Api-Key: your-secret-key"
```

响应：`{ ok, sources: ["discord","youtube","telegram","x","api","manual"] }`

---

## 单条卡片 `GET /api/v1/cards/:id`

```bash
curl -s "http://127.0.0.1:3851/api/v1/cards/123" \
  -H "X-Cards-Api-Key: your-secret-key"
```

---

## 执行情况汇总 `GET /api/v1/cards/eval/summary`

按频道聚合胜率、盈亏、TP 命中等（与前端 `/eval` 一致）。

```bash
curl -s "http://127.0.0.1:3851/api/v1/cards/eval/summary?days=7&source=discord&channelId=1234567890123456789&symbol=ETH" \
  -H "X-Cards-Api-Key: your-secret-key"
```

查询参数：同列表接口（`days` / `from` / `to`、`sources` / `source`、`channelId`、`symbol`）

响应：`{ ok, fromMs, toMs, filters, note, overall, channels[] }`

- `overall` / `channels[]`：`cardCount`、`winCount`、`lossCount`、`pendingCount`、`winRate`、`totalPnlPct`、`avgPnlPct`、`tp1Hits`…

---

## 博主执行情况明细 `GET /api/v1/cards/eval/channels/:channelId`

```bash
curl -s "http://127.0.0.1:3851/api/v1/cards/eval/channels/1234567890123456789?days=30&symbol=BTC" \
  -H "X-Cards-Api-Key: your-secret-key"
```

每张卡含：`outcome`（`take_profit` / `stop_loss` / `pending`）、`entered`、`pnlPct`、`tpHits`、`execution`、`progress`、`backtest`。

---

## 创建卡片 `POST /api/v1/cards`

```bash
curl -s -X POST "http://127.0.0.1:3851/api/v1/cards" \
  -H "Content-Type: application/json" \
  -H "X-Cards-Api-Key: your-secret-key" \
  -d '{
    "channelId": "1234567890123456789",
    "channelName": "军长频道",
    "channelAvatar": "https://example.com/avatar.png",
    "source": "telegram",
    "body": "BTC 做多，关注支撑",
    "images": ["https://example.com/chart1.png"],
    "symbol": "BTC",
    "entry": "95000",
    "targets": ["98000", "100000"],
    "stopLoss": "92000",
    "signalAt": "2026-08-21T10:00:00.000Z",
    "note": "外部推送"
  }'
```

成功：`201` → `{ "ok": true, "card": { ... }, "channelMessage": null }`

### 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `channelId` | string | 频道 id（默认 `api`） |
| `channelName` | string | 频道名称 |
| `channelAvatar` | string | 频道头像 URL |
| `source` | string | 来源：`x` / `telegram` / …（也可用 `sourceType`） |
| `body` | string | 原文（也可用 `content`、`rawContent`） |
| `images` | string[] | 图片 URL（也可用 `image`） |
| `symbol` | string | 币种 |
| `entry` | string | 入场价 |
| `targets` | string[] | 止盈价（也可用 `takeProfits`） |
| `stopLoss` | string | 止损价 |
| `signalAt` | string | 时间 ISO（也可用 `time`） |
| `note` | string | 备注 |

可选：`direction`（`long` / `short` / 做多 / 做空）。

---

## 批量清算 `POST /api/v1/cards/liquidate`

按时间范围对未评价卡片拉 Binance K 线核算盈亏，结果写入 `progress` / `backtest` / `execution`。

```bash
curl -s -X POST "http://127.0.0.1:3851/api/v1/cards/liquidate" \
  -H "Content-Type: application/json" \
  -H "X-Cards-Api-Key: your-secret-key" \
  -d '{"days": 7, "channelId": "1234567890123456789", "sources": "discord", "symbol": "ETH"}'

# 仅清算指定 id
curl -s -X POST "http://127.0.0.1:3851/api/v1/cards/liquidate" \
  -H "Content-Type: application/json" \
  -H "X-Cards-Api-Key: your-secret-key" \
  -d '{"cardIds": [1069, 1070]}'
```

Body 字段：`days` / `from` / `to`、`channelId`、`sources` / `source`、`symbol`、`limit`、`cardIds`

---

## 列表验证 `POST /api/v1/cards/validate`

按筛选条件拉取卡片列表，逐张计算贴文发布后的：

- **已完结卡片**：最大盈利率及出现时间、该时段最大回撤
- **进行中卡片**（未止盈/止损）：仅返回当前盈亏率

扫描耗时较长，**进度与结果经 WebSocket 推送**（`ws://127.0.0.1:3851/ws`，`channel: meta`）。也可用轮询接口取最终结果。

### 启动

```bash
curl -s -X POST "http://127.0.0.1:3851/api/v1/cards/validate" \
  -H "Content-Type: application/json" \
  -H "X-Cards-Api-Key: your-secret-key" \
  -d '{"days": 7, "sources": "discord", "channelId": "1234567890123456789", "symbol": "BTC"}'
```

响应 `202`：

```json
{
  "ok": true,
  "jobId": "uuid",
  "status": "running",
  "filters": { ... },
  "ws": { "path": "/ws", "channel": "meta", "events": ["card_validate_started", "..."] },
  "poll": "/api/v1/cards/validate/uuid"
}
```

Body / 查询参数：与列表接口相同（`days` / `from` / `to`、`sources`、`channelId`、`symbol`、`limit`），另支持 `cardIds` 数组只验证指定 id。

### 模拟数据（测试用）

不访问数据库与行情，用于联调 WebSocket / 轮询：

```bash
# 静态样例（立即返回 6 条）
curl -s "http://127.0.0.1:3851/api/v1/cards/validate/mock/sample" \
  -H "X-Cards-Api-Key: your-secret-key"

# 模拟任务（逐条推送，约 0.35s/张）
curl -s -X POST "http://127.0.0.1:3851/api/v1/cards/validate" \
  -H "Content-Type: application/json" \
  -H "X-Cards-Api-Key: your-secret-key" \
  -d '{"mock": true, "mockCount": 8}'

# 本机一键脚本（需 collect:ui 已启动）
node scripts/card-validate-demo.mjs
node scripts/card-validate-demo.mjs --ws
```

`mock: true` 时 Body 可只含 `mockCount`（默认 8，最大 20）。事件与真实任务相同，字段多 `mock: true`。

### WebSocket 事件（`channel: meta`）

| `kind` | 说明 |
|--------|------|
| `card_validate_started` | `{ jobId, total, filters }` |
| `card_validate_progress` | `{ jobId, index, total, cardId, symbol, channelId }` |
| `card_validate_item` | `{ jobId, index, item }` 单张结果 |
| `card_validate_done` | `{ jobId, items[], errors[] }` 全部完成 |
| `card_validate_error` | `{ jobId, error }` 任务级失败 |

### 单张结果字段（`item`）

| 字段 | 说明 |
|------|------|
| `mode` | `full`（已完结，含历史统计）/ `current`（进行中，仅现价盈亏） |
| `inProgress` | 是否进行中 |
| `maxProfitPct` | 最大盈利率 %（杠杆后，`full` 模式） |
| `maxProfitAt` | 最大盈利出现时间 ISO |
| `maxDrawdownPct` | 最大回撤 %（从峰值回落，`full` 模式） |
| `maxDrawdownAt` | 最大回撤出现时间 ISO |
| `currentPnlPct` | 当前盈亏率 % |
| `entry` / `leverage` / `direction` | 入场价、杠杆、方向 |

### 轮询状态

```bash
curl -s "http://127.0.0.1:3851/api/v1/cards/validate/<jobId>" \
  -H "X-Cards-Api-Key: your-secret-key"
```

`status`: `running` → `done` / `error`；`done` 时 `items` 含全部结果。

---

## 删除 `DELETE /api/v1/cards/:id`

仅非 Discord 来源（`telegram` / `x` / `api` / `youtube` / `manual` 等）。

```bash
curl -s -X DELETE "http://127.0.0.1:3851/api/v1/cards/123" \
  -H "X-Cards-Api-Key: your-secret-key"
```

---

## 配置

| 环境变量 | 说明 |
|----------|------|
| `CARDS_API_KEY` | 开放 API 密钥（默认 `Gpf123456`；置空关闭） |
| `CARD_API_INJECT_CHANNEL_MESSAGE` | `0` 关闭写入频道时间线 |

实现：`src/card-archive-api.js`、`src/card-eval-api.js`、`src/card-validate-api.js`、`src/card-validate-engine.js`、`src/card-archive-service.js`。
