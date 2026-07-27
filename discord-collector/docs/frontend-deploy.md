# discord-collector 前端部署手册

本文说明 **Vue 前端**（`collector-ui-vue`）如何构建、发布与上线验证，以及 **与本地后台的通信方式（含 frp）**。

前端 API / WebSocket **全部使用相对路径**（`/api`、`/ws`），部署时只要保证「用户访问的域名」下同路径能转到后台即可，**无需在前端写死后台 IP**。

相关文档：

- [deploy-frontend-remote-backend-local.md](./deploy-frontend-remote-backend-local.md) — SSH 隧道方案
- [websocket-push-architecture.md](./websocket-push-architecture.md) — WS 推送架构

---

## 1. 两种界面模式

| 模式 | 何时生效 | 导航 / 路由 | 典型用途 |
|------|----------|-------------|----------|
| **local** | `pnpm run dev:ui-vue`，或 `VITE_UI_MODE=local` | **全部页面**（Show / 卡片 / 拉取 / 文稿 / 下单 / Debug…） | 本机开发、运维调试 |
| **deploy** | `pnpm run ui:build`（生产构建默认），或 `VITE_UI_MODE=deploy` | **仅配置的页面**（默认 **Show + 卡片 + OI**） | 服务器静态站点、对外展示 |

默认规则（未手动设 `VITE_UI_MODE` 时）：

- 开发服（`import.meta.env.DEV`）→ **local**
- 生产构建（`ui:build`）→ **deploy**

内置环境文件：

| 文件 | 作用 |
|------|------|
| `.env.development` | `VITE_UI_MODE=local` |
| `.env.production` | `VITE_UI_MODE=deploy` + `VITE_UI_PAGES=show,cards,oi` |

### 1.1 配置项

在 `discord-collector/.env` 或 `.env.production` 中：

```env
# local = 全开；deploy = 仅白名单页面
VITE_UI_MODE=deploy

# 部署版可见页面（逗号分隔，对应路由 name）
# 可选：show, cards, fetch, archives, trade, signals, debug, home
VITE_UI_PAGES=show,cards,oi
```

示例：部署版还要开放 Debug：

```env
VITE_UI_MODE=deploy
VITE_UI_PAGES=show,cards,oi,debug
```

> **改 `VITE_UI_*` 后必须重新 `pnpm run ui:build`**，变量在构建期打进 JS，不会读取服务器运行时环境。

### 1.2 行为说明

- **deploy**：`/` 自动跳到默认页（优先 `/show`）；访问未开放路径会回落到默认页；顶栏只渲染白名单导航；未包含 `debug` 时隐藏「Debug / 精简模式」按钮。
- **local**：与原先一致，全部入口可用。

实现位置：`collector-ui-vue/src/lib/uiMode.js`、`router/index.js`、`App.vue`。

---

## 2. 技术信息

| 项 | 说明 |
|----|------|
| 源码目录 | `collector-ui-vue/` |
| 构建命令 | `pnpm run ui:build` → 默认 **deploy** 模式 |
| 产物目录 | `public/collector-ui/` |
| 路由模式 | Vue Router **history**（需 Nginx `try_files … /index.html`） |
| 开发命令 | `pnpm run dev:ui-vue` → 默认 **local**；代理 `/api`、`/ws` → `COLLECTOR_UI_PORT`（默认 **3851**） |
| 后台端口 | `COLLECTOR_UI_PORT`，默认 **3851**，监听 `127.0.0.1` |
| 访客统计 | Umami：`https://bz.ezcoin.ink/script.js`（写在 `index.html`） |

| 路径 | 页面 | local | deploy 默认 |
|------|------|:-----:|:-----------:|
| `/show` | Discord Show | ✓ | ✓ |
| `/cards` | 卡片归档 | ✓ | ✓ |
| `/fetch` | YouTube 拉取 | ✓ | |
| `/archives` | 文稿 | ✓ | |
| `/trade` | 下单 | ✓ | |
| `/debug` | Debug | ✓ | |
| `/` | 首页 | ✓ | 重定向到 `/show` |

---

## 3. 前后端通信方式（核心）

浏览器只认识「当前站点」上的路径，不关心后台物理位置：

```
浏览器 ──► https://你的前端域名/show     （静态 HTML/JS）
浏览器 ──► https://你的前端域名/api/...  （HTTP API）
浏览器 ──► wss://你的前端域名/ws         （实时推送）
                │
                ▼
         Nginx / 网关（同域反代）
                │
                ▼
         可达的后台入口 → collect:ui :3851
```

因此有三种把 `/api`、`/ws` 接到本地后台的方式：

| 方式 | 说明 | 推荐场景 |
|------|------|----------|
| **A. 同机** | Nginx → 本机 `127.0.0.1:3851` | 服务器也能跑采集 |
| **B. SSH 反向隧道** | 服务器 `3851` ← SSH ← 本地 `3851` | 临时 / 已有 SSH |
| **C. frp** | 服务器 frps + 本地 frpc，把本地 3851 映射到服务器内网端口 | **生产常用**（你后续方案） |

前端**无需改代码**；改的是服务器上 Nginx 的 `proxy_pass` 目标。

---

## 4. 通信方案 C：frp（推荐给「前端上云、后台在本地」）

### 4.1 架构

```
[用户浏览器]
    │  HTTPS / WSS  →  https://ui.example.com
    ▼
[远程服务器]
    ├─ Nginx：静态 frontend（deploy 产物）
    ├─ Nginx：/api、/ws → 127.0.0.1:13851   ← frp 在服务器侧暴露的本地端口
    └─ frps（ frp 服务端 ）
              ▲
              │  frp 隧道（外网或内网穿透）
              │
[本地采集机]
    ├─ frpc（ frp 客户端 ）
    ├─ pnpm run collect:ui  → 127.0.0.1:3851
    ├─ MySQL、Chrome CDP + Discord
```

要点：

1. **静态页面**只在服务器；**采集与 MySQL**仍在本地。
2. 浏览器永远连 **同域名** 的 `/api`、`/ws`（相对路径）。
3. frp 只负责把「服务器上的某个端口」转到「本地 3851」，对浏览器透明。

### 4.2 frps（服务器）示例

```ini
# /etc/frp/frps.ini（按你实际 frp 版本调整）
[common]
bind_port = 7000
# 建议开启 token，与 frpc 一致
token = 你的强随机串
```

启动：`frps -c /etc/frp/frps.ini`（或 systemd）。

### 4.3 frpc（本地采集机）示例

把本机 `3851` 映射到**服务器本机回环**上的 `13851`（仅供 Nginx 访问，勿直接对公网开 13851）：

```ini
# frpc.ini（放在本地）
[common]
server_addr = 你的服务器IP或域名
server_port = 7000
token = 你的强随机串

[discord-collector-ui]
type = tcp
local_ip = 127.0.0.1
local_port = 3851
# 在 frps 所在机器上监听，供 Nginx proxy_pass
remote_port = 13851
```

> 若你的 frp 支持 `bind_addr = 127.0.0.1`（仅服务器本地监听），务必开启，避免把后台裸暴露在公网。

本地启动顺序：

```bash
# 1) 本地后台
cd discord-collector
pnpm run collect:ui

# 2) frp 客户端（保持常开）
frpc -c frpc.ini
```

### 4.4 Nginx（对接 frp 端口）

与纯本机后台相同，只是 `proxy_pass` 指向 frp 映射端口：

```nginx
server {
    listen 443 ssl http2;
    server_name ui.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    root /var/www/discord-collector-ui;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        # frp 映射到服务器本机的端口（示例 13851）
        proxy_pass http://127.0.0.1:13851;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    location /ws {
        proxy_pass http://127.0.0.1:13851;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
    }
}
```

若不用 frp、后台就在服务器本机，把 `13851` 改成 `3851` 即可。

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 4.5 frp 连通性自检

```bash
# 本地：后台是否起来
curl -s http://127.0.0.1:3851/api/config

# 服务器：能否经 frp 摸到本地后台
curl -s http://127.0.0.1:13851/api/config

# 公网经 Nginx
curl -s https://ui.example.com/api/config
```

三条都应返回含 `"ok":true` 的 JSON。页面顶栏应为 **「WS 已连接」**。

### 4.6 与 SSH 隧道对比

| | frp | SSH `-R` |
|--|-----|----------|
| 保活 | frpc + frps 服务常见 | 需 autossh / 手动重连 |
| 配置 | ini 清晰、可多隧道 | 一行命令即用 |
| 文档 | 本节 | [deploy-frontend-remote-backend-local.md](./deploy-frontend-remote-backend-local.md) |

两种可互换；Nginx 侧只换 `proxy_pass` 端口。

---

## 5. 本地构建与界面模式

```bash
cd discord-collector
pnpm install

# 生产构建 → 读取 .env.production → deploy 模式（默认仅 show+cards）
pnpm run ui:build
```

产物：

```
public/collector-ui/
├── index.html
└── assets/
```

临时打「全功能」静态包（少见）：

```bash
# Linux / macOS
VITE_UI_MODE=local pnpm run ui:build

# Windows PowerShell
$env:VITE_UI_MODE="local"; pnpm run ui:build
```

---

## 6. 方案 A：本机一体

```bash
pnpm run ui:build          # 得到 deploy 静态页
pnpm run collect:ui        # 同机托管静态 + API + WS :3851
```

访问 http://127.0.0.1:3851/show（部署包通常直接进 Show）。

开发时改 UI：

```bash
# 终端 A
pnpm run collect:ui
# 终端 B — local 全导航
pnpm run dev:ui-vue
```

---

## 7. 方案 B：服务器静态 + frp/隧道后台

### 7.1 上传前端（deploy 产物）

```bash
cd discord-collector
pnpm run ui:build

rsync -avz --delete \
  public/collector-ui/ \
  user@your-server:/var/www/discord-collector-ui/
```

### 7.2 本地后台 + frp

```bash
pnpm run collect:ui
frpc -c frpc.ini
```

### 7.3 服务器 Nginx

见上文 **§4.4**（`proxy_pass` → frp 端口）。

---

## 8. 日常发版

```bash
cd discord-collector
# 如需改可见页面，先编辑 .env.production 的 VITE_UI_PAGES
pnpm run ui:build
rsync -avz --delete public/collector-ui/ user@your-server:/var/www/discord-collector-ui/
# 浏览器强刷 https://ui.example.com/show
```

| 变更内容 | 是否重启 collect:ui | 是否 reload Nginx |
|----------|---------------------|-------------------|
| 仅前端页面 / `VITE_UI_*` | 否 | 否（强刷即可） |
| 仅后台 Node 代码 | 是 | 否 |
| Nginx / frp 端口变更 | 否 | 是 / 重启 frp |

---

## 9. Umami

`index.html` 已嵌入：

```html
<script defer
  src="https://bz.ezcoin.ink/script.js"
  data-website-id="2a409684-5ffa-4c8c-8b28-68c2b22c21ee"></script>
```

改 ID 后重新 `ui:build` 再同步。后台：[https://bz.ezcoin.ink](https://bz.ezcoin.ink)

---

## 10. 上线检查清单

| # | 检查项 | 预期 |
|---|--------|------|
| 1 | `ui:build` | 成功；产物存在 |
| 2 | 部署包导航 | 默认只有 **Show、卡片**（除非改了 `VITE_UI_PAGES`） |
| 3 | 本地 `curl :3851/api/config` | `ok: true` |
| 4 | 服务器经 frp `curl :13851/api/config` | `ok: true` |
| 5 | `https://域名/api/config` | `ok: true` |
| 6 | 页头 WS | **「WS 已连接」**；F12 里 `/ws` → **101** |
| 7 | Discord 新消息 | Show 实时更新 |
| 8 | 刷新 `/show`、`/cards` | 不 404 |
| 9 | Umami | 有 `api/send` 请求 |

---

## 11. 常见问题

### 部署后仍能看到「拉取 / 下单」等

构建时不是 **deploy**，或未同步最新产物。确认 `.env.production` 与发版后的 `assets/*.js` 为新构建。

### 只想改部署页却不动代码

改 `VITE_UI_PAGES` → 重新 `ui:build` → `rsync`。

### `/api` 502 或 WS 断开

1. 本地 `collect:ui` 是否在跑  
2. `frpc` 是否在线、`remote_port` 是否与 Nginx 一致  
3. Nginx `/ws` 是否带 `Upgrade` / `Connection`  

### 刷新子路由 404

缺少 `try_files $uri $uri/ /index.html`。

### frp 能 curl API，但浏览器 WS 失败

多半是 Nginx 只配了 `/api` 没配好 `/ws`，或中间层缓冲了 Upgrade；对照 **§4.4**。

---

## 12. 快速命令备忘

```bash
# —— 本地开发（local 全页面）——
pnpm run collect:ui
pnpm run dev:ui-vue

# —— 打部署包（deploy：默认 show+cards）——
pnpm run ui:build
rsync -avz --delete public/collector-ui/ user@host:/var/www/discord-collector-ui/

# —— 本地后台 + frp（示例）——
pnpm run collect:ui
frpc -c frpc.ini

# —— 自检 ——
curl -s http://127.0.0.1:3851/api/config
# 服务器上：
curl -s http://127.0.0.1:13851/api/config
curl -s https://ui.example.com/api/config
```

### 配置速查

| 变量 | 默认（生产） | 说明 |
|------|--------------|------|
| `VITE_UI_MODE` | `deploy` | `local` / `deploy` |
| `VITE_UI_PAGES` | `show,cards` | deploy 白名单 |
| `COLLECTOR_UI_PORT` | `3851` | 本地后台端口 |
| frp `local_port` | `3851` | 对本地 collect:ui |
| frp `remote_port` | 如 `13851` | 服务器侧，供 Nginx `proxy_pass` |
