# `logging_setup.py` 使用说明

`logging_setup.py` **不是**可独立执行的入口脚本，没有 `if __name__ == "__main__"`。它提供 `setup_telethon_logging()`，供其他 Telegram 脚本在启动时调用，用于把 **Telethon** 的日志打到 **stderr**。

## 谁在用

在 `telegram` 目录下运行时，以下脚本会调用 `setup_telethon_logging()`：

| 脚本 | 说明 |
|------|------|
| `list_groups.py` | 列出已加入的群组/频道及最近消息 |
| `listen.py` | 监听消息；默认 AI 聚合窗口内交易信息后推送 |
| `poll_groups.py` | 轮询群组等 |

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `TELEGRAM_LOG_LEVEL` | `INFO` | Telethon 根 logger 级别，如 `DEBUG`、`INFO`、`WARNING`。非法名称会回退为 `INFO`。 |

默认用 `INFO`，避免连接成功后大量 `DEBUG`（加密、RPC 等）看起来像报错。

## 运行方式（通过上述脚本生效）

在 **`telegram` 目录**下执行（与现有脚本 docstring 一致）：

```bash
cd /path/to/auto-script/telegram
python list_groups.py
```

临时打开更详细的 Telethon 日志：

```bash
cd /path/to/auto-script/telegram
TELEGRAM_LOG_LEVEL=DEBUG python listen.py
```

若从仓库根目录运行，需保证能解析到 `telegram` 包路径，例如：

```bash
cd /path/to/auto-script
PYTHONPATH=telegram python telegram/list_groups.py
```

（具体以你本机虚拟环境、工作目录为准。）

## 在代码里单独使用

若你写自己的 Telethon 脚本，可在创建/启动 client 之前调用一次：

```python
from logging_setup import setup_telethon_logging

setup_telethon_logging()
```

日志格式：`时间 级别 [logger名] 消息`，输出到 **stderr**，时间格式为 `%H:%M:%S`。

## listen.py：AI 聚合推送（默认）

配置了 `push_chat` 后，**不会**把每条闲聊原样转发，而是：

1. 每个监听群保留最近 **30** 条消息（`TELEGRAM_TRADE_CONTEXT_SIZE`）
2. 停聊 **45s** 后（`TELEGRAM_TRADE_CONTEXT_FLUSH_SEC`）将窗口交给 **Ollama** 提取交易信息
3. 按 **币种** 合并为「入场 / 止损 / 止盈 / 调整」等一行摘要，发到 `push_chat`（`TELEGRAM_SEND_URL` 或 Telethon）

需本机 **Ollama** 与 **Telegram 发送 API**（如 `http://127.0.0.1:8000/api/telegram/send`）。关闭 AI、恢复关键词单条转发：`TELEGRAM_AI_TRADE_AGGREGATE=0` 并配置 `sender_keywords`。
