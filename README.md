auto_git_commit_and_set_task 设置每天任务计划，自动提交代码

fix_all_encoding 处理同级目录下的所有编码错误的**文本**文件，改写为utf8编码，并**排除** node_modules、build、dist .开头的隐藏文件 这些目录


关机做一些提交
开机做一些拉取，这样就省去比较同步的问题
另外开机可以启动一些服务，关机一般推送数据来完成一次会话。

---

## stream-collector

基于 **Playwright CDP** 的采集与回放工具：连上目标页面后监听 **HTTP / WebSocket** 等网络事件，可选写入 **MySQL**，并支持按调度 **replay**。

- **collect**：采集网络与相关数据（`pnpm run collect` 等，见子目录 `package.json`）。
- **collect:ui**：本地起 **Express + WebSocket**，静态页 **Debug / Show**：Debug 里合并 `requestId`、拉响应体、WS 帧解压（zlib / raw deflate）与 JSON 展示；实时推送到前端。
- **replay / bridge / ws-bridge**：回放与上游 WebSocket 桥接等脚本入口。
- **persistent**：持久化 Profile 采集（`collect:persistent`）。
- 配置与子命令详见 `stream-collector/package.json` 与 `.env`。

## telegram

使用 **Telethon** 的 Telegram 客户端脚本：从 `.env` 读取 `TELEGRAM_API_ID`、`TELEGRAM_API_HASH` 等，支持会话、代理（SOCKS/HTTP/MTProxy）。

- **listen.py**：`events.NewMessage` 实时监听新消息，可配 `TELEGRAM_TARGET_CHAT_IDS` 只处理指定会话。
- **poll_groups.py**：轮询式拉取（适合与 listen 不同的使用方式）。
- **list_groups.py**：列出已加入的群组/对话，便于配置监听范围。
- **session.py**：创建与启动客户端；**message_format.py**：控制台输出格式。
- 依赖见 `telegram/requirements.txt`；群组列表示例见 `monitored_groups.example.txt`。

## workflow

**任务编排中心**：后端 **FastAPI**（`webhook_server.py`）提供 Webhook 与 REST API；**SQLite**（`db.py`）存任务定义与执行记录；可与外部 **OpenClaw** 等通过配置的 Webhook URL、共享密钥联动。

- **任务定义**：名称、Cron 周期、类目、Agent ID、JSON Payload、是否启用。
- **执行**：入队执行、立即触发；执行状态回写（success/failed）与结果字段。
- **frontend**：Vue + Element Plus 管理界面（创建定义、刷新列表、执行记录、部分聊天发送等 API 见 `frontend/src/api`）。

具体接口与密钥配置见 `workflow` 目录内 `config` 与 `请求参考.txt`。
