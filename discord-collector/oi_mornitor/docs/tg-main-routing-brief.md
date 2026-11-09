# MAIN 群 Telegram 路由（-1003860925903）

> **非正式延用策略**：推送为实时观测 + 共振标签，不构成回测签收或盈利盖章（A 槽正式延用仍 0 套）。

## 目标群与白名单

| 配置 | 含义 |
|------|------|
| `MAIN_CARD_TELEGRAM_CHAT_ID` | `-1003860925903`（短线/长线/结构统一打到该群） |
| `OI_MAIN_CARD_DEFAULT_SYMBOLS` | `BTCUSDT, ETHUSDT, QQQUSDT, SUIUSDT`（MAIN 镜像白名单） |
| `OI_MAIN_CARD_OTHER_SYMBOLS` | 含 BTC/ETH/SUI → 形态群（candle）可推 |
| `OI_MAIN_CARD_LONG_SYMBOLS` | 美股/商品合约长线形态名单 |
| `OI_CONFLUENCE_PUSH_MIN_TIER` | **B** 及以上才推 TG |

## 通道对照

| 你要的 | 实现 | 周期 |
|--------|------|------|
| **短线** | 射击之星 / 倒锤子 `candle_pattern_card` | 默认 15m（+ MTF 门控） |
| **长线** | 同形态 + `structure_pattern_card`（头肩、M 顶等） | 1h / 4h / 1d |
| **共振** | 文案内 confluence 分档；`OI_CONFLUENCE_PUSH_MIN_TIER=B` 过滤 |
| **较高胜率观感** | B+ 门槛 + 4h 结算摘要（非盈利签收） |

## 路由逻辑（`pattern_monitor` · 2026-11-09）

1. 满足放量且 `is_candle_card_push_symbol` → `send_candle_card_telegram_async`（形态群 chat = MAIN 时同群）。
2. **若未发**（形态开关关 / 不在 LONG·OTHER / 发送失败）且 `is_main_card_mirror_eligible` → `send_main_card_telegram_async`（避免 BTC/ETH 仅在 DEFAULT 却被 LONG 名单挡住）。
3. 结构卡：`send_structure_card_telegram_async`（需 OTHER/LONG 名单或名单未配置）。
4. 量价确认/推进：**不进 MAIN**，仅形态群（若开）。

## 运行时开关

- 持久化：`pattern_state/telegram_push_toggles.json`（覆盖 env）
- API：`GET http://127.0.0.1:8765/api/telegram-push-toggles`
- 重启：`pnpm run oi:start`（或 collect:ui 守护重启）

## 验收清单

- [ ] `transport.ready` = true
- [ ] `toggles.candle` / `structure` / `main` = true
- [ ] 四币 `is_candle_card_push_symbol` + `is_main_card_symbol` 均为 true
