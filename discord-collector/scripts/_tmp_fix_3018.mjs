#!/usr/bin/env node
import "../src/load-env.js";
import { config } from "../src/config.js";
import { openStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";
import { parseKolvipBrief } from "../src/discord-signal-parsers.js";
import { executionFromParsed } from "../src/discord-signal-execution.js";
import { runBatchClearLiquidation, runBatchLiquidation } from "../src/card-liquidation-engine.js";
import mysql from "mysql2/promise";

const QUEEN_TEXT =
  "Coin: #XAUUSDT Direction: SHORT Leverage: 50x Entry: 3560$ - 3568$ Targets: 3552 - 3540 - 3528- 3519$ Stoploss: 3576$ 币种：#XAUUSDT 方向：做空 杠杆：50倍 入场价：3560$ - 3568$ 目标价：3552 - 3540 - 3528 - 3519$ 止损：3576$";

const log = createLogger("fix-3018");
const store = await openStore(config.mysql, log);
const row = await store.getSignalCardById(3018);
if (!row) {
  console.error("SC-3018 不存在");
  process.exit(1);
}

const parsed = parseKolvipBrief(QUEEN_TEXT);
if (!parsed) {
  console.error("重解析失败");
  process.exit(1);
}
const execution = executionFromParsed(parsed);
const createdMs = Date.parse(String(row.created_at ?? row.createdAt));

await store.updateSignalCard(3018, {
  parsedJson: { ...parsed, symbol: "XAUUSDT", asset: "XAUUSDT" },
  executionJson: execution,
  progressJson: null,
  backtestJson: null,
  signalAt: row.created_at ?? row.createdAt,
});

const msgId = String(row.message_id ?? row.messageId ?? "").trim();
if (msgId) {
  const pool = await mysql.createConnection(config.mysql);
  await pool.query("UPDATE discord_messages SET created_at_ms=? WHERE message_id=?", [createdMs, msgId]);
  await pool.end();
}

await runBatchClearLiquidation(store, log, { cardIds: [3018] });
const liq = await runBatchLiquidation(store, log, { cardIds: [3018], limit: 1 });
const fresh = await store.getSignalCardById(3018);
console.log(
  JSON.stringify(
    {
      parsed_tps: parsed.takeProfits,
      signal_at: fresh.signal_at,
      message_created_at_ms: fresh.message_created_at_ms,
      execution: typeof fresh.execution_json === "string" ? JSON.parse(fresh.execution_json) : fresh.execution_json,
      progress: typeof fresh.progress_json === "string" ? JSON.parse(fresh.progress_json) : fresh.progress_json,
      liq: liq.items?.[0],
    },
    null,
    2
  )
);
await store.close?.();