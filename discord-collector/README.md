# discord-collector

通过 **Chrome DevTools Protocol (CDP)** 监听 **Discord 网页版** 的：

- **Gateway WebSocket**（`wss://gateway.discord.gg/...`）— 实时 `MESSAGE_CREATE` 等事件  
- **REST API**（`https://discord.com/api/v...`）— 频道消息、历史拉取等 HTTP 响应  

架构与 [`stream-collector`](../stream-collector) 相同：Playwright 附加到你已登录的 Chrome，不注入脚本、不走 Bot Token。

## 环境准备

```bash
cd discord-collector
cp .env.example .env
# 编辑 MySQL、CDP_CONNECT_URL 等
pnpm install
mysql -h127.0.0.1 -uroot -p < schema/init.sql   # 首次
```

## 推荐：Chrome 附加 + 双终端 UI

### 1. 启动带调试端口的 Chrome（macOS 示例）

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.discord-collector-chrome"
```

在打开的 Chrome 里访问 **https://discord.com** 并完成登录。

### 2. 终端 A — 采集 + 面板后端

```bash
cd discord-collector
pnpm run collect:ui
```

默认 **http://127.0.0.1:3851/**（`COLLECTOR_UI_PORT`，与 stream-collector 的 3840 错开）。

提供：

| 路径 | 说明 |
|------|------|
| `GET /api/frames` | 最近 WS 帧（MySQL） |
| `GET /api/discord/guilds` | 服务器列表（MySQL，READY/GUILD_CREATE 同步） |
| `GET /api/discord/guilds/:guildId/channels` | 频道列表 |
| `GET /api/discord/messages` | 解析后的 Discord 消息（含头像 URL） |
| `POST /api/cdp/discord-channel` | `{ "guildId", "channelId" }` 在 CDP 页签 `goto` 到频道 |
| `ws://127.0.0.1:3851/ws` | 实时网络诊断 + WS 帧推送 |

### 3. 终端 B — Vue 开发（可选）

```bash
pnpm run ui:build
pnpm run dev:ui-vue
```

打开 **http://localhost:5176/show**（或 Vite 打印的端口 + `/show`）— 三栏布局：左侧服务器、中间频道、右侧消息（头像 + 昵称 + 时间）。数据来自 MySQL + 本地 `localStorage` 缓存（键 `discord-collector.show.v1`）。

默认 **http://localhost:5176/**（若端口被占用，Vite 会顺延如 **5177**，以终端输出的 `Local:` 为准）。

**注意：不要在命令后面加 `# 注释`**，否则 shell 会把注释传给 Vite，导致 404：

```bash
# 错误 ❌
pnpm run dev:ui-vue   # 默认 5176

# 正确 ✅
pnpm run dev:ui-vue
```

## 仅采集写库（无 UI）

```bash
pnpm run collect
```

## 环境变量要点

| 变量 | 默认 | 说明 |
|------|------|------|
| `CDP_CONNECT_URL` | 空 | 如 `http://127.0.0.1:9222`，**推荐** |
| `TARGET_PAGE_URL` | — | 附加模式下提示用，如 `https://discord.com/channels/@me` |
| `COLLECTOR_UI_PORT` | `3851` | UI / WS 端口 |
| `DISCORD_MONITORED_GUILD_IDS` | 空 | 逗号分隔，仅入库指定服务器消息 |
| `DISCORD_DEBUG_MODE` | `1` | `1` 全量 WS/API 调试；`0` 精简日志与 UI |
| `TELEGRAM_SEND_URL` | — | Telegram 发送 API（如 `http://127.0.0.1:8000/api/telegram/send`） |
| `TELEGRAM_PUSH_CHAT_ID` | — | 目标 Telegram 群组 chat id |
| `DISCORD_TELEGRAM_PUSH_CHANNEL_IDS` | 内置 8 个 | 有新消息时推送到 Telegram 的 Discord 频道 |
| `DISCORD_TELEGRAM_REALTIME_CHANNEL_IDS` | 空 | 实时推送，不参与 2 分钟聚合（逗号分隔，可单独配置） |
| `DISCORD_TELEGRAM_PUSH_DEBOUNCE_MS` | `120000` | 其他频道：最后一条消息后等待多久再批量转发 |
| `COLLECTOR_NETWORK_TRACE` | `0` | `1` 时终端打印 HTTP 请求 |
| `COLLECTOR_WS_FRAME_TRACE` | `0` | `1` 时打印 Gateway 帧（仍跳过心跳/Presence） |
| `DISCORD_GATEWAY_MESSAGE_LOG` | `0` | `1` 时打印 `[gateway MESSAGE_CREATE]` 群聊消息行 |

## 数据表

- `frames` — 原始 WebSocket 帧（hash 去重）  
- `discord_messages` — 消息（含 `guild_name` / `channel_name` / `author_avatar`）
- `discord_guilds` — 服务器列表（名称、图标）
- `discord_channels` — 文本频道（含最后一条消息预览）

## 与 stream-collector 的差异

| | stream-collector | discord-collector |
|--|--|--|
| 目标站点 | Kook 网页 | Discord 网页 |
| Gateway 事件 | Kook 自定义 | Discord `op`/`t`/`d` |
| 频道跳转 API | `POST /api/cdp/kook-channel` | `POST /api/cdp/discord-channel` |
| 默认 UI 端口 | 3840 | 3851 |

后续可在 `discord-message-ingest.js` 扩展更多 Gateway 事件（编辑、删除、反应等）。

## Telegram 频道推送

配置 `TELEGRAM_SEND_URL` + `TELEGRAM_PUSH_CHAT_ID` 后，以下频道的新消息会推送到 Telegram 群组（默认已内置，可用 `DISCORD_TELEGRAM_PUSH_CHANNEL_IDS` 覆盖）：

- 全部频道默认 **2 分钟 debounce**：收到消息后重置计时，静默满 2 分钟后将该期间缓冲的消息**一次性合并转发**；若持续有新消息则一直等待。
- 若配置了 `DISCORD_TELEGRAM_REALTIME_CHANNEL_IDS`，所列频道**立即推送**，不参与聚合。

信号卡片频道同时走消息推送；自动信号卡片 Telegram（AI 格式化）对该列表内频道关闭，避免重复推送。Show UI 内仍可手动点卡片「TG」重发。
