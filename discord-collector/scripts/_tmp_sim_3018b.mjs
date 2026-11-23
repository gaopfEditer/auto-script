#!/usr/bin/env node
import "../src/load-env.js";
import { config } from "../src/config.js";
import { openStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";
import { signalCardToClient } from "../src/discord-signal-card-service.js";
import { evaluateLiquidation } from "../src/card-liquidation-engine.js";
import { fetchKlinesForCard } from "../src/card-price-fetch.js";
import { getCardVerifyPlan } from "../src/card-verify-policy.js";

const log = createLogger("sim-3018b");
const store = await openStore(config.mysql, log);
const row = await store.getSignalCardById(3018);
const card = signalCardToClient(row);
card.parsedJson = { ...card.parsedJson, entry: "3560$ - 3568$", takeProfits: ["3552", "3540", "3528", "3519"], stopLoss: "3576" };
card.execution = {
  ...card.execution,
  planned: {
    entryPrice: "3560$ - 3568$",
    takeProfitPrices: ["3552", "3540", "3528", "3519"],
    stopLossPrice: "3576",
  },
};
const plan = getCardVerifyPlan(card);
const specs = [
  { label: "limit_10am", signalMs: Date.parse("2026-11-21T02:00:00.000Z") },
  { label: "limit_msg_created", signalMs: Date.parse("2026-11-21T07:53:45.286Z") },
  { label: "limit_wrong_22h", signalMs: Date.parse("2026-11-21T14:20:51.000Z") },
];
for (const s of specs) {
  const endMs = Math.min(Date.now(), s.signalMs + plan.window.durationMs);
  const klines = await fetchKlinesForCard("XAUUSDT", "crypto", s.signalMs, endMs, plan.window.klineInterval);
  const r = evaluateLiquidation(card, klines, { signalMs: s.signalMs });
  console.log(
    s.label,
    JSON.stringify({
      outcome: r.outcome,
      pnl: r.pnlPct,
      entered: r.entered,
      status: r.status,
      entryHitAt: r.entryHitAt,
      entryPriceUsed: r.entryPriceUsed,
      slHitAt: r.slHitAt,
      tpHits: r.tpHits,
      note: r.note,
    })
  );
}
await store.close?.();