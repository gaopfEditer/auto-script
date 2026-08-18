# discord-collector

主项目。开发地图：[docs/development.md](docs/development.md)。

Cursor 规则在仓库根目录 `.cursor/rules/`：总览始终生效；打开对应 glob 时带上后台 / 卡片 / 前端 / CDP / OI 规则。

- 入口：`pnpm run collect:ui`（`src/collector-ui-server.js`）+ `pnpm run dev:ui-vue`
- 配置：只读本目录 `.env`（`src/load-env.js`）
- 对用户用中文；不主动 commit；不改 `.cursor/plans/`
