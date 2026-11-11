# post_card — 统一发帖 → 交易卡 → 回溯

Unified pipeline for **Telegram / Discord / Twitter (X)** posts: normalize to one card schema, dedupe, merge direction + TP/SL within 15 minutes, default **5% SL / 10% TP**, and replay OHLC for MFE / MAE / drawdown-before-peak-MFE.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `POST_CARD_MERGE_WINDOW_SEC` | `900` | Merge TP/SL follow-ups after direction message |
| `POST_CARD_DEDUPE_WINDOW_SEC` | `300` | Skip duplicate same source+symbol+direction |
| `POST_CARD_DEFAULT_SL_PCT` | `0.05` | Default stop loss % from entry |
| `POST_CARD_DEFAULT_TP_PCT` | `0.10` | Default take profit % from entry |
| `POST_CARD_BACKTEST_HORIZON_SEC` | `604800` | Max replay horizon (7d) |

Telegram `default_tpsl.py` reads the same `POST_CARD_DEFAULT_*` keys.

## Normalize (CLI)

From repo root:

```bash
PYTHONPATH=/workspace:/workspace/telegram python3 -m post_card normalize fixtures/posts.json -o out/cards.json
```

Input JSON: list of objects with `source` (`telegram` | `discord` | `twitter`), `text`, ids, and channel metadata.

## Backtest (CLI)

Uses injectable OHLC JSON (no live Binance required):

```bash
PYTHONPATH=/workspace:/workspace/telegram python3 -m post_card backtest --cards out/cards.json --ohlc fixtures/ohlc.json
```

Metrics per card: `maxFavorablePct`, `maxAdversePct`, `drawdownBeforeMaxFavorablePct`, `outcome` (`hit_tp` | `hit_sl` | `timeout` | `both_ambiguous`).

## Telegram bridge

`telegram/post_card_bridge.py` exposes `TelegramPostCardBridge` for optional use alongside `listen.py` / `TradeCardPusher` without changing the production path.

## Tests

```bash
PYTHONPATH=/workspace:/workspace/telegram python3 -m unittest discover -s post_card/tests -p 'test_*.py'
```
