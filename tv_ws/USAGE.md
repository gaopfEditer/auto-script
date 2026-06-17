# tv_ws — TradingView WebSocket 推送

从 [auto-deal-eth](https://github.com/) 迁入：监听 WebSocket 中的 **TradingView** 告警，对 **1h / 4h**（或 `--only-telegram` 时的 **15m/1h/4h**）生成文案，**Ollama 润色** → **Telegram 图文** → 可选 **币安广场** 发布。

## 目录结构

| 路径 | 作用 |
|------|------|
| `tv_ws/pic_push_public.py` | 常驻 WSS 监听（`python3 -m tv_ws.pic_push_public`） |
| `tv_ws/signal_handler.py` | 周期过滤、润色、截图、Telegram、广场 |
| `tv_ws/polish.py` | 本地 Ollama 润色 |
| `dealMsg/runner.py` | 解析 ticker/period、TradingView CDP 截图 |
| `notifier.py` | 格式化 signal、Telegram 推送 |
| `promat_publish.py` + `prompts/promat/` | 润色提示词 |
| `binance/square_publish.py` | `--public` 时发币安广场 |

## 1. 安装依赖

```bash
cd /Users/maotouying/frontend/code/1.operations/auto-script

python3 -m venv venv
source venv/bin/activate
pip install -r tv_ws/requirements.txt
```

## 2. 配置环境变量

将 `tv_ws/.env.example` 中的项写入**项目根** `.env`（`config.py` 与 `pic_push_public` 均从根目录加载）。

必填（若要推 Telegram）：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

可选：

- `MAIN_WS_URL` — 默认 `wss://bz.a.gaopf.top/api/ws`
- `WS_ALLOWED_PERIODS` — 默认 `1h,4h`
- `SCREENSHOT_DIR` — 截图保存目录
- `PROMAT_ANALYSIS_OLLAMA_*` — Ollama 地址与模型

## 3. 前置条件

1. **WebSocket** 可访问（脚本直连 WSS，不走系统代理）。
2. **润色**：本机 Ollama 已启动（默认 `http://localhost:11434`）。
3. **截图 / 广场**：Chrome 已开远程调试并已登录币安（与 auto-deal-eth 相同）：

   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
   ```

## 4. 快速启动

```bash
cd /Users/maotouying/frontend/code/1.operations/auto-script
source venv/bin/activate

# 默认：Ollama 润色 + Telegram 图文 + 截图，不发广场
python3 -m tv_ws.pic_push_public

# 确认无误后再发广场
python3 -m tv_ws.pic_push_public --public
```

## 5. 命令行参数

| 参数 | 说明 |
|------|------|
| （无） | 润色 → 截图 → Telegram；**不**发广场 |
| `--public` | 额外发布到币安广场（CDP + `binance.square_publish`） |
| `--only-telegram` | 不润色、不发广场；15m/1h/4h 原文+截图直推 Telegram |
| `--dry-run` | 仅打印解析，不润色、不截图、不 Telegram |
| `--skip-screenshot` | 仍润色 + Telegram，不打开 TradingView |
| `--print-raw` | 打印原始 JSON |
| `--url <wss>` | 覆盖 WebSocket 地址 |

示例：

```bash
python3 -m tv_ws.pic_push_public --dry-run --print-raw
python3 -m tv_ws.pic_push_public --skip-screenshot
python3 -m tv_ws.pic_push_public --only-telegram
python3 -m tv_ws.pic_push_public_only_telegram   # 同上 only-telegram 的专用入口
```

## 6. 处理流程

```text
WSS message_received (source=tradingview)
  → 解析 metadata.ticker / period
  → 周期在允许列表？否 → 跳过
  → format_tv_signal_plain → 标准纯文本
  → Ollama 润色（可 --only-telegram / WS_SKIP_POLISH 跳过）
  → capture_tradingview_chart（CDP 截图到 SCREENSHOT_DIR）
  → Telegram：润色配文 + 截图
  → [--public] binance.square_publish 发广场
```

## 7. 本地联调（不连 WebSocket）

```bash
python3 -m tv_ws.pic_push_public_test
python3 -m tv_ws.pic_push_public_test --public
python3 -m tv_ws.pic_push_public_test --skip-screenshot
python3 -m tv_ws.pic_push_public_test --ticker BTCUSD --period 4h
python3 -m tv_ws.pic_push_public_test --skip-publish   # 仅 Telegram 原文+图
```

内置样本为 **PAXGUSD 1h 倒锤子**，与生产逻辑一致。

## 8. 环境变量速查

| 变量 | 默认 | 说明 |
|------|------|------|
| `MAIN_WS_URL` | `wss://bz.a.gaopf.top/api/ws` | WebSocket |
| `WS_ALLOWED_PERIODS` | `1h,4h` | 处理周期 |
| `WS_SKIP_TELEGRAM` | 空 | `1` 则不推 Telegram |
| `WS_SKIP_POLISH` | 空 | `1` 则跳过润色 |
| `USE_REMOTE_DEBUGGING` | `True` | CDP 连接已有 Chrome |
| `CHROME_DEBUG_PORT` | `9222` | 远程调试端口 |
| `PROMAT_ANALYSIS_OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama |
| `PROMAT_ANALYSIS_OLLAMA_MODEL` | `gemma-uncensored` | 润色模型 |
| `WS_PING_TIMEOUT` | `300` | 长任务时放宽 ping 超时 |
| `DEALMSG_USE_PLAYWRIGHT` | `0` | `1` 用 Playwright 替代 Selenium 截图 |

## 9. 心跳与重连

收到 `{"type":"heartbeat"}` 时自动回复 `{"type":"pong",...}`。断线后按 `WS_RECONNECT_SEC` 指数退避重连（上限 `WS_RECONNECT_MAX_SEC`）。

## 10. 常见问题

| 现象 | 处理 |
|------|------|
| 只有解析无执行 | 加了 `--dry-run`，去掉即可 |
| Telegram 未推送 | 检查 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` |
| 润色失败 | 确认 Ollama 已启动、模型已 pull |
| 截图失败 | Chrome `--remote-debugging-port=9222` 是否开启 |
| 15m 被跳过 | 默认只处理 1h/4h；用 `--only-telegram` 或改 `WS_ALLOWED_PERIODS` |

## 11. 兼容旧入口

```bash
python3 tv_ws_pic_push_public.py
python3 tv_ws_pic_push_public_test.py
python3 tv_ws_pic_push_public_only_telegram.py
```
