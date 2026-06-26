# 前端部署在服务器 + 后台运行在本地

适用场景：

- **本地**：Chrome（CDP）登录 Discord + `pnpm run collect:ui`（采集、MySQL、WebSocket 推送）
- **远程服务器**：只部署 Vue 静态前端（Show / 信号 / Debug 页面）
- **浏览器访问**：`https://你的域名/show`，API 与 WebSocket 经服务器反代回本地后台

前端代码里 API 与 WS 均使用**相对路径**（`/api`、`/ws`），因此只要 Nginx 把同域名的 `/api`、`/ws` 转发到本地后台即可，**无需改前端代码**。

---

## 架构示意

```
[用户浏览器]
    │ HTTPS  https://ui.example.com/show
    ▼
[远程 Nginx]
    ├─ /          → 静态文件（ui:build 产物）
    ├─ /api/*     → 127.0.0.1:3851（本机隧道入口）
    └─ /ws        → 127.0.0.1:3851（WebSocket 升级）
                          ▲
                          │ SSH 反向隧道 / frp
                          │
[你的 Mac/PC 本地]
    ├─ pnpm run collect:ui  → 127.0.0.1:3851
    ├─ MySQL（消息、信号卡片）
    └─ Chrome --remote-debugging-port=9222 + Discord 网页
```

---

## 一、本地环境（采集机）

### 1. 配置 `.env`

```bash
cd discord-collector
cp .env.example .env
# 配置 MySQL、CDP_CONNECT_URL、信号频道、Telegram 等
```

关键项：

| 变量 | 示例 | 说明 |
|------|------|------|
| `CDP_CONNECT_URL` | `http://127.0.0.1:9222` | 本地 Chrome 调试端口 |
| `COLLECTOR_UI_PORT` | `3851` | 后台 API/WS 端口（与隧道、Nginx 一致） |
| `MYSQL_*` | … | 消息落库在**本地** MySQL |

### 2. 启动 Chrome（带 CDP）

macOS 示例：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.discord-collector-chrome"
```

在 Chrome 中打开 **https://discord.com** 并登录。

### 3. 启动后台

```bash
cd discord-collector
pnpm install
pnpm run collect:ui
```

确认日志中有：

```
Discord Collector UI  http://127.0.0.1:3851/
WS ws://127.0.0.1:3851/ws
```

本地可先访问 http://127.0.0.1:3851/show 验证采集正常。

> 后台默认只监听 `127.0.0.1`，不直接暴露到公网，这是预期行为；外网通过**隧道 + Nginx 反代**访问。

---

## 二、构建前端静态资源

在**本地或 CI** 执行（与后台版本保持一致）：

```bash
cd discord-collector
pnpm run ui:build
```

产物目录：

```
discord-collector/public/collector-ui/
├── index.html
└── assets/
```

将整个 `collector-ui/` 目录上传到服务器，例如：

```bash
rsync -avz --delete public/collector-ui/ user@your-server:/var/www/discord-collector-ui/
```

---

## 三、本地 → 服务器：反向隧道

让**远程服务器上的 3851 端口**转发到你**本地的 3851**（collect:ui）。

### 方式 A：SSH 反向隧道（推荐）

在**本地**执行（将 `user@your-server` 换成你的 SSH 账号）：

```bash
ssh -N -R 127.0.0.1:3851:127.0.0.1:3851 user@your-server
```

说明：

- `-R 127.0.0.1:3851:127.0.0.1:3851`：隧道只绑在服务器 **127.0.0.1**，不直接对公网开放后台，由 Nginx 反代访问更安全
- 保持该终端常开；断线后需重连

**长期保活（autossh）**：

```bash
# macOS: brew install autossh
autossh -M 0 -f -N \
  -o "ServerAliveInterval=30" \
  -o "ServerAliveCountMax=3" \
  -R 127.0.0.1:3851:127.0.0.1:3851 \
  user@your-server
```

### 方式 B：frp / ngrok 等

若无法 SSH，可用 frp 将本地 `3851` 映射到 frp 服务端某内网地址，Nginx 再 `proxy_pass` 到该地址。原理与 SSH 隧道相同：远程 Nginx 能访问到一个指向本地 collect:ui 的 HTTP 入口即可。

---

## 四、远程 Nginx 配置

示例：`ui.example.com` 提供 HTTPS，静态前端 + 反代 API/WS。

```nginx
server {
    listen 443 ssl http2;
    server_name ui.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    root /var/www/discord-collector-ui;
    index index.html;

    # Vue Router history 模式：除 /api、/ws、静态资源外回落 index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3851;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
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
}
```

重载 Nginx：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

访问：**https://ui.example.com/show**

页面顶部 **「WS 已连接」** 为绿色即表示 WebSocket 经反代连上本地后台。

---

## 五、验证清单

| 步骤 | 命令 / 操作 | 预期 |
|------|-------------|------|
| 本地后台 | `curl -s http://127.0.0.1:3851/api/config` | `{"ok":true,...}` |
| 服务器隧道 | `ssh user@server 'curl -s http://127.0.0.1:3851/api/config'` | 同上 JSON |
| 经 Nginx | `curl -s https://ui.example.com/api/config` | 同上 JSON |
| WebSocket | 浏览器 F12 → Network → WS → `/ws` | Status 101，持续收消息 |
| 实时消息 | Discord 网页有新消息 | Show 页列表更新 |

---

## 六、WebSocket 消息（给自建同步服务参考）

外部脚本也可直连（经 Nginx 同域或单独暴露）：

```
wss://ui.example.com/ws
```

每条推送为 JSON，例如 Discord 实时消息：

```json
{
  "v": 1,
  "ts": 1717745825083,
  "channel": "message",
  "kind": "discord_message_batch",
  "source": "gateway_ws",
  "rows": [ { "messageId": "...", "channelId": "...", "content": "..." } ]
}
```

补历史（REST，同样走 `/api`）：

```
GET https://ui.example.com/api/discord/messages?channel_id=频道ID&limit=200&order=asc
```

---

## 七、常见问题

### 1. 页面能开，但「WS 未连接 / 失败」

- 本地 `collect:ui` 是否在跑
- SSH 反向隧道是否断开（服务器上 `curl http://127.0.0.1:3851/api/config`）
- Nginx `/ws` 是否配置了 `Upgrade` / `Connection` 头
- 若只用 HTTP 访问，WS 为 `ws://`；HTTPS 站点必须用 `wss://`（Nginx 终止 SSL 即可）

### 2. API 502 Bad Gateway

- 隧道未建立或本地 3851 未监听
- 服务器防火墙未拦 3851（应只监听 127.0.0.1，由 Nginx 转发）

### 3. 刷新子路由 404（如 `/show`）

- Nginx 需 `try_files ... /index.html`（见上文配置）

### 4. 本地电脑休眠后无数据

- CDP 会断连；唤醒后重启 Chrome + `collect:ui`，并重连 SSH 隧道
- 已配置 CDP 断连 Telegram 提醒时可关注推送

### 5. 数据存在哪？

- **MySQL 在本地**，不在远程服务器（除非你把 MySQL 也迁到服务器并改 `.env`）
- 远程只托管静态前端 + 反代流量

---

## 八、简化方案（不单独部署前端）

若不需要「前端与后台分离」，可只做隧道暴露**整个** collect:ui：

```bash
# 本地
pnpm run ui:build && pnpm run collect:ui

# SSH 本地端口转发到服务器（或 frp 暴露 3851）
ssh -R 127.0.0.1:3851:127.0.0.1:3851 user@your-server
```

Nginx 整站反代到 `127.0.0.1:3851`（无需单独上传静态文件）。适合临时使用或内网调试。

---

## 九、安全建议

- WebSocket / API **无内置鉴权**，勿将 `3851` 直接暴露公网
- 使用 **127.0.0.1 绑定隧道** + Nginx + HTTPS
- 必要时在 Nginx 增加 `auth_basic`、IP 白名单或 VPN
- `.env`、MySQL 密码、Telegram token 不要提交到仓库

---

## 十、相关命令速查

```bash
# 本地
pnpm run collect:ui          # 后台 + 内置静态（可选）
pnpm run ui:build            # 仅构建前端到 public/collector-ui
pnpm run dev:ui-vue          # 本地开发（Vite 代理 /api、/ws → 3851）

# 环境变量
COLLECTOR_UI_PORT=3851       # 与隧道、Nginx 一致
CDP_CONNECT_URL=http://127.0.0.1:9222
```

更多 API 说明见项目根目录 [README.md](../README.md)。
