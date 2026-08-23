# 开放建卡 API（`/api/v1/cards`）

后台：`http://127.0.0.1:3851`（`COLLECTOR_UI_PORT`）

鉴权（二选一）：

- `X-Cards-Api-Key: <CARDS_API_KEY>`
- `Authorization: Bearer <CARDS_API_KEY>`

---

## 创建卡片 `POST /api/v1/cards`

### 示例

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

### 字段（仅这些）

| 字段 | 类型 | 说明 |
|------|------|------|
| `channelId` | string | 频道 id（Discord 雪花可写入该频道时间线；默认 `api`） |
| `channelName` | string | 频道名称 |
| `channelAvatar` | string | 频道头像 URL |
| `source` | string | 消息来源：平台名 `x` / `telegram` / …，或 **项目:平台** 如 `python-ai-operate:x`（`twitter`→`x`；也可用 `sourceType`；默认 `api`，最长 32 字符） |
| `body` | string | 原文 / 正文（也可用 `content`、`原文`、`rawContent`） |
| `images` | string[] | 图片 URL 列表（也可用单张 `image`） |
| `symbol` | string | 币种，如 `BTC` |
| `entry` | string | 入场价 |
| `targets` | string[] | 止盈价列表（也可用 `takeProfits`） |
| `stopLoss` | string | 止损价 |
| `signalAt` | string | 时间 ISO（也可用 `time`；默认当前） |
| `note` | string | 备注 |

可选：`direction`（`long` / `short` / 做多 / 做空）。

`channelId` 为已知 Discord 频道，或 Telegram 等外部 id 时，默认会往 Show 时间线插一条消息；频道不存在会自动创建虚拟服务器/频道。单次关闭：`"injectChannelMessage": false`。

### 批量清算 `POST /api/cards/liquidate`

按日期范围对未评价卡片拉 Binance K 线核算盈亏（已评价/已清算跳过），结果写入 `progress_json` / `backtest_json` / `execution_json`。

```bash
curl -s -X POST "http://127.0.0.1:3851/api/cards/liquidate" \
  -H "Content-Type: application/json" \
  -d '{"days": 7, "channelId": "", "symbol": "ETH"}'

# 仅清算指定 id（可多选）
curl -s -X POST "http://127.0.0.1:3851/api/cards/liquidate" \
  -H "Content-Type: application/json" \
  -d '{"cardIds": [1069, 1070]}'

# 清空自动清算结果后重新清算
curl -s -X POST "http://127.0.0.1:3851/api/cards/clear-liquidation" \
  -H "Content-Type: application/json" \
  -d '{"cardIds": [1069]}'
```

规则摘要：入场价与当时市价差 ≤0.5% 按市价开仓；限价 12 小时内未触及判「未入场」；**无止盈止损时默认 ±5%** 并写回卡片价位；**BTC / ETH / SOL 按 100x，其余山寨 20x** 核算杠杆盈亏。

---

## 查询

```bash
# 列表
curl -s "http://127.0.0.1:3851/api/v1/cards?days=7&limit=20" \
  -H "X-Cards-Api-Key: your-secret-key"

# 单条
curl -s "http://127.0.0.1:3851/api/v1/cards/123" \
  -H "X-Cards-Api-Key: your-secret-key"

# 删除（仅非 Discord 来源：telegram / x / api / youtube / manual 等）
curl -s -X DELETE "http://127.0.0.1:3851/api/v1/cards/123" \
  -H "X-Cards-Api-Key: your-secret-key"
```

成功：`{ "ok": true, "id": 123, "deleted": true }`。Discord 网关采集卡片返回 `403`。

本机批量删除（`/api/cards/batch-delete`，`cardIds` 数组）：返回 `deleted` / `skipped` / `failed`。

**本机写操作**：删除、清算、评价 PATCH、手动建卡等 `/api/cards/*` 写接口与 `PATCH /api/discord/signal-cards/:id` 仅允许本机（`127.0.0.1`）调用；域名访客前端会隐藏对应按钮。

---

## 配置

| 环境变量 | 说明 |
|----------|------|
| `CARDS_API_KEY` | 开放 API 密钥 |
| `CARD_API_INJECT_CHANNEL_MESSAGE` | `0` 关闭写入频道时间线 |

实现：`src/card-archive-api.js`、`src/card-archive-service.js`。
