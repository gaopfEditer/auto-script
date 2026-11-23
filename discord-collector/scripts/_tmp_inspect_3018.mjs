#!/usr/bin/env node
import "../src/load-env.js";
import { config } from "../src/config.js";
import { openStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";
import { liquidateCard, runBatchLiquidation } from "../src/card-liquidation-engine.js";
import { signalCardToClient } from "../src/discord-signal-card-service.js";
import { resolveCardSignalAt } from "../src/discord-signal-card-service.js";

const cardId = Number(process.argv[2] ?? 3018);
const log = createLogger("inspect-3018");
const store = await openStore(config.mysql, log);
const row = await store.getSignalCardById(cardId);
const parsed =
  typeof row.parsed_json === "string" ? JSON.parse(row.parsed_json) : row.parsed_json;
if (!row) {
  console.error("no card");
  process.exit(1);
}
const card = signalCardToClient(row);
const signalAt = resolveCardSignalAt(row, card);
console.log(
  JSON.stringify(
    {
      id: row.id,
      uid: row.uid,
      symbol: row.symbol,
      signal_at: row.signal_at,
      created_at: row.created_at,
      discord_message_id: row.discord_message_id,
      message_created_at_ms: row.message_created_at_ms,
      message_cn: row.message_created_at_ms
        ? new Date(row.message_created_at_ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
        : null,
      parsed_entry: parsed?.entry,
      parsed_tps: parsed?.takeProfits,
      parsed_sl: parsed?.stopLoss,
      resolvedSignalAt: signalAt,
      execution: card.execution,
      progress: card.progress,
    },
    null,
    2
  )
);
const liq = await liquidateCard(card);
console.log("liquidation_dry", JSON.stringify(liq, null, 2));
const batch = await runBatchLiquidation(store, log, { cardIds: [cardId], limit: 1 });
console.log("liquidation_batch", JSON.stringify(batch, null, 2));
await store.close?.();