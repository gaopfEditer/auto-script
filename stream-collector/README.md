# stream-collector

CDP 监听页面 WebSocket 帧、可选落库 MySQL，并提供 Vue 调试面板（网络请求 / WS 帧实时展示）。

## 环境准备

1. 在 **`stream-collector/`** 下复制并编辑 **`.env`**（参考仓库内已有示例；勿提交含密钥的 `.env`）。
2. 需要 **MySQL** 与库表（与 `store.js` / 项目迁移一致）。
3. 若只看打包后的面板：执行一次 **`pnpm run ui:build`**，生成 `public/collector-ui/`。

## 推荐：双终端联调（与以前 `collect:ui` 一致）

采集进程自带 **静态页 + `/ws` 实时推送 + CDP**；再用 Vite 开发 Vue 时，通过代理连到同一套后端。

### 终端 A — 采集 + 面板后端

```bash
cd stream-collector
pnpm install   # 首次
pnpm run collect:ui
```

成功后会监听 **`COLLECTOR_UI_PORT`**（默认 **3840**），提供：

- 静态 UI：`http://127.0.0.1:3840/`（需已 `pnpm run ui:build` 才有完整页面）
- WebSocket：`ws://127.0.0.1:3840/ws`
- HTTP API：`http://127.0.0.1:3840/api/frames`
- **`POST /api/cdp/kook-channel`**：JSON `{ "guildId", "channelId" }`，在 CDP 已挂载的 Kook 标签页执行 `goto` 到官方直链 `https://www.kookapp.cn/direct/channel?g={guildId}&c={channelId}`（不依赖 `/app/channels/...` 路径里两段 ID 谁先谁后）；多标签时按当前标签 URL 与 g/c 的匹配度选页，**不会**去页面里查找带 `/app/channels/` 的 `<a>`；`/show` 左侧点频道时会调用。

日志里也会提示上述地址。

### 终端 B — Vue 开发（可选）

```bash
cd stream-collector
pnpm run dev:ui-vue
```

默认 **http://localhost:5174/**（若端口被占用，Vite 会顺延如 **5175**，以终端输出为准）。

`collector-ui-vue/vite.config.js` 将 **`/api`**、**`/ws`** 代理到 **`http://127.0.0.1:${COLLECTOR_UI_PORT}`**（在 **`stream-collector/.env`** 里读取 `COLLECTOR_UI_PORT`，未设则 **3840**），因此：

- 浏览器请打开 **Vite 打印的 Local 地址**（例如 `http://localhost:5175/`），不要只开 3840 却期待热更新。
- **须先保证终端 A 已启动**，否则前端代理连不上，网络面板无数据。
- **改 `.env` 里的 `COLLECTOR_UI_PORT`、或更新过 `vite.config.js` 后：必须重启终端 A 与终端 B**，否则 Vite 仍可能代理到旧端口，出现 **`POST /api/cdp/kook-channel` → 404**。终端 B 启动时会在控制台打印一行 **`[collector-ui-vue] dev 服务端口 … /api、/ws → http://127.0.0.1:xxxx`**，请与终端 A 里 `Collector UI …` 的端口核对一致。
- **`/show` 本地缓存**：`localStorage` 键 **`stream-collector.show.v1`**，保存频道树、各频道 REST 消息、当前选中项与部分 CDP 行摘要，**刷新页面后先恢复再请求** `/api/frames`（单频道消息与 CDP 行有条数上限以控制体积）。

### 常见顺序小结

1. 配好 `.env`（含 MySQL、`TARGET_PAGE_URL` / `CDP_CONNECT_URL` 等）。
2. 需要静态资源时：`pnpm run ui:build`。
3. **终端 A**：`pnpm run collect:ui`（看到 `Collector UI … 127.0.0.1:端口` 后再开 B）。
4. **终端 B**（改 Vue 时用）：`pnpm run dev:ui-vue`，用终端里给出的 **Local** URL 访问；**启动日志里应出现 `[collector-ui-vue] … /api、/ws → http://127.0.0.1:xxxx`**，该 `xxxx` 须与终端 A 端口相同。

按 **Ctrl+C** 可分别结束两个进程；先关采集再关 Vite 亦可。

## Kook 完整做单 → Telegram（Ollama + WS）

在 **`stream-collector/.env`** 配置：

- `KOOK_GROUPS_PUSH`：监听的 Kook 群组 id（逗号分隔，可与 `KOOK_TRADE_PUSH_GUILD_IDS` 合并）
- `TELEGRAM_PUSH_CHAT_ID`：目标 Telegram 会话 id（如 `-5289237674`）
- `TELEGRAM_SEND_URL`：发送 API，默认 `http://127.0.0.1:8000/api/telegram/send`
- `OLLAMA_GENERATE_URL` / `OLLAMA_MODEL`：本机 Ollama（默认 `http://127.0.0.1:11434/api/generate`、`gemma-uncensored`）

**仅处理实时 socket 来源**（`ws_desktop` / 前端 WS 合并），不扫 REST 历史。Ollama 判断两类需推送信号：`kind=full` 完整做单、`kind=adjust` 仅改止盈/止损/芷楹等持仓调整。

- **Telegram**：`isSign=true` 时发 AI 极简一句（`TELEGRAM_PUSH_CHAT_ID`）
- **publish/signal**：`KOOK_GROUPS_PUSH` 内群组在 `isSign=true` 时 POST 原文到 `SIGNAL_PUBLISH_URL`；`style_ids` 与 `STYLES_GROUPS_PUSH` **按群组顺序一一对应**，未匹配则用第一项；`strategy_id` 等见 `SIGNAL_PUBLISH_*`

AI 失败时可回退正则（`OLLAMA_TRADE_CLASSIFY_FALLBACK_REGEX=1`）。

## 其它启动方式（简表）

| 场景 | 命令 | 说明 |
|------|------|------|
| 仅采集写库、不要面板 WS | `pnpm run collect` | 无 `/ws`；若仍开 `dev:ui-vue`，需在 `.env` 设 **`COLLECTOR_UI_EMBED=1`** 或改用 `collect:ui` |
| 采集 + 嵌入式 WS（单进程） | `pnpm run collect:live` 或 `.env` 中 `COLLECTOR_UI_EMBED=1` 后 `pnpm collect` | 与 Vite 联调时给 3840 提供 `/ws`、`/api` |
| 仅测上游 WS | `pnpm run bridge` / `pnpm run test-ws` | 见各自脚本 |

## 端口与代理

- **采集 UI 端口**：环境变量 **`COLLECTOR_UI_PORT`**（写在 **`stream-collector/.env`**），默认 **3840**。
- **Vite**：`vite.config.js` 用 **`loadEnv`** 读同一目录下的 **`COLLECTOR_UI_PORT`**，与 `collect:ui` 对齐；改端口后 **两个进程都要重启**。
- **Vite 自身端口**：默认 **5174**，被占用时自动顺延（以终端输出为准）。

若本机 **3840** 已被其它程序占用，请在 **`stream-collector/.env`** 里设置 **`COLLECTOR_UI_PORT`** 为空闲端口，然后 **重启 `collect:ui` 与 `dev:ui-vue`**；勿只改一处不重启。
