# News Mornitor API 文档

> 平台：新闻热点监控服务（`news_mornitor`）
> 基础地址：`http://127.0.0.1:8770`
> 启动命令：`python -m news_mornitor` 或 `pnpm run news:start`
> 数据来源：金十财经日历、币安广场、OKX 星球、Foresight News、CoinDesk、BlockBeats

---

## 目录

- [热点事件 API（核心）](#1-get-apiv1events)
  - [类目文档 API](#2-get-apiv1eventscategories)
- [宏观日历 API](#3-get-apiv1macrotimeline)
- [热榜 API](#4-get-apiv1hotlists)
- [刷新控制 API](#5-post-apiv1refresh)
- [健康检查](#6-get-apiv1health)
- [数据来源与标签体系](#数据来源与标签体系)
- [外部调用示例](#外部调用示例)

---

## 接口列表

---

### 1. `GET /api/v1/events`

**统一热点事件 API（核心接口）**

合并宏观日历 + 币圈事件 + 热榜，统一打父子类目标签，返回稳定哈希 ID。

#### 请求参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `channel` | string | `"all"` | 数据通道。`all`=全部 / `economy`=宏观日历 / `crypto`=币圈事件 / `hot`=热榜 |
| `min_star` | int | `1` | 最小星级（0=全部，1-5） |
| `limit` | int | `50` | 返回条数上限（最大 200） |
| `refresh` | bool | `false` | `true` 时强制重新抓取（仅本机可触发） |
| `category_id` | string | `""` | 按父类目标签 ID 过滤（如 `macro_fomc`） |

#### 响应结构

```json
{
  "ok": true,
  "total": 47,
  "limit": 50,
  "channel": "all",
  "min_star": 1,
  "category_id_filter": null,
  "economy_count": 12,
  "crypto_count": 8,
  "hot_count": 27,
  "category_counts": {
    "macro_fomc": 3,
    "macro_cpi": 2,
    "crypto_cex_listing": 5,
    "platform_binance": 12
  },
  "items": [/* 事件列表 */]
}
```

#### 单条事件字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 稳定哈希 ID，外部可凭此去重 |
| `title` | string | 事件标题（最长 200 字） |
| `description` | string | 事件描述/摘要（最长 500 字） |
| `category_id` | string | 父类目标签 ID，用于筛选（如 `macro_fomc`） |
| `category` | object | 父类目详情 |
| `category.id` | string | 同 `category_id` |
| `category.name` | string | 父类目中文名称 |
| `category.desc` | string | 父类目完整说明（影响逻辑、市场含义） |
| `category.star` | int | 推荐星级（0-5，5 为最重要） |
| `child` | object | 子类目详情 |
| `child.id` | string | 子类目标签 ID |
| `child.name` | string | 子类目中文名称 |
| `child.desc` | string | 子类目说明 |
| `source` | string | 数据来源（`jinshi` / `panews` / `hotlist-binance` 等） |
| `url` | string | 原始链接 |
| `publish_at` | string | 发布时间（UTC ISO 8601，如 `2026-09-08T20:30:00Z`） |
| `star` | int | 该事件星级（0-5） |
| `country` | string | 相关国家（如 `美国`） |
| `phase` | string | `past`（已过）/ `upcoming`（即将） |
| `bias` | string | 偏向：`bullish`（利好）/ `bearish`（利空）/ `neutral`（中性） |
| `bias_label` | string | 偏向中文标签：`利好` / `利空` / `中性` |

#### items 示例

```json
{
  "id": "a3f9c1b2e5d7f001",
  "title": "美联储 9 月 FOMC 利率决议",
  "description": "市场预期降息 25bp，关注点阵图和鲍威尔讲话。",
  "category_id": "macro_fomc",
  "category": {
    "id": "macro_fomc",
    "name": "美联储议息会议",
    "desc": "FOMC 决议 & 鲍威尔讲话。直接决定全局资金的借贷成本（利息）。加息或维持高利率（鹰派）→ 抽干市场流动性，引发大跌；降息或暂停加息（鸽派）→ 释放巨量资金，推升牛市。",
    "star": 5
  },
  "child": {
    "id": "macro_fomc_decision",
    "name": "FOMC 利率决议",
    "desc": "联邦公开市场委员会宣布加息/降息/维持不变的官方决定，即时冲击全球风险资产。"
  },
  "source": "jinshi",
  "url": "https://rili.jin10.com/",
  "publish_at": "2026-09-18T02:00:00Z",
  "star": 5,
  "country": "美国",
  "phase": "upcoming",
  "bias": "neutral",
  "bias_label": "中性"
}
```

---

### 2. `GET /api/v1/events/categories`

**类目文档 API**

返回所有父子类目标签及其完整说明，供外部渲染下拉菜单或构建筛选器。

#### 响应结构

```json
{
  "ok": true,
  "total": 16,
  "categories": [
    {
      "category_id": "macro_fomc",
      "parent": {
        "id": "macro_fomc",
        "name": "美联储议息会议",
        "desc": "FOMC 决议 & 鲍威尔讲话……",
        "star": 5,
        "keywords": ["FOMC", "美联储", "利率决议", "鲍威尔", "点阵图", "联邦基金利率"]
      },
      "child": {
        "id": "macro_fomc_decision",
        "name": "FOMC 利率决议",
        "desc": "联邦公开市场委员会宣布加息/降息/维持不变的官方决定，即时冲击全球风险资产。"
      }
    }
  ]
}
```

#### 类目一览

| category_id | 父类目 | 子类目 | 星级 | 说明 |
|------------|--------|--------|------|------|
| `macro_fomc` | 美联储议息会议 | FOMC 利率决议 | ★★★★★ | FOMC 决议 & 鲍威尔讲话 / 点阵图，直接决定全球资金借贷成本 |
| `macro_cpi` | 美国 CPI | 美国 CPI 数据 | ★★★★★ | CPI / PCE / PPI，公布瞬间 BTC/ETH 常剧烈插针 |
| `macro_nfp` | 美国非农就业数据 | 非农就业与失业率 | ★★★★☆ | NFP 大非农 / 失业率，每月第一个周五公布 |
| `macro_qt` | 美联储资产负债表政策 | QE / QT 扩表与缩表 | ★★★★☆ | 量化宽松/紧缩决定市场整体流动性水位 |
| `macro_economic` | 重要经济数据 | GDP / PMI / 零售 | ★★★☆☆ | GDP、PMI、零售销售等经济健康度指标 |
| `macro_centralbank` | 其他央行决议 | 欧央行/英格兰银行/日本央行等 | ★★★☆☆ | 非美联储央行的利率决议与政策声明 |
| `crypto_cex_listing` | 交易所上线与爆款标的 | 币安 / OKX 上线新合约 | ★★★★★ | TOP1 币圈热点，CEX 上线新合约直接带来巨量杠杆流动性 |
| `crypto_macro_fomc` | 顶级宏观经济与美联储决策 | FOMC 与美联储决策（影响币圈） | ★★★★★ | TOP2 币圈热点，决定大盘多空方向与资金水龙头 |
| `crypto_btc_milestone` | 比特币大盘关口与主流清算 | BTC 关口 / ETF / 爆仓清算 | ★★★★☆ | TOP3 币圈热点，BTC 整数关口、ETF 数据、爆仓清算 |
| `crypto_eco_meme` | 生态与山寨 Meme 动向 | DeFi / L2 / Meme 生态 | ★★★☆☆ | TOP4 币圈热点，热钱聚集地 |
| `crypto_fund_flow` | 资金与链上数据 | 资金流向与链上数据 | ★★☆☆☆ | ETF 净流入/流出、资金费率、链上巨鲸动向 |
| `platform_binance` | 平台-币安 | 币安广场 | — | 币安广场热榜来源 |
| `platform_okx` | 平台-OKX | OKX 星球 | — | OKX 星球热榜来源 |
| `platform_foresight` | 平台-Foresight | Foresight News | — | Foresight News 新闻来源 |
| `platform_coindesk` | 平台-CoinDesk | CoinDesk 最新 | — | CoinDesk 新闻来源 |
| `platform_blockbeats` | 平台-BlockBeats | BlockBeats 快讯 | — | The BlockBeats 快讯来源 |

> **注意**：`keywords` 字段为内部匹配关键词，外部调用方不应依赖此字段做业务逻辑，请使用 `category_id` 进行筛选。

---

### 3. `GET /api/v1/macro/timeline`

**宏观日历时间轴 API**

返回金十财经日历 + PANews 币圈事件，按时间窗口过滤。

#### 请求参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `channel` | string | `"all"` | `economy` / `crypto` / `all` |
| `min_star` | int | `3` | 最小星级（默认显示 3 星以上） |
| `ahead_hours` | int | `72` | 未来多少小时内的事件 |
| `behind_hours` | int | `72` | 过去多少小时内的已过事件 |
| `refresh` | bool | `false` | 强制重新抓取（仅本机） |

---

### 4. `GET /api/v1/hotlists`

**平台热榜 API**

返回币安 / OKX / Foresight / CoinDesk / BlockBeats 五个平台热榜。

#### 请求参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `refresh` | bool | `false` | 强制重新抓取（仅本机） |

---

### 5. `POST /api/v1/refresh`

**强制刷新所有数据**

仅本机可调用（`127.0.0.1`）。触发宏观日历 + 热榜的立即抓取并落盘。

---

### 6. `GET /api/v1/health`

**健康检查**

```json
{
  "ok": true,
  "status": "ok",
  "service": "news_mornitor",
  "edition": "collector",
  "macro": "jinshi_panews",
  "macro_refresh_sec": 28800,
  "hot_refresh_sec": 3600
}
```

---

## 数据来源与标签体系

### 数据来源

| 来源 | 类型 | 刷新频率 | 说明 |
|------|------|----------|------|
| 金十财经日历 | 宏观日历 | 8h | 包含美联储决议、CPI、非农等重要宏观数据 |
| PANews 事件日历 | 币圈事件 | 8h | CEX 上线、生态动态、代币解锁等币圈事件 |
| 币安广场热榜 | 社区热榜 | 1h | Binance Square Trends |
| OKX 星球热门 | 社区热榜 | 1h | OKX Orbit Topics |
| Foresight News | 新闻源 | 1h | Foresightnews.pro 最新 |
| CoinDesk | 新闻源 | 1h | 最新加密货币新闻 |
| BlockBeats 快讯 | 快讯源 | 1h | The BlockBeats 实时快讯 |

### 标签体系（父子类目）

```
宏观 ── 美联储议息会议（FOMC 决议 & 鲍威尔讲话）
   ├── 美国 CPI（消费者物价指数）
   ├── 美国非农就业数据（NFP）
   ├── 美联储资产负债表政策（QE / QT）
   ├── 重要经济数据（GDP / PMI / 零售）
   └── 其他央行决议（欧央行 / 日本央行等）

币圈 ── 交易所上线与爆款标的（CEX 上线新合约 ★TOP1）
   ├── 顶级宏观经济与美联储决策（大盘多空方向 ★TOP2）
   ├── 比特币大盘关口与主流清算（BTC 关口 / ETF ★TOP3）
   ├── 生态与山寨 Meme 动向（DeFi / L2 / Meme ★TOP4）
   └── 资金与链上数据（ETF 净流入 / 资金费率）

平台 ── 币安 / OKX / Foresight / CoinDesk / BlockBeats（来源标签）
```

---

## 外部调用示例

### Python（requests）

```python
import requests

BASE = "http://127.0.0.1:8770"

# 1. 获取类目文档，构建下拉
categories = requests.get(f"{BASE}/api/v1/events/categories").json()
for cat in categories["categories"]:
    print(cat["category_id"], cat["parent"]["name"])

# 2. 获取全部热点事件（限制 50 条）
events = requests.get(f"{BASE}/api/v1/events", params={"limit": 50}).json()
for item in events["items"]:
    print(item["id"], item["title"], item["category"]["name"])

# 3. 按类目过滤：只看美联储议息会议
fomc = requests.get(
    f"{BASE}/api/v1/events",
    params={"category_id": "macro_fomc", "min_star": 4}
).json()

# 4. 按类目过滤：只看交易所上币热点
listing = requests.get(
    f"{BASE}/api/v1/events",
    params={"category_id": "crypto_cex_listing"}
).json()

# 5. 获取宏观日历（仅金十）
macro = requests.get(
    f"{BASE}/api/v1/macro/timeline",
    params={"channel": "economy", "min_star": 3}
).json()

# 6. 获取热榜
hot = requests.get(f"{BASE}/api/v1/hotlists").json()
for board in hot["boards"]:
    print(board["platform"], len(board["items"]))
```

### JavaScript / Node.js

```javascript
const BASE = "http://127.0.0.1:8770";

// 获取事件
const events = await fetch(`${BASE}/api/v1/events?limit=20`).then(r => r.json());
events.items.forEach(item => {
  console.log(`[${item.category_id}] ${item.title}`);
});

// 按类目过滤
const fomc = await fetch(
  `${BASE}/api/v1/events?category_id=macro_fomc&min_star=4`
).then(r => r.json());

// 获取类目文档
const cats = await fetch(`${BASE}/api/v1/events/categories`).then(r => r.json());
```

### cURL

```bash
# 全部热点事件（50 条）
curl "http://127.0.0.1:8770/api/v1/events?limit=50"

# 按类目过滤（交易所上币）
curl "http://127.0.0.1:8770/api/v1/events?category_id=crypto_cex_listing"

# 类目文档
curl "http://127.0.0.1:8770/api/v1/events/categories"

# 宏观日历
curl "http://127.0.0.1:8770/api/v1/macro/timeline?channel=economy&min_star=3"

# 热榜
curl "http://127.0.0.1:8770/api/v1/hotlists"
```

---

## 注意事项

1. **`refresh` 参数**：仅本机（`127.0.0.1`）可触发强制刷新。外部调用请勿传 `refresh=true`。
2. **数据缓存**：宏观日历缓存 8h，热榜缓存 1h，重复请求直接读缓存。
3. **冷启动**：首次启动时缓存为空，首次请求会自动触发抓取。
4. **稳定 ID**：事件 `id` 由 `md5(source|title|publish_at)` 生成，相同事件每次返回相同 ID，可用于外部去重。
5. **时间格式**：`publish_at` 统一为 UTC ISO 8601 格式（如 `2026-09-08T20:30:00Z`）。
