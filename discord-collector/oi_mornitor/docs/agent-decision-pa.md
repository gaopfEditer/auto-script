# Agent decision / price-action layer (read-only)

> **完整信号清单与交易/决策边界**见 **[signals-and-decision-logic.md](./signals-and-decision-logic.md)**（含 P0 方向一致性、B 分类、流动性五态、Shadow Veto、三类研究策略）。  
> **研究回测逐步操作**：[§10 Playbook](./signals-and-decision-logic.md#10-研究回测操作手册-playbook)。

## Parallel groups (A / B / C)

| Group | Meaning |
|-------|---------|
| **A** | Existing morphology / VP / MA / Vegas / TD9 |
| **B** | PA chain; **position tags do not confirm direction**; liquidity five-phase states |
| **C** | Resonance when **A and B are active and directions agree** (not mere tag count) |

`agentDecision.version`: `agent-decision-v2`.

## Research strategies (registered, not scheduled)

Three **independent** matchers on each alert (`researchStrategies.matches`):

1. **liquidity_reversal** — sweep → reclaim → structure confirm → OB/FVG zone  
2. **trend_pullback_continuation** — LTF trend + pullback + BOS/VP (HTF marked `missingContext`)  
3. **range_mean_reversion** — range proxy + bounds + sweep/VWAP/VP  

- `backtestStatus`: `planned_p1` — no live merge, no unified score, **no** Bitget/WEEX path.  
- A signal may match **multiple** strategies (`matchedIds`).

## Enable (analysis only)

```env
OI_AGENT_DECISION_ENABLED=1
OI_AGENT_DECISION_PERSIST_PA=0
OI_AGENT_DECISION_MIN_B_TAGS=1
OI_AGENT_DECISION_NEAR_OB_PCT=0.5
```

Default **off**. Does not change Bitget/WEEX/Telegram auto-order paths.

## Shadow veto

`shadowVeto.status`: `pass` | `warning` | `veto` — recorded only, **does not** block orders or TG.

## APIs

- `GET /api/pattern-alert-stats?decisionGroup=A|B|C`
- `POST /api/agent-decision/screen`
- `scripts/backfill_agent_decision_expectancy.py`

## Code map

- `pa/b_tags.py` — B taxonomy + liquidity phases  
- `pa/research_strategies.py` — three strategy definitions  
- `agent_decision.py` — orchestration  
- `pattern_emit_gate.attach_confluence_on_alert` — attaches when enabled
