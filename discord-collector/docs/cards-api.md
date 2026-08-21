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
| `body` | string | 原文 / 正文（也可用 `content`、`原文`、`rawContent`） |
| `images` | string[] | 图片 URL 列表（也可用单张 `image`） |
| `symbol` | string | 币种，如 `BTC` |
| `entry` | string | 入场价 |
| `targets` | string[] | 止盈价列表（也可用 `takeProfits`） |
| `stopLoss` | string | 止损价 |
| `signalAt` | string | 时间 ISO（也可用 `time`；默认当前） |
| `note` | string | 备注 |

可选：`direction`（`long` / `short` / 做多 / 做空）。

`channelId` 为已知 Discord 频道时，默认会往该频道时间线插一条消息；单次关闭：`"injectChannelMessage": false`。

---

## 查询

```bash
# 列表
curl -s "http://127.0.0.1:3851/api/v1/cards?days=7&limit=20" \
  -H "X-Cards-Api-Key: your-secret-key"

# 单条
curl -s "http://127.0.0.1:3851/api/v1/cards/123" \
  -H "X-Cards-Api-Key: your-secret-key"
```

---

## 配置

| 环境变量 | 说明 |
|----------|------|
| `CARDS_API_KEY` | 开放 API 密钥 |
| `CARD_API_INJECT_CHANNEL_MESSAGE` | `0` 关闭写入频道时间线 |

实现：`src/card-archive-api.js`、`src/card-archive-service.js`。
