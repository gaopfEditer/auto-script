#!/usr/bin/env node
import "../src/load-env.js";
import { config } from "../src/config.js";
import { openStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";
import { signalCardToClient } from "../src/discord-signal-card-service.js";
import { evaluateLiquidation } from "../src/card-liquidation-engine.js";
import { fetchKlinesForCard } from "../src/card-price-fetch.js";
import { getCardVerifyPlan } from "../src/card-verify-policy.js";

const log = createLogger("sim-3018");
const store = await openStore(config.mysql, log);
const row = await store.getSignalCardById(3018);
const card = signalCardToClient(row);
const plan = getCardVerifyPlan(card);
const specs = [
  { label: "wrong_catchup_22h", signalMs: Date.parse("2026-11-21T14:20:51.000Z"), entry: 3548.04, tps: [3540, 3528, 3519], sl: 3576 },
  { label: "created_at_1553", signalMs: Date.parse("2026-11-21T07:53:45.286Z"), entry: 3564, tps: [3552, 3540, 3528, 3519], sl: 3576 },
  { label: "morning_10am", signalMs: Date.parse("2026-11-21T02:00:00.000Z"), entry: 3564, tps: [3552, 3540, 3528, 3519], sl: 3576 },
];
for (const s of specs) {
  const endMs = Math.min(Date.now(), s.signalMs + plan.window.durationMs);
  const klines = await fetchKlinesForCard("XAUUSDT", "crypto", s.signalMs, endMs, plan.window.klineInterval);
  const r = evaluateLiquidation(card, klines, {
    signalMs: s.signalMs,
    forcedEntry: { price: s.entry, hitAt: new Date(s.signalMs).toISOString() },
    fixedLevels: { tps: s.tps, sl: s.sl },
  });
  const first3 = klines.filter((k) => (k.ts ?? 0) >= s.signalMs).slice(0, 8);
  console.log(
    s.label,
    JSON.stringify({
      outcome: r.outcome,
      pnl: r.pnlPct,
      slHitAt: r.slHitAt,
      tpHits: r.tpHits,
      bars: first3.map((k) => ({ t: new Date(k.ts).toISOString(), h: k.high, l: k.low })),
    })
  );
}
await store.close?.();