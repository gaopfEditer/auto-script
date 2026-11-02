# 巨鲸 kolvip 临时 CDP 信号源

巨鲸助手 Pro（`https://kolvip.vip/web`）是 **临时** 替代 Discord 信号频道监听的 DOM 抓取源。与 Discord Gateway/CDP **并存**：用环境变量开关切换，**不删除** Discord 采集与配置。

实现模块：`src/kolvip-cdp-{config,connect,fetch,message,nav,service}.js`，建卡共用 `src/discord-signal-pipeline.js`。

---

## 1. 开关与切回 Discord

| 变量 | 默认 | 含义 |
|------|------|------|
| `KOLVIP_CDP_ENABLED` | `0`（关） | `1` 时启动巨鲸 CDP 轮询 → 现有 signal card / Telegram 管道 |
| `KOLVIP_CDP_CONNECT_URL` | 空 | 留空则沿用 `CDP_CONNECT_URL`（通常 `http://127.0.0.1:9222`） |
| `KOLVIP_WEB_URL` | `https://kolvip.vip/web` | SPA 入口（URL 恒为 `/web`） |
| `KOLVIP_CDP_INTERVAL_MS` | `90000` | 轮询间隔（毫秒，最小 15000） |
| `KOLVIP_CDP_MAX_PER_CHANNEL` | `40` | 每频道 DOM 最多读多少条 `.row[data-id]` |
| `KOLVIP_CDP_BYPASS_DISCORD_SIGNALS` | kolvip **开启**时为 `1` | 旁路 Discord **建卡**（同映射 Discord channelId），避免双推 |
| `KOLVIP_CHANNEL_IDS` | 空 | 非空覆盖默认 8 频道；格式见下文 |

### 旁路 Discord 建卡（不是关 Gateway）

- `KOLVIP_CDP_ENABLED=1` 且 `KOLVIP_CDP_BYPASS_DISCORD_SIGNALS=1`（默认）：Discord **Gateway 仍采集、入库**；仅对「已映射到巨鲸」的 Discord 信号频道 **跳过** `runSignalCardPipelineForRows` 里的建卡/TG 出卡，改由巨鲸侧灌入。
- `KOLVIP_CDP_BYPASS_DISCORD_SIGNALS=0`：双源并行出卡（**可能重复推送**，仅调试）。

### 切回纯 Discord

1. `.env` 设 `KOLVIP_CDP_ENABLED=0`（或删掉该变量）。
2. 重启 `pnpm run collect:ui`。
3. 保持 `CDP_CONNECT_URL` 与 Discord 登录即可；**无需**改 `discord-signal-config.js` 或删巨鲸映射表。

---

## 2. 频道映射与 DOM

巨鲸侧栏是 SPA：频道用 `data-open-ch="{id}"` 打开；消息区 `#v-channel #feed.feed` → `#msgs > .row[data-id]` → `article.msg.bmsg`。

| 逻辑名 | 巨鲸 `data-open-ch` | Discord 信号 channelId | parser |
|--------|---------------------|-------------------------|--------|
| 大镖客 | 1 | `1444962339743989843` | `dabiaoke` |
| 淑琴 | 4 | `1444962376066793513` | `btc_cn` |
| 三马 | 8 | `1444962439471955989` | `streak_cn` |
| 峰哥 | 10 | `1444963929393729686` | `fengge` |
| 军长 | 11 | `1444963474718462085` | `junzhang` |
| 所长 | 12 | `1444963405185159238` | `biquan_suozhang` |
| 胖猫社区 | 16 | `1562351038277619783` | `pangmao` |
| 颜驰 | 22 | `1444963689194192947` | `yanchi` |

**巨鲸未找到、暂不映射**（配置表留空注释）：飞扬、seven、山寨之王 — 仍只走 Discord（若 Gateway 可用）。

源码默认表：`src/kolvip-cdp-config.js` → `DEFAULT_KOLVIP_CHANNEL_MAPPINGS`。

### 环境变量覆盖

```env
# 使用默认 Discord id，只列巨鲸 ch id
KOLVIP_CHANNEL_IDS=1,4,8,10,11,12,16,22

# 或显式指定 Discord 雪花
KOLVIP_CHANNEL_IDS=16:1562351038277619783
```

### DOM 选择器要点

| 用途 | 选择器 |
|------|--------|
| 打开频道 | `[data-open-ch="{id}"]`（需 **可见**；分组内见下文） |
| 展开分组 | 父级 `[data-open-grp]`（先点 grp 再点 ch） |
| 消息列表 | `#v-channel #feed.feed #msgs > .row[data-id]` |
| 时间 | `.btime` / `.bubble[title]` |
| 正文 | `.bubble p.ft` |
| 作者 | `.who` |
| 图片 | `.frame[data-src][data-full]`（优先 `data-full`） |

去重键：巨鲸 `data-id` → 合成 `messageId`：`kolvip-{ch}-{dataId}`（见 `kolvip-cdp-message.js`）。

首次轮询某频道：只记 seen（`data/kolvip-cdp-seen.json`），**不灌历史**（与 Twitter CDP 一致）。

---

## 3. 登录态（本机 CDP Chrome）

- 抓取 **不** 在代码里写账号密码；假设 **已附加** 的 Chrome（`:9222`）里用户已打开并登录 `kolvip.vip/web`。
- 巨鲸 SPA 登录态主要在 **`localStorage`**（例如 `wv.wtoken` 等），**不是** 传统 Cookie 会话；必须使用 **固定 `--user-data-dir`** 的调试 Chrome，否则重启浏览器会丢 token。
- Discord 与巨鲸可共用同一调试端口/profile（默认）；也可另开 profile，此时 `KOLVIP_CDP_CONNECT_URL` 指向对应端口。

### 失效后如何再导

1. 用同一 `user-data-dir` 启动 Chrome：`--remote-debugging-port=9222`。
2. 手动打开 `https://kolvip.vip/web` 并完成登录（或从已登录设备导出/同步 localStorage — **勿提交 token 到 git**）。
3. 在 DevTools → Application → Local Storage 确认 `wv.wtoken` 等键存在。
4. 重启 `collect:ui`，日志应不再出现「未登录巨鲸」。

代理：本机 CDP 须排除代理（`.env` 的 `NO_PROXY` + 代码内 `withLocalhostNoProxy`），否则 Playwright 连 `127.0.0.1:9222` 可能 400。

---

## 4. 出卡 / 推送管道（不变）

数据流（与 Discord Gateway 路径汇合处相同）：

```text
kolvip CDP DOM
  → kolvipMessageToDiscordRow（channelId = 上表 Discord id）
  → runSignalCardPipelineForRows（source=kolvip_cdp）
  → discord-signal-card-service.onMessage
  → discord_signal_cards / Telegram / CARD_SINK / 交易所开关
```

- **Telegram 文案与合并规则**未改；仍走 `discord-signal-config.js` 的 `parser` / `telegramStyle`。
- **胖猫**（巨鲸 ch=16 → Discord 胖猫频道）：带图消息在 `rawJson.attachments` 中挂 URL，仍走 **`discord-signal-image-ocr.js`**（晒单过滤、开仓 OCR、指纹去重）→ `pangmao` 分阶段 parser。

---

## 5. 明日目标：Discord 频道页右侧「巨鲸胜率」面板

> **状态：规划中，尚未合入主流程 UI。** 本文档先固定口径，避免实现与 eval 分叉。

### 产品位置

- 在 **Discord 频道浏览页**（Show / 与 CDP 当前频道上下文一致）**右侧**增加面板：展示当前映射巨鲸频道（及同源 Discord 信号频道）的 **胜率 / 盈亏摘要**。
- 数据源：已有卡片库 `discord_signal_cards` + eval 汇总逻辑，**不** 另建一套胜率公式。

### 口径（与 Discord 回溯 / eval 对齐）

与 [development.md](./development.md) 及卡片评估规则一致，**禁止** 面板单独改语义：

| 项 | 口径 |
|----|------|
| 未入场 | 不计入胜率；清算限价 **12h 未触** 视为未入场 |
| 赢 | 任意 TP 命中 |
| 输 | 先 SL |
| 仓位 | N 个 TP 各平 `1/N`；`pnlPct` 仓位加权 |
| 汇总 API | 对齐 `GET /api/v1/cards/eval/summary`、`GET /api/v1/cards/eval/channels/:channelId`（见 [cards-api.md](./cards-api.md)） |

面板筛选建议：`source` 含 `kolvip_cdp` 与 `gateway_ws` / `rest_api` 的合并视图（按 **Discord channelId** 聚合，因巨鲸行已映射到同一 channelId）。

---

## 6. 一个月回溯：分期与防封（规划）

> **状态：规划中。** 巨鲸 DOM 回溯尚未实现；以下为设计与运维约束，实现时需写进 store/任务状态机。

### 目标

- 对 8 个映射频道做约 **30 天** 历史消息抓取，用于补卡/回测样本；与 Discord REST 回溯 **互补**，不替代 eval 引擎。

### 防封 / 限速原则

| 策略 | 说明 |
|------|------|
| 分期 | 按频道拆分 Job；每频道按 **时间窗**（如 1～3 天）分批，批间 **冷却**（建议 ≥ 30～120s，可配置 env） |
| 并发 | 单 Chrome 标签 **串行** 切频道；避免与实时轮询叠加强刷 |
| 每日上限 | 每频道每批最多滚动/读取条数上限（与 `KOLVIP_CDP_MAX_PER_CHANNEL` 区分，回溯可用 `KOLVIP_BACKFILL_*` 独立配置，实现时加入 `config.js`） |
| 失败退避 | 超时/429/空列表 → 指数退避，写入 Job 状态，**不** 无限重试 |
| 人工窗口 | 建议低峰时段跑大批量回溯 |

### 建议 Job 状态字段（实现时落库或 `data/kolvip-backfill.json`）

| 状态 | 含义 |
|------|------|
| `pending` | 已排队 |
| `running` | 抓取中（含当前时间窗） |
| `cooldown` | 批间冷却 |
| `insufficient_sample` | 样本不足（消息过少或无法解析，不够 eval 最小样本） |
| `done` | 该窗完成 |
| `failed` | 可重试失败（附 `lastError`） |
| `paused` | 人工暂停 / 检测到登录失效 |

### 分期计划示例（30 天 × 8 频道）

1. **P0**：单频道试点（如胖猫 ch=16）3 天窗 → 验证 DOM/OCR/去重。
2. **P1**：8 频道各 7 天，串行 + 冷却。
3. **P2**：剩余天数补齐；eval 对照 Discord 同源 channel 的 `/eval` 汇总，偏差超阈则停批排查。

实现后在本节补充实际 env 名与 API（如 `POST /api/kolvip/backfill`）。

---

## 7. 已知问题

### 分组频道 CDP click 超时（大镖客 / 淑琴 / 颜驰）

**现象**：日志中胖猫等「首次记档」成功，但 **大镖客（ch=1）、淑琴（ch=4）、颜驰（ch=22）** 打开失败，Playwright `click` 超时。

**原因（已确认方向）**：上述频道在 UI 中位于 **分组** 下（例如「大镖客VIP禁言群」「舒琴VIP会员群」「颜驰VIP教学频道」），父级为 **`data-open-grp`**。折叠时分组内的 `[data-open-ch]` 在 DOM 中存在但 **不可见**，旧逻辑 `.first()` 点到隐藏节点导致超时。

**修复方向**（代码 PR 跟踪，目标模块 `kolvip-cdp-nav.js`）：

1. 先按 **outer → inner** 顺序点击相关 `[data-open-grp]` 展开；
2. 再对 **可见** 的 `[data-open-ch="{id}"]` 点击（`visible=true` / `scrollIntoView`）；
3. 点击超时提高到约 **20s**，feed 等待约 **18s**。

**临时规避**：在 Chrome 里 **手动展开** 对应 VIP 分组并保持侧栏可见，再启轮询（仍可能因 SPA 折叠复发）。

---

## 相关文件速查

| 文件 | 说明 |
|------|------|
| `.env.example` | `KOLVIP_*` 注释 |
| `src/kolvip-cdp-config.js` | 映射表、bypass 判断 |
| `src/kolvip-cdp-fetch.js` | CDP 连接、按频道 scrape |
| `src/kolvip-cdp-nav.js` | 分组展开 + 打开频道（修复中） |
| `src/discord-signal-pipeline.js` | 建卡旁路与 OCR 入口 |
| `docs/development.md` | 总地图（含 eval 口径） |
| `docs/cards-api.md` | eval 汇总 API |

**维护约定**：行为或 env 变更时同步改本文 + `.env.example` +（若涉及 CDP）`.cursor/rules/discord-collector-cdp.mdc`。
