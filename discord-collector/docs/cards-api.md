# 开放卡片 API（`/api/v1/cards`）

后台：`http://127.0.0.1:3851`（`COLLECTOR_UI_PORT`）  
WebSocket：`ws://127.0.0.1:3851/ws`（`channel: meta`）

鉴权（二选一，密钥与后台 `CARDS_API_KEY` 一致；未配置 env 时默认 `Gpf123456`）：

- `X-Cards-Api-Key: <CARDS_API_KEY>`
- `Authorization: Bearer <CARDS_API_KEY>`

---

## 建卡 vs 历史回测（必读）

| 目的 | 方法 | 是否写库 | 结果怎么拿 |
|------|------|----------|------------|
| **新建一张卡片**（Telegram/X/手动统计入库） | `POST /api/v1/cards` 或本机手动统计 | 是，需 MySQL | 响应返回 `card`；手动统计另跑清算 |
| **历史信号回测**（真实 K 线） | `POST /api/v1/cards/validate` + `signals` | 默认否 | WebSocket + 轮询 |
| **库内卡片清算入库** | `POST /api/v1/cards/liquidate` 或 validate + `cardIds` | 是 | 写 `execution` / `progress` / `backtest` |

常见误用：把回测请求发到 `POST /api/v1/cards`（建卡），会 400 并提示改用 `/validate`。

> **`/validate` 已使用真实 Binance K 线**（不再默认 mock）。`signals[]` 做窗口回测；`cardIds` / `channelId` / `sources` 对库内卡清算并写回。静态样例：`GET .../validate/mock/sample`。

**回测典型流程：**

1. `POST /api/v1/cards/validate` + `signals[]`（币种、方向、帖子时间、可选入场价）
2. 连接 `ws://127.0.0.1:3851/ws`，监听 `card_validate_started` / `card_validate_item` / `card_validate_done`
3. 或轮询 `GET /api/v1/cards/validate/<jobId>`

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

> **写入新卡片**，需 MySQL。历史回测请用 [`POST /api/v1/cards/validate`](#列表验证--历史回测-post-apiv1cardsvalidate)。

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

Telegram `#prom`：`note` 含 `#prom` 或 Body 传 `mergeWindowMs: 600000` 时，同频道同作者同币种 **10 分钟内**再 POST 会合并更新同一张卡（默认合并窗为 30 分钟）。

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

## 历史回测 `POST /api/v1/cards/validate`

> **不是建卡。** `signals`：真实 K 线窗口回测（默认不写库）。`cardIds` / `channelId` / `sources`：库内卡片真实清算并写回 MySQL。

### 请求 Body

```json
{
  "signals": [
    {
      "id": "post-001",
      "symbol": "BTC",
      "direction": "long",
      "signalAt": "2026-08-21T10:00:00.000Z",
      "entry": "95000",
      "entryMode": "limit"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `signals` | 与库筛二选一 | 信号数组 |
| `signals[].symbol` / `direction` / `signalAt` | 是 | 币种、方向、时间 |
| `signals[].entry` / `entryMode` | 否 | 入场价；默认市价 |
| `cardIds` / `channelId` / `sources` | 与 signals 二选一 | 库内清算入库 |
| `windowDays` | 否 | 默认 3 |

### 回测规则（真实 K 线）

1. `signalAt` 市价或限价（12h 内触及）入场  
2. 窗口内：`maxProfitPct` / `minProfitPct`、阈值触及  
3. 阈值：BTC/ETH **2%**，山寨 **5%**

响应 `202`：`mock: false`。WS：`card_validate_*`。样例预览：`GET /api/v1/cards/validate/mock/sample`（非行情）。

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

实现：`src/card-validate-signals.js`、`src/card-validate-mock.js`、`src/card-validate-api.js`、`src/card-archive-api.js`。
