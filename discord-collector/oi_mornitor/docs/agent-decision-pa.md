# Agent decision / price-action layer (read-only)

> **完整信号清单与交易/决策边界**（含既有形态 + B 组 PA + C 组共振 + Bitget/WEEX 实盘路径）见 **[signals-and-decision-logic.md](./signals-and-decision-logic.md)**。

Inspired by [rasattrading-mcp](https://github.com/saldraykee22/rasattrading-mcp) analysis ideas — **no** order execution, credentials, or exchange daemons.

## Parallel groups

| Group | Meaning |
|-------|---------|
| **A** | Existing morphology / VP / MA / Vegas / MACD / TD9 (confluence features + card kind) |
| **B** | PA chain: swings → BOS/CHoCH → liquidity (sweep/reclaim) → OB/FVG → UTC-daily VWAP |
| **C** | Resonance when **A** and **B** are both active (same alert) |

Stored on `pattern_alert_stats` records as `agentDecision` (and on in-flight alerts before stats write).

## Enable (analysis only)

```env
OI_AGENT_DECISION_ENABLED=1
# optional JSONL PA snapshots under data/pa_analysis/
OI_AGENT_DECISION_PERSIST_PA=0
OI_AGENT_DECISION_MIN_B_TAGS=1
OI_AGENT_DECISION_NEAR_OB_PCT=0.5
```

Default is **off**. Does not change Bitget/WEEX/Telegram auto-order paths.

## APIs

- List filter: `GET /api/pattern-alert-stats?decisionGroup=A|B|C`
- Screener: `POST /api/agent-decision/screen` with `{ symbol, interval, filter, klines, extras? }`
- Expectancy hook: `oi_mornitor/scripts/backfill_agent_decision_expectancy.py`

## VWAP convention

Crypto **UTC calendar-day** anchored VWAP (volume-weighted typical price), consistent across intervals.

## Shadow veto

`shadowVeto` is recorded on the alert/stats row only — **does not** block live orders.

## Code map

- `oi_mornitor/pa/` — pure PA modules
- `oi_mornitor/agent_decision.py` — A/B/C + veto + expectancy key
- `oi_mornitor/pattern_emit_gate.attach_confluence_on_alert` — attaches when enabled
