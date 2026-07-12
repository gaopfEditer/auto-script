# WebSocket 实时推送架构

本文说明 **discord-collector 后台如何把消息推给前端**，涵盖本地开发与服务端部署两种场景。

相关文档：[前端部署在服务器 + 后台运行在本地](./deploy-frontend-remote-backend-local.md)（Nginx / SSH 隧道配置细节）。

---

## 一、核心机制

### 1.1 传输方式

后台 `collect:ui`（`src/collector-ui-server.js`）在同一 HTTP Server 上挂载 WebSocket：

| 项目 | 值 |
|------|-----|
| 默认端口 | `3851`（环境变量 `COLLECTOR_UI_PORT`） |
| WebSocket 路径 | `/ws` |
| 协议 | 本地 `ws://`；HTTPS 站点经 Nginx 后为 `wss://` |

每条推送由 `broadcast(channel, payload)` **广播**给所有已连接的 WebSocket 客户端——**无 room、无订阅**，前端自行按 `channel` / `kind` 过滤。

### 1.2 消息信封格式

```json
{
  "v": 1,
  "ts": 1717745825083,
  "channel": "message",
  "kind": "discord_message_batch",
  "...": "其余字段随事件类型变化"
}
```

| 字段 | 说明 |
|------|------|
| `v` | 协议版本，固定 `1` |
| `ts` | 毫秒时间戳 |
| `channel` | 频道类型（见下表） |
| `kind` | 具体事件名 |

### 1.3 channel 类型一览

| `channel` | 典型 `kind` | 含义 |
|-----------|-------------|------|
| `message` | `discord_message_batch` | Discord 消息批次（Show / Messages 页） |
| `meta` | `signal_card_created`、`card_archived`、`guilds_updated` 等 | 元事件、信号卡片生命周期 |
| `frame` | `ws_frame` | Discord Gateway 原始 WS 帧（Debug 页） |
| `diag` | `net_request`、`ws_created` 等 | CDP 网络诊断（Debug 页） |
| `config` | `debug_mode` | Debug 模式开关同步 |

#### `meta` 常见事件

| `kind` | 触发时机 |
|--------|----------|
| `signal_card_created` | 自动解析或手动创建信号卡片 |
| `card_archived` | YouTube 等来源归档建卡 |
| `card_price_proximity` | 价格接近止盈/止损 |
| `guilds_updated` / `channels_updated` | 服务器/频道列表变化 |
| `cdp_active_channel` | CDP 当前浏览的 Discord 频道变化 |

#### `message`：`discord_message_batch` 示例

```json
{
  "v": 1,
  "ts": 1717745825083,
  "channel": "message",
  "kind": "discord_message_batch",
  "source": "gateway_ws",
  "count": 1,
  "rows": [
    {
      "messageId": "...",
      "channelId": "...",
      "content": "...",
      "authorUsername": "...",
      "createdAtMs": 1717745825000
    }
  ],
  "channels": [
    {
      "channelId": "...",
      "lastMessagePreview": "...",
      "lastMessageAtMs": 1717745825000
    }
  ],
  "cdpChannelId": "...",
  "cdpGuildId": "..."
}
```

Gateway 实时消息即使已在库中（REST 先拉过历史），也会推前端，保证 Show 页实时刷新。

---

## 二、数据流（Discord → 前端）

```
Chrome（Discord 网页）
    │
    ▼ CDP 监听 Gateway WS / REST
cdp-ws-monitor
    │
    ├─► discord-message-ingest（解析、入库 MySQL）
    │       │
    │       ├─► signal-card-service（信号卡片）
    │       └─► broadcast("message" | "meta", …)
    │
    └─► broadcast("frame" | "diag", …)
            │
            ▼
    WebSocket /ws（所有客户端）
            │
            ▼
    useCollectorSocket（Vue 全局单连接）
            │
            ├─► ShowView        — message + meta
            ├─► MessagesView    — message
            ├─► DebugView       — frame + diag
            └─► NewCardToast    — meta（signal_card_created / card_archived）
```

**HTTP 与 WS 分工：**

| 方式 | 用途 |
|------|------|
| `GET /api/*` | 首次加载历史（消息、帧、卡片列表等） |
| `POST /api/*` | 用户操作（建卡、改评价、归档等） |
| `WebSocket /ws` | 入库或状态变化后的**实时推送** |

手动建卡示例：`POST /api/discord/signal-cards` → 入库 → `broadcast("meta", { kind: "signal_card_created", card })` → 各页面同步收到。

---

## 三、前端如何接收

### 3.1 连接管理

入口：`collector-ui-vue/src/main.js` 启动时调用 `ensureCollectorSocket()`，全局只维护**一条** WebSocket。

实现：`collector-ui-vue/src/composables/useCollectorSocket.js`

- 连接地址：`ws(s)://{location.host}/ws`（**相对当前页面域名**，不写死端口）
- 断线后指数退避重连（最长 15s）
- 使用 `Set<handler>` 分发消息，各页面注册回调

```js
// 组件内订阅
useCollectorSocket((msg) => {
  if (msg.channel === "message" && msg.kind === "discord_message_batch") {
    // 更新消息列表
  }
});

// 模块级订阅（如 Toast）
subscribeCollectorSocket(handleNewCardSocketMessage);
```

### 3.2 各页面关注点

| 消费者 | 过滤条件 |
|--------|----------|
| **ShowView** | `message` 批次；`meta` 中的 guild/channel/信号卡/CDP 频道 |
| **MessagesView** | `message` 批次 |
| **DebugView** | `frame`、`diag` |
| **useNewCardNotifications** | `meta.signal_card_created`、`meta.card_archived` |
| **App.vue** | 连接状态展示、手动重连 |

---

## 四、本地运行（开发）

本地开发需要**两个进程**：后台负责采集与推送，Vite 负责前端热更新并代理 API/WS。

### 4.1 终端 A — 后台

```bash
cd discord-collector
cp .env.example .env   # 配置 MySQL、CDP_CONNECT_URL 等
pnpm install
pnpm run collect:ui
```

确认日志：

```
Discord Collector UI  http://127.0.0.1:3851/
WS ws://127.0.0.1:3851/ws
```

### 4.2 终端 B — 前端 Dev

```bash
cd discord-collector
pnpm run dev:ui-vue
```

Vite（默认 `5178`）将请求代理到本地后台：

| 浏览器请求 | 实际转发 |
|------------|----------|
| `http://localhost:5178/api/*` | `http://127.0.0.1:3851/api/*` |
| `ws://localhost:5178/ws` | `ws://127.0.0.1:3851/ws` |

配置见 `collector-ui-vue/vite.config.js`（`COLLECTOR_UI_PORT` 默认 `3851`）。

### 4.3 本地验证推送

1. Chrome 带 CDP 登录 Discord（见 [README.md](../README.md)）
2. 打开 `http://localhost:5178/show`
3. 页头 **「WS 已连接」** 为绿色
4. Discord 频道有新消息 → Show 列表应实时更新，无需刷新
5. 浏览器 F12 → Network → WS → `/ws` → Messages 面板可见 JSON 推送

### 4.4 本地单进程（不跑 Vite）

也可只跑后台，由 collect:ui 直接托管构建产物：

```bash
pnpm run ui:build      # 构建到 public/collector-ui/
pnpm run collect:ui    # 同时提供静态页 + API + WS
```

访问 **http://127.0.0.1:3851/show**，API 与 WS 同域，无需代理。

---

## 五、前端部署到服务器后如何推送

前端代码中 API 与 WebSocket **均使用相对路径**（`/api`、`/ws`），不硬编码 `127.0.0.1:3851`。因此部署的关键是：**让用户浏览器访问的域名下，`/api` 与 `/ws` 能到达 collect:ui 进程**。

推送链路不变：Discord → 本地 CDP → collect:ui `broadcast()` → WebSocket → 用户浏览器。变化的是 **WS 连接如何穿越网络**。

### 5.1 方案对比

| 方案 | 前端 | 后台 collect:ui | 适用场景 |
|------|------|-----------------|----------|
| **A. 前后端同机** | Nginx 静态 + 反代 | 同服务器 `127.0.0.1:3851` | 服务器也能跑 Chrome/CDP |
| **B. 前端远程、后台本地** | 远程 Nginx 静态 | 本地 Mac + SSH 隧道 | **推荐**：采集必须在本地 Chrome |
| **C. 整站反代** | 不单独上传静态 | 本地 collect:ui + 隧道 | 临时调试、内网 |

> 采集依赖本地 Chrome CDP，**后台通常仍跑在本地**；远程服务器主要托管静态前端并反代 API/WS。完整步骤见 [deploy-frontend-remote-backend-local.md](./deploy-frontend-remote-backend-local.md)。

### 5.2 方案 B 架构（前端上云、后台本地）

```
[用户浏览器]  https://ui.example.com/show
       │
       ▼
[远程 Nginx]
   ├─ /              → /var/www/discord-collector-ui（ui:build 产物）
   ├─ /api/*         → http://127.0.0.1:3851  （服务器本机，隧道入口）
   └─ /ws            → http://127.0.0.1:3851  （WebSocket 升级）
                              ▲
                              │ SSH -R 127.0.0.1:3851:127.0.0.1:3851
                              │
[本地 Mac/PC]
   ├─ pnpm run collect:ui  → 127.0.0.1:3851
   ├─ MySQL
   └─ Chrome + Discord
```

**构建并上传前端：**

```bash
cd discord-collector
pnpm run ui:build
rsync -avz --delete public/collector-ui/ user@your-server:/var/www/discord-collector-ui/
```

**本地建立反向隧道（保持常开）：**

```bash
ssh -N -R 127.0.0.1:3851:127.0.0.1:3851 user@your-server
```

**远程 Nginx 关键配置（WebSocket 必须升级）：**

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3851;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_read_timeout 300s;
}

location /ws {
    proxy_pass http://127.0.0.1:3851;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400s;
}
```

用户访问 `https://ui.example.com/show` 时：

1. 浏览器加载远程静态 JS
2. JS 连接 `wss://ui.example.com/ws`（与页面同域）
3. Nginx 将 WS 升级到服务器 `127.0.0.1:3851`
4. SSH 隧道转发到**本地** collect:ui
5. 本地 Discord 有新消息 → `broadcast` → 经隧道 → Nginx → 浏览器

**验证：**

```bash
# 本地
curl -s http://127.0.0.1:3851/api/config

# 服务器（隧道正常时）
ssh user@server 'curl -s http://127.0.0.1:3851/api/config'

# 经 Nginx
curl -s https://ui.example.com/api/config
```

浏览器 Network → WS → Status **101**，且持续收到 `discord_message_batch` 即推送正常。

### 5.3 方案 A：前后端都在同一台服务器

若服务器上也能运行 Chrome（带 GUI 或远程桌面）和 MySQL：

```bash
# 服务器上
pnpm run ui:build
pnpm run collect:ui   # 监听 127.0.0.1:3851
```

Nginx 配置与方案 B 相同，只是 `proxy_pass http://127.0.0.1:3851` 指向**本机** collect:ui，无需 SSH 隧道。

### 5.4 外部服务消费推送

任何能连上 `/ws` 的客户端均可订阅同一广播流（与 Vue 前端并列）：

```javascript
const ws = new WebSocket("wss://ui.example.com/ws");
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.channel === "message" && msg.kind === "discord_message_batch") {
    console.log(msg.rows);
  }
  if (msg.channel === "meta" && msg.kind === "signal_card_created") {
    console.log(msg.card);
  }
};
```

补历史仍走 REST（同样需反代到 collect:ui）：

```
GET https://ui.example.com/api/discord/messages?channel_id=频道ID&limit=200
```

---

## 六、常见问题

### WS 未连接 / 连接失败

| 检查项 | 说明 |
|--------|------|
| collect:ui 是否运行 | 本地 `curl http://127.0.0.1:3851/api/config` |
| 开发模式是否双终端 | 仅 `dev:ui-vue` 而无 `collect:ui` 会代理失败 |
| SSH 隧道是否断开 | 服务器上 `curl http://127.0.0.1:3851/api/config` |
| Nginx `/ws` 配置 | 必须有 `Upgrade` / `Connection: upgrade` |
| HTTPS 与 WS 协议 | HTTPS 页面必须用 `wss://`（由 Nginx 终止 SSL） |

### 页面能开但没有实时消息

- Chrome 是否登录 Discord，CDP 是否连上（看 collect:ui 日志）
- MySQL 是否在线（离线模式无持久化，部分功能受限）
- 本地电脑休眠后 CDP 断连，需重启 Chrome + collect:ui + 隧道

### 有 HTTP 无 WS 推送

- 确认不是只部署了静态文件而未反代 `/ws`
- 某些 CDN / 负载均衡默认不支持 WebSocket，需在边缘开启 WS 支持

---

## 七、安全说明

- WebSocket / API **无内置鉴权**，不要将 `3851` 直接暴露公网
- 推荐：collect:ui 只监听 `127.0.0.1` + SSH 隧道 + Nginx HTTPS
- 必要时在 Nginx 增加 `auth_basic`、IP 白名单或 VPN

---

## 八、相关源码与命令

| 路径 | 说明 |
|------|------|
| `src/collector-ui-server.js` | `broadcast()`、WebSocketServer |
| `src/discord-message-ingest.js` | `message` / `meta` 推送 |
| `src/discord-signal-card-service.js` | `signal_card_created` |
| `collector-ui-vue/src/composables/useCollectorSocket.js` | 前端连接与分发 |
| `collector-ui-vue/vite.config.js` | 开发代理 `/api`、`/ws` |

```bash
pnpm run collect:ui     # 后台 + API + WS（可选托管静态）
pnpm run dev:ui-vue     # 前端开发（代理到 3851）
pnpm run ui:build       # 构建静态产物 → public/collector-ui/
```

环境变量：`COLLECTOR_UI_PORT=3851`（与隧道、Nginx 保持一致）。
