# `logging_setup.py` 使用说明

`logging_setup.py` **不是**可独立执行的入口脚本，没有 `if __name__ == "__main__"`。它提供 `setup_telethon_logging()`，供其他 Telegram 脚本在启动时调用，用于把 **Telethon** 的日志打到 **stderr**。

## 谁在用

在 `telegram` 目录下运行时，以下脚本会调用 `setup_telethon_logging()`：

| 脚本 | 说明 |
|------|------|
| `list_groups.py` | **仅打印**监听范围内消息（不建卡、不推送） |
| `listen.py` | 主群建卡 + 次要群推送（生产用） |
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

## listen.py：主群建卡 + 次要群推送（默认）

在 `monitored_groups.txt` 配置：

| 键 | 用途 |
|----|------|
| `main_monitored` | 主要发车群（发车占比高）→ `POST /api/v1/cards` |
| `monitored` | 次要闲聊群（发车占比低）→ 整理后发到 `push_chat` |
| `push_chat` | 次要群推送目标 |

两类群都用滚动窗口检测「币种 + 做多/做空」；可先发信号、再补止盈止损。

主群建卡还需：

1. `discord-collector/.env` 中配置 `CARDS_API_KEY`，并运行 `pnpm run collect:ui`
2. （可选）复制 `channel_profiles.example.json` → `channel_profiles.json`，为每个主群 id 填 `name` / `avatar`（未填时用群标题）

启动示例：

```
[+] 主发车群 → 卡片 API: [...]
[+] 次要闲聊群 → push_chat: [...]
[+] 主群建卡: http://127.0.0.1:3851/api/v1/cards
[+] 次要群规则推送: ...
```

## listen.py：可选 AI 交易聚合

设 `TELEGRAM_AI_TRADE_AGGREGATE=1` 时：仅对**次要群**改为 Ollama 聚合后推送。需本机 **Ollama** 与 `TELEGRAM_SEND_URL`。
