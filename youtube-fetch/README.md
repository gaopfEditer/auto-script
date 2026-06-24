# youtube-fetch

通过 **CDP** 附着已启动的 Chrome，在 [youtube-transcript.ai](https://youtube-transcript.ai/) 页面上下文中拉取 YouTube 视频文字稿，并以 **HTTP API** 供外部调用。

底层使用站点公开的文稿接口：`GET /transcript/{VIDEO_ID}.txt`（见 [YouTube Transcript API](https://youtube-transcript.ai/youtube-transcript-api)）。本服务不直接爬 YouTube，而是在 CDP 控制的浏览器里访问该地址并返回结果。

## 前置条件

1. **Chrome / Edge** 已开启远程调试，例如：

   ```bash
   chrome.exe --remote-debugging-port=9222
   ```

2. 确认 CDP 可用：

   ```bash
   curl http://127.0.0.1:9222/json
   ```

3. Node.js 18+（建议 20+）。

## 安装与启动

```bash
cd youtube-fetch
npm install
npm start
```

开发模式（文件变更自动重启）：

```bash
npm run dev
```

默认监听 **`http://127.0.0.1:3920`**。启动后会自动 `connectOverCDP` 到 Chrome，打开或复用 `youtube-transcript.ai` 标签页。

## 环境变量

可在仓库根目录 `.env` 或 `youtube-fetch/.env` 中配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CDP_CONNECT_URL` | `http://127.0.0.1:9222` | Chrome 远程调试地址 |
| `YOUTUBE_FETCH_PORT` | `3920` | HTTP API 端口 |
| `YOUTUBE_TRANSCRIPT_SITE` | `https://youtube-transcript.ai` | 文稿站点根 URL |
| `YOUTUBE_FETCH_TIMEOUT_MS` | `90000` | 单次拉取超时（毫秒） |
| `YOUTUBE_FETCH_LOG_LEVEL` | `info` | 日志级别：`debug` / `info` / `warn` / `error` |
| `OLLAMA_CHAT_URL` | `http://127.0.0.1:8000/ollama/chat` | 文稿解析用的 Ollama 代理（与根目录 `config.py` 一致） |
| `OLLAMA_MODEL` | `gemma4:26b` | 分析模型 |
| `YOUTUBE_ANALYZE` | `0` | 设为 `1` 时，拉取/归档后默认调用模型解析 |
| `YOUTUBE_ANALYZE_TIMEOUT_MS` | `120000` | 单次模型请求超时（毫秒） |
| `YOUTUBE_ANALYZE_PROMPT` | （内置） | 覆盖默认 prompt，可用 `{{title}}` / `{{transcript}}` |
| `YOUTUBE_ANALYZE_PROMPT_FILE` | — | 从文件读取 prompt（优先于 `YOUTUBE_ANALYZE_PROMPT`） |

## Ollama 文稿解析

CDP 拉取文字稿后，可 POST 到本地 **8000** 端口的 `/ollama/chat` 做结构化解析（交易观点、币种、方向、价位等）：

```bash
curl -sS -X POST 'http://127.0.0.1:8000/ollama/chat' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"用一句话介绍你自己","model":"gemma4:26b"}'
```

本服务封装为可选步骤：

1. 环境变量 **`YOUTUBE_ANALYZE=1`** 开启默认分析；或单次请求加 **`analyze=1`**。
2. 分析结果写入 `archives/{videoId}.json` 的 **`analysis`** 字段（含 `parsed` JSON、`raw` 原文），并在 `.md` 追加 `## Analysis` 节。
3. 对已归档视频可 **`POST /api/analyze/:videoId`** 单独重跑分析，无需再拉 CDP。

```bash
# 拉取 + 归档 + 分析
curl "http://127.0.0.1:3920/api/transcript?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&save=1&analyze=1"

# 队列批量（body 里 analyze: true）
curl -X POST http://127.0.0.1:3920/api/queue \
  -H 'Content-Type: application/json' \
  -d '{"urls":["https://youtu.be/..."], "analyze": true}'

# 仅对已有归档重跑模型
curl -X POST http://127.0.0.1:3920/api/analyze/dQw4w9WgXcQ
```

## API

### 健康检查

```http
GET /health
```

```json
{
  "ok": true,
  "cdpReady": true,
  "cdpUrl": "http://127.0.0.1:9222",
  "site": "https://youtube-transcript.ai",
  "queue": { "pending": 0, "running": 0, "runningJobId": null, "total": 0 }
}
```

### 获取文字稿

支持 YouTube 完整链接、`youtu.be` 短链、`/shorts/`、`/embed/` 或 11 位 `videoId`。

**GET — 查询参数**

```http
GET /api/transcript?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ
GET /api/transcript?videoId=dQw4w9WgXcQ&lang=en
GET /api/transcript/dQw4w9WgXcQ?lang=en
GET /api/transcript/dQw4w9WgXcQ?raw=1
GET /api/transcript?url=...&save=1
```

**POST — JSON 请求体**

```http
POST /api/transcript
Content-Type: application/json

{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "lang": "en",
  "raw": false
}
```

| 参数 | 位置 | 说明 |
|------|------|------|
| `url` / `videoId` / `v` | query 或 body | 视频链接或 ID（二选一） |
| `lang` | query 或 body | 可选，字幕语言，如 `en`、`zh-Hant` |
| `raw` | query 或 body | 为 `1` / `true` 时返回原始 Markdown，不做字段解析 |
| `save` | query 或 body | 为 `1` / `true` 时写入 `archives/{videoId}.md` + `.json` |
| `analyze` | query 或 body | 为 `1` / `true` 时调用 Ollama 解析文稿（默认见 `YOUTUBE_ANALYZE`） |

### 串行队列（推荐用于批量归档）

入队后由后台 **逐个** 拉取并写入 `archives/`。若 `archives/{videoId}.md` 与 `.json` 已存在，则标记为 `skipped`，不会重复请求 CDP。同一 `videoId` 若已在 `pending` / `running` 中，则去重返回 `duplicate`。

**POST — 入队**

```http
POST /api/queue
Content-Type: application/json

{
  "urls": [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/Z8nuB5jcSwQ"
  ],
  "lang": "en"
}
```

也可用单条 `"url": "..."`。响应 `results[]` 每项含 `queued` / `skipped` / `duplicate` 与 `job` 状态。

**GET — 队列状态**

```http
GET /api/queue?limit=80
```

`jobs[]` 状态：`pending` → `running` → `done` | `failed` | `skipped`。

`discord-collector` 前端 **`/fetch`** 通过代理 `POST /api/youtube-fetch/queue` 调用本接口（环境变量 `YOUTUBE_FETCH_URL`，默认 `http://127.0.0.1:3920`）。

### 本地归档格式（`archives/`）

每个视频仅维护 **两个文件**：

| 文件 | 内容 |
|------|------|
| `{videoId}.md` | 正文：首行 `# 标题`，元数据行，`## Transcript` 以下为带时间戳文稿 |
| `{videoId}.json` | 元数据：`title`、`sourceUrl`、`languageLine`、`wordCount`、`charCount`、`fetchedAt` 等；若已分析则含 **`analysis`**（**不含**正文重复） |

`discord-collector` 前端 `/fetch` 提交 URL 入队，`/archives` 读取同一目录预览。

### 成功响应示例

```json
{
  "ok": true,
  "videoId": "dQw4w9WgXcQ",
  "lang": null,
  "title": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
  "sourceUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "languageLine": "en · Duration: 3:27 · Words: 481",
  "transcript": "[0:01] [♪♪♪] ♪ We're no strangers to love ♪ ...",
  "analysis": {
    "model": "gemma4:26b",
    "analyzedAt": "2026-05-28T12:00:00.000Z",
    "parsed": {
      "summary": ["..."],
      "symbol": "BTC",
      "direction": "做多"
    },
    "raw": "{ ... }"
  },
  "raw": "# Transcript: Rick Astley ..."
}
```

### 错误码

| HTTP | 含义 |
|------|------|
| `400` | 无法解析 video id，或缺少 `url` / `videoId` |
| `502` | CDP 页面拉取失败，或 Ollama 分析失败 |
| `503` | CDP 未就绪（Chrome 未开或调试端口不可达） |
| `404` | `POST /api/analyze/:videoId` 时归档不存在 |

## 调用示例

```bash
# cURL
curl "http://127.0.0.1:3920/api/transcript?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# PowerShell
Invoke-RestMethod "http://127.0.0.1:3920/api/transcript/dQw4w9WgXcQ"
```

```javascript
const res = await fetch("http://127.0.0.1:3920/api/transcript", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", lang: "en" }),
});
const data = await res.json();
console.log(data.transcript);
```

## 工作原理

1. 使用 Playwright **`chromium.connectOverCDP`** 连接 `CDP_CONNECT_URL`。
2. 在已有 Chrome 中复用 `youtube-transcript.ai` 标签，或新开一页并访问站点首页。
3. 收到 API 请求后，在 CDP 控制的页面中 **`page.goto`** 到  
   `https://youtube-transcript.ai/transcript/{VIDEO_ID}.txt`（可选 `?lang=`）。
4. 读取响应正文，解析 Markdown 元数据，返回 JSON。
5. `/api/queue` 与 CDP 拉取经内部队列 **串行** 执行，避免并发导航冲突。
6. 若开启 **`analyze`**，拉取完成后 POST `OLLAMA_CHAT_URL`，解析结果并入归档。
7. 进程退出时仅断开 Playwright 会话，**不会关闭你的 Chrome**。

## 目录结构

```
youtube-fetch/
├── package.json
├── README.md
└── src/
    ├── server.js          # Express API 入口
    ├── cdp-client.js      # CDP 连接与文稿拉取
    ├── fetch-queue.js     # 串行入队与去重
    ├── fetch-transcript.js
    ├── archive-exists.js
    ├── archive.js         # 写入 archives/
    ├── config.js          # 环境变量
    ├── video-id.js        # YouTube URL → videoId
    ├── parse-transcript.js
    ├── ollama-analyze.js  # POST /ollama/chat 解析文稿
    └── logger.js
```

## 常见问题

**启动报 `CDP 未就绪` 或连接失败**  
确认 Chrome 已带 `--remote-debugging-port=9222`，且 `http://127.0.0.1:9222/json` 能返回标签列表。

**`502` 且提示 HTTP 404**  
该视频可能没有可用字幕，或 `lang` 参数对应轨道不存在。

**端口占用 `EADDRINUSE`**  
修改 `YOUTUBE_FETCH_PORT`，或结束占用 3920 端口的进程后重启。
