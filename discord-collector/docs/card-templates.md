# 信号卡片模板目录（对外评估用）

本文整理 discord-collector 里「卡片」的几种形态，方便外部评审文案、字段齐全度与机器可读性。

配套机读样本：[`card-template-catalog.json`](./card-template-catalog.json)（含各 parser × 风格的完整渲染示例）。

**唯一标识**：每张卡片入库后固定为 `SC-{数据库id}`（如 `SC-1004`）。正文末行 `ID SC-xxx`，Embed 有「标识」字段；外部评估与后续数据补充请用此 uid 对齐。

---

## 评估时先分清三层

| 层 | 是什么 | 评估重点 |
|----|--------|----------|
| **A. 语言风格** | `cn_formal` / `cn_brief` / `tw_formal` / `en_brief` | 语气、字数、简繁英是否达标 |
| **B. 排版骨架** | 按频道 `parser` 决定的字段顺序与标签 | 字段是否齐全、顺序是否合理、多档 TP/入场是否清晰 |
| **C. 结构化 Embed** | Discord Embed 式 `fields[]` | 是否便于 UI / 下游交易消费 |

线上流程：原文 → parser 结构化 → **优先 Ollama 按风格生成正文**；失败或 Debug 快速模式 → **`formatCardFallback` 规则模板**（本目录里的 B 层样本即此回退结果）。Telegram 推送用各频道的 `telegramStyle`（多为 `cn_brief`）。

---

## A. 语言风格模板（4 种）

配置：`src/discord-signal-config.js` → `SIGNAL_STYLE_META`

| styleId | 标签 | 约束（promptHint） | 典型用途 |
|---------|------|-------------------|----------|
| `cn_formal` | 简体·正式 | 简体中文，正式完整，条理清晰 | 面板默认多风格之一 |
| `cn_brief` | 简体·极简 | 简体中文，极简 Telegram 风格，≤80 字 | 多数频道 Telegram 推送 |
| `tw_formal` | 繁体·正式 | 繁体中文，正式完整 | 繁体受众 / seven 等 |
| `en_brief` | English | Concise English for traders，≤100 chars | 英文渠道 |

说明：回退模板下，`cn_formal` 与 `cn_brief` **排版骨架相同**（仅标签简体）；真正「极简」依赖 AI 生成。`tw_formal` 换繁体标签（入場/止損等）；`en_brief` 换 Entry/TP/SL 等英文标签。`tw_opg` 回退布局固定繁体，与 styleId 无关。

---

## B. 解析器回退排版（5 类骨架）

配置与实现：`DEFAULT_SIGNAL_CHANNELS` + `formatCardFallback`（`discord-signal-parsers.js`）

### B1. `binance_killers`（币安杀手）

字段顺序：`标题 · 币种` → 方向 → 入场 → 杠杆 → 目标（多档）→ 止损 → ID

```
Long Setup · BTC
方向：做多
入场：64000-64500
杠杆：10x
目标：65000 · 66000 · 68000
止损：63000
ID BK-1024
```

### B2. `btc_cn`（淑琴等）

字段顺序：标题 → 方向 → 入场 → 倍数 → 止盈（单档）→ 止损

```
BTC 波段
方向：做空
入场：65000
倍数：20x
止盈：63000
止损：67000
```

### B3. `streak_cn` / `eth_short`（三马连胜等）

字段顺序：标题 → 入场（可多档 `/`）→ 止盈（多档）→ 止损（无单独「方向」行）

```
ETH 连胜单
入场：3200 / 3180
止盈：3300 · 3400
止损：3100
```

### B4. 中文市价家族（同一套排版）

parsers：`dabiaoke` | `feiyang` | `fengge` | `yanchi` | `biquan_suozhang` | `unknown_trader` | `altcoin_king`

字段顺序：标题/币种 → 方向 → 入场 → 止盈（多档）→ 止损 → 备注（可选）

```
SOL
方向：市价多
入场：市价
止盈：180 · 185 · 190
止损：170
轻仓试错
```

### B5. `tw_opg`（seven 繁体）

字段顺序：`#币种 方向` → 槓桿 → 倉位 → 止盈 → 止損 → 备注（标签固定繁体）

```
#OPG 進多
槓桿：10x
倉位：5%
止盈：0.12 · 0.15
止損：0.09
分批止盈
```

### 未知 parser

回退为 `JSON.stringify(parsed)`，不作为正式卡片形态评估。

---

## C. Discord Embed 结构化字段

实现：`src/card-fields.js` → `buildDiscordCardFields`

| 项 | 说明 |
|----|------|
| `title` | 卡片标题 |
| `color` | 多 `0x57f287` / 空 `0xed4245` / 中性 `0x5865f2` |
| `fields[]` | 币种、方向、入场、止盈、止损、来源、备注（有则出） |
| `footer` / `timestamp` | 来源与时间 |

与 A/B 正文并行：正文给人读，Embed 给面板/推送结构化展示。

---

## 频道 → parser / 风格对照

| 频道（示例名） | parser | 生成 styles | Telegram style |
|----------------|--------|-------------|----------------|
| 大镖客 | `dabiaoke` | cn_formal, cn_brief | cn_brief |
| 淑琴 | `btc_cn` | cn_formal, cn_brief, tw_formal | cn_brief |
| 飞扬 | `feiyang` | cn_formal, cn_brief | cn_brief |
| 峰哥 | `fengge` | （见 catalog） | cn_brief |
| 颜驰 | `yanchi` | （见 catalog） | cn_brief |
| 币安杀手 | `binance_killers` | （见 catalog） | 视配置 |
| 三马连胜 | `streak_cn` | （见 catalog） | cn_brief |
| seven | `tw_opg` | tw_formal 等 | tw_formal |
| 山寨之王 | `altcoin_king` | cn_formal, cn_brief, tw_formal | cn_brief |
| 币圈所长 | `biquan_suozhang` | cn_formal, cn_brief | cn_brief |

完整 channelId 映射见 `card-template-catalog.json` → `channelToStyles`，或接口 `GET /api/discord/signal-config`。

---

## 建议评估清单

1. **可读性**：一眼能否抓到币种 / 方向 / 入场 / 止盈 / 止损  
2. **风格差异**：`cn_brief` 是否明显短于 `cn_formal`（AI 路径）；繁体/英文标签是否正确  
3. **骨架差异**：B1–B5 是否覆盖真实频道发单习惯；缺字段时是否仍可读  
4. **机器侧**：Embed `fields` 是否够下游下单/展示，是否与正文冲突  
5. **推送**：Telegram 用 brief 是否信息损失可接受  

样本复现：同结构 `parsed` 调 `formatCardFallback(parsed, styleId)`，或直接对照 `card-template-catalog.json` → `renderedSamples`。

> 说明：内部 **延时自动校验 / 分层回测** 已关闭；外部评估请只看正文模板与 Embed，勿依赖历史 `verify_*` / `backtest_json`。人工评价表单仍可用于手工记账。
