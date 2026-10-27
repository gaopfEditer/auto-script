# 币安 BTC 实时交易辅助系统

基于资金清算与换手动能的实时信号生成系统。四大自治模块交叉引用，输出结构化交易看板。

## 架构

```
realtime-btc/
├── main.py                          # 入口
├── requirements.txt
├── .env.example
├── ReadMe.md                        # 原始需求说明
└── realtime_btc/
    ├── config.py                    # 配置
    ├── models.py                    # 共享数据模型
    ├── orchestrator.py              # 编排器（串联四模块）
    ├── exchange/
    │   ├── rest_client.py           # ccxt REST（K线、OI 历史）
    │   └── ws_client.py             # WebSocket（K线、OI、强平流）
    ├── indicators/
    │   ├── __init__.py              # EMA、收针形态
    │   └── volume_profile.py        # POC / VAH / VAL
    ├── modules/
    │   ├── trend_filter.py          # 模块1：Vegas 趋势过滤
    │   ├── static_levels.py         # 模块2：静态空间锚定
    │   ├── realtime_flow.py         # 模块3：OI + 强平监控
    │   └── decision_engine.py       # 模块4：信心指数决策
    └── output/
        └── dashboard.py             # 终端 / Webhook 看板
```

## 四大模块

| 模块 | 输入 | 输出 |
|------|------|------|
| Trend Filter | 1H / 4H K线 | `MULTI_ONLY` / `SHORT_ONLY` / `NEUTRAL` |
| Static Levels | 日线 + 近3日成交量 | POC、High[1]、Low[1]、VAH、VAL、1H Vegas |
| Realtime Flow | `!forceOrder@arr`、OI WebSocket | `OI_Spike`、`Liquidation_Panic` |
| Decision Engine | 上述 + 当前价 | 信心指数 0–100、挂单向导 |

## 安装

```bash
cd realtime-btc
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
copy .env.example .env
```

## 运行

```bash
python main.py
```

无需 API Key 即可拉取公开行情；若需更高频率限制可配置 `BINANCE_API_KEY`。

## 环境变量

见 `.env.example`。常用项：

- `SYMBOL=BTCUSDT`
- `BINANCE_PROXY=http://127.0.0.1:7890` — 国内访问币安 REST/WebSocket 代理（Clash/V2Ray 等）
- `BINANCE_REQUEST_TIMEOUT_MS=30000` — REST 超时（毫秒）
- `PROXIMITY_BAND_PCT=0.5` — 触发评级的价格误差带
- `LIQUIDATION_PANIC_USD=1000000` — 1 分钟强平恐慌阈值（美元）
- `WEBHOOK_URL` — 可选，将看板 JSON 推送到外部

## 数据流

1. **冷启动**：ccxt 拉取 1H/4H/1D K线 → 趋势 + 静态位
2. **WebSocket**：`btcusdt@kline_*`、`@openInterest@1s`、`!forceOrder@arr`
3. **每 5 秒**：融合模块状态 → 决策引擎 → 终端看板

## 免责声明

本系统仅供研究与辅助决策，不构成投资建议。实盘交易请自行承担风险。
