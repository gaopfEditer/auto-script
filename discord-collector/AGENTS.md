# discord-collector

主项目。开发地图：[docs/development.md](docs/development.md)。

Cursor 规则在仓库根 `.cursor/rules/`：

- 总览始终生效（`discord-collector-overview.mdc`）
- 打开对应 glob 时带上：后台 / 卡片 / 前端 / CDP / **OI（含 TG 推送）** / `telegram/`（`#prom`）

OI 信号与推送详文：[oi_mornitor/SIGNAL_LOGIC.md](oi_mornitor/SIGNAL_LOGIC.md)

- 入口：`pnpm run collect:ui` + `pnpm run dev:ui-vue`；OI：`pnpm run oi:start`
- 配置：只读本目录 `.env`（`src/load-env.js`）
- 对用户用中文；不主动 commit；不改 `.cursor/plans/`
