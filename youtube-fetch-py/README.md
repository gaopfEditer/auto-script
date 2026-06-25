# youtube-fetch-py

[Node 版 youtube-fetch](../youtube-fetch/README.md) 的 **Python 实现**，功能对齐：

- 通过 **CDP** 附着 Chrome，在 [youtube-transcript.ai](https://youtube-transcript.ai/) 页面 `goto` 拉取文稿
- HTTP API：`/health`、`/api/transcript`、`/api/queue`
- 串行队列、归档去重
- 写入与 Node 版相同的 `archives/{videoId}.md` + `.json`

默认端口 **3921**（避免与 Node 版 3920 冲突），归档目录默认指向 `../youtube-fetch/archives`。

## 前置条件

1. Chrome 远程调试：

   ```bash
   chrome.exe --remote-debugging-port=9222
   ```

2. Python 3.11+

## 安装

```bash
cd youtube-fetch-py
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
copy .env.example .env
```

## 启动

```bash
python main.py
```

服务地址：`http://127.0.0.1:3921`

## API（与 Node 版一致）

```bash
# 健康检查
curl http://127.0.0.1:3921/health

# 拉取文字稿
curl "http://127.0.0.1:3921/api/transcript?url=https://www.youtube.com/watch?v=Z8nuB5jcSwQ"

# 拉取并归档
curl "http://127.0.0.1:3921/api/transcript/Z8nuB5jcSwQ?save=1"

# 入队批量
curl -X POST http://127.0.0.1:3921/api/queue -H "Content-Type: application/json" -d "{\"urls\":[\"https://youtu.be/Z8nuB5jcSwQ\"]}"
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `CDP_CONNECT_URL` | `http://127.0.0.1:9222` | Chrome CDP |
| `YOUTUBE_FETCH_PORT` | `3921` | HTTP 端口 |
| `YOUTUBE_TRANSCRIPT_SITE` | `https://youtube-transcript.ai` | 文稿站点 |
| `YOUTUBE_ARCHIVES_DIR` | `../youtube-fetch/archives` | 归档目录 |
| `YOUTUBE_FETCH_TIMEOUT_MS` | `90000` | 超时 |

## 目录结构

```
youtube-fetch-py/
├── main.py
├── requirements.txt
└── youtube_fetch/
    ├── server.py          # FastAPI
    ├── cdp_client.py      # Playwright CDP
    ├── fetch_queue.py
    ├── fetch_transcript.py
    ├── archive.py
    ├── parse_transcript.py
    └── video_id.py
```

## 与 discord-collector 联调

在 `discord-collector/.env` 中把代理指向 Python 版：

```env
YOUTUBE_FETCH_URL=http://127.0.0.1:3921
```

## CLI 单次拉取（不启 HTTP）

```bash
python -m youtube_fetch.cli "https://www.youtube.com/watch?v=Z8nuB5jcSwQ" --save
```
