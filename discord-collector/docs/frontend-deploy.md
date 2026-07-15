# discord-collector 前端部署手册

本文说明 **Vue 前端**（`collector-ui-vue`）如何构建、发布与上线验证。  
前端 API / WebSocket **全部使用相对路径**（`/api`、`/ws`），部署时只需保证同域名反代通到后台即可，**无需改前端代码**。

后台采集（Chrome CDP）细节与「前端上云 + 后台在本地」完整链路见：

- [deploy-frontend-remote-backend-local.md](./deploy-frontend-remote-backend-local.md)
- [websocket-push-architecture.md](./websocket-push-architecture.md)

---

## 1. 技术信息

| 项 | 说明 |
|----|------|
| 源码目录 | `collector-ui-vue/` |
| 构建命令 | `pnpm run ui:build` |
| 产物目录 | `public/collector-ui/` |
| 路由模式 | Vue Router **history**（需 Nginx `try_files … /index.html`） |
| 开发命令 | `pnpm run dev:ui-vue`（默认代理 `/api`、`/ws` → `COLLECTOR_UI_PORT`，多在 3851） |
| 访客统计 | Umami：`https://bz.ezcoin.ink/script.js`（已写在 `index.html`） |

主要页面路径：

| 路径 | 页面 |
|------|------|
| `/` | 首页 |
| `/show` | Discord Show |
| `/cards` | 卡片归档 |
| `/fetch` | YouTube 拉取 |
| `/archives` | 文稿 |
| `/trade` | 下单 |
| `/debug` | Debug |

---

## 2. 部署形态选择

| 方案 | 前端放哪 | 后台 collect:ui | 适用 |
|------|----------|-----------------|------|
| **A. 同机一体** | 本机 `public/collector-ui`，由 collect:ui 直接托管 | 同机 `127.0.0.1:3851` | 开发机自用、内网 |
| **B. 前端上服务器** | Nginx 托管静态产物 | 同服务器或经隧道到本地 | **生产推荐** |
| **C. 仅 Vite 开发** | 不构建 | 本机 `pnpm run collect:ui` | 改 UI 时热更新 |

采集依赖本机 Chrome CDP 时，通常选 **B：静态前端上服务器 + 后台在本地 + SSH 隧道**。

---

## 3. 本地构建

```bash
cd discord-collector
pnpm install
pnpm run ui:build
```

成功后检查：

```
public/collector-ui/
├── index.html          # 含 Umami script
└── assets/
    ├── index-xxxx.js
    └── index-xxxx.css
```

> 修改 `collector-ui-vue/index.html`（含 Umami）、路由、页面后，**必须重新 `ui:build`** 再发布，服务器上的旧静态文件不会自动更新。

---

## 4. 方案 A：本机一体（最小上线）

后台会托管 `public/collector-ui`：

```bash
pnpm run ui:build
pnpm run collect:ui
```

浏览器打开：

- http://127.0.0.1:3851/
- http://127.0.0.1:3851/show

页头 **「WS 已连接」** 为绿色即正常。

---

## 5. 方案 B：服务器静态部署（推荐）

### 5.1 上传产物

把本地构建结果同步到服务器（路径可自定）：

```bash
# 本机
cd discord-collector
pnpm run ui:build

rsync -avz --delete \
  public/collector-ui/ \
  user@your-server:/var/www/discord-collector-ui/
```

也可用 `scp`：

```bash
scp -r public/collector-ui/* user@your-server:/var/www/discord-collector-ui/
```

### 5.2 Nginx（静态 + API + WebSocket）

假设域名 `ui.example.com`，后台在服务器本机 `127.0.0.1:3851`（本机进程，或 SSH 反向隧道进来）：

```nginx
server {
    listen 443 ssl http2;
    server_name ui.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    root /var/www/discord-collector-ui;
    index index.html;

    # history 路由：除真实文件外回落 index.html
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

    # WebSocket 必须 Upgrade，否则页头一直「WS 未连接」
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

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 5.3 后台在本地时的隧道

在**采集机**保持隧道（服务器 3851 → 本地 3851）：

```bash
ssh -N -R 127.0.0.1:3851:127.0.0.1:3851 user@your-server
```

本地须先运行：

```bash
pnpm run collect:ui
```

隧道保活、frp 等见 [deploy-frontend-remote-backend-local.md](./deploy-frontend-remote-backend-local.md)。

---

## 6. 日常发版（改完前端后）

```bash
# 1. 本机构建
cd discord-collector
pnpm run ui:build

# 2. 上传覆盖服务器静态目录
rsync -avz --delete public/collector-ui/ user@your-server:/var/www/discord-collector-ui/

# 3. 浏览器强刷验证（Ctrl+F5 / Cmd+Shift+R）
#    https://ui.example.com/show
```

后台代码若**未改**，一般不必重启 `collect:ui`。  
仅前端静态文件变更时，**不需要**重载 Nginx（除非改了 Nginx 配置本身）。

---

## 7. Umami 访客统计

`collector-ui-vue/index.html` 已嵌入：

```html
<script defer
  src="https://bz.ezcoin.ink/script.js"
  data-website-id="2a409684-5ffa-4c8c-8b28-68c2b22c21ee"></script>
```

- 数据后台：[https://bz.ezcoin.ink](https://bz.ezcoin.ink)
- SPA 切页由脚本 hook `history.pushState` 自动上报
- **改 website-id 或 script 地址后**须重新 `ui:build` 再同步服务器
- Umami 站点域名需与你线上前端域名一致（或按 Umami 后台域名白名单配置）

浏览器 F12 → Network 可看到对 `bz.ezcoin.ink/api/send` 的 POST，即上报成功。

---

## 8. 上线检查清单

| # | 检查项 | 预期 |
|---|--------|------|
| 1 | `pnpm run ui:build` | 退出码 0，存在 `public/collector-ui/index.html` |
| 2 | 服务器目录已更新 | `index.html` 内可搜到 `bz.ezcoin.ink` / website-id |
| 3 | HTTPS 打开 `/show` | 页面渲染正常，无大量 404 |
| 4 | 刷新 `/show`、`/cards` | 不出现 Nginx 404（`try_files` 正确） |
| 5 | `curl -s https://ui.example.com/api/config` | 返回 JSON `ok: true` |
| 6 | 页头 WS 状态 | **「WS 已连接」**（绿色） |
| 7 | F12 → Network → WS | `/ws` Status **101** |
| 8 | Discord 有新消息 | Show 列表实时更新 |
| 9 | Umami | Network 有 `api/send`；后台可见 PV |

---

## 9. 常见问题

### 刷新子路由 404

未配置 `try_files $uri $uri/ /index.html`。history 模式必须回落 `index.html`。

### WS 一直断开 / 显示未连接

1. Nginx `/ws` 是否带 `Upgrade` / `Connection`
2. 服务器 `127.0.0.1:3851` 是否可达（隧道是否还开着）
3. 本地 `collect:ui` 是否在跑：`curl http://127.0.0.1:3851/api/config`

### 页面是旧版

CDN / 浏览器缓存：强刷；或确认 `rsync --delete` 已覆盖 `assets/` 哈希文件。

### `/api` 502

隧道断了，或 collect:ui 未启动，或 Nginx `proxy_pass` 端口不对。

### 开发时 Vite 端口不对

不要在命令后写 shell `# 注释`（会被当成参数）。以终端打印的 `Local:` 为准。

---

## 10. 快速命令备忘

```bash
# 开发
pnpm run collect:ui          # 终端 A：API + WS +（可选）静态托管
pnpm run dev:ui-vue          # 终端 B：Vite 热更新

# 构建 & 发布
pnpm run ui:build
rsync -avz --delete public/collector-ui/ user@host:/var/www/discord-collector-ui/

# 本机一体化验证
pnpm run ui:build && pnpm run collect:ui
# 打开 http://127.0.0.1:3851/show
```
