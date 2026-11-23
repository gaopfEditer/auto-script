#!/usr/bin/env node
/** 修复 cards_by_style 误存 JSON；回补卡 signal_at 对齐 discord_messages.created_at_ms */
import "../src/load-env.js";
import { config } from "../src/config.js";
import { openStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";
import { signalCardToClient } from "../src/discord-signal-card-service.js";
import {
  coerceCardsByStyleForClient,
  isParsedJsonStyleBlob,
} from "../src/card-external-sink.js";
import mysql from "mysql2/promise";

const log = createLogger("repair-card-styles");
const dryRun = process.argv.includes("--dry-run");

const store = await openStore(config.mysql, log);
const pool = await mysql.createConnection({
  host: config.mysql.host,
  port: config.mysql.port,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database,
});

const [rows] = await pool.query(
  `SELECT sc.id, sc.cards_by_style, sc.parsed_json, sc.raw_content
   FROM discord_signal_cards sc
   WHERE sc.cards_by_style LIKE '%"parser"%'
   ORDER BY sc.id DESC
   LIMIT 2000`,
);

let styleFixed = 0;
for (const row of rows) {
  let styles;
  try {
    styles = typeof row.cards_by_style === "string" ? JSON.parse(row.cards_by_style) : row.cards_by_style;
  } catch {
    continue;
  }
  if (!styles || typeof styles !== "object") continue;
  const hasBlob = Object.values(styles).some((v) => isParsedJsonStyleBlob(String(v ?? "")));
  if (!hasBlob) continue;
  let parsedJson = row.parsed_json;
  if (typeof parsedJson === "string") {
    try {
      parsedJson = JSON.parse(parsedJson);
    } catch {
      parsedJson = null;
    }
  }
  const fixed = coerceCardsByStyleForClient(
    { parsedJson, rawContent: row.raw_content ?? "" },
    /** @type {Record<string, string>} */ (styles),
  );
  if (dryRun) {
    console.log(`[dry-run] #${row.id}`, fixed.cn_brief?.slice(0, 60));
    styleFixed += 1;
    continue;
  }
  await store.updateSignalCard(Number(row.id), { cardsByStyle: fixed });
  styleFixed += 1;
}

const [sig] = await pool.query(
  `UPDATE discord_signal_cards sc
   INNER JOIN discord_messages dm ON dm.message_id = sc.message_id
   SET sc.signal_at = FROM_UNIXTIME(dm.created_at_ms / 1000, '%Y-%m-%d %H:%i:%s.%f')
   WHERE dm.created_at_ms > 0
     AND sc.signal_at IS NOT NULL
     AND TIMESTAMPDIFF(SECOND, sc.signal_at, sc.created_at) BETWEEN -5 AND 5
     AND ABS(UNIX_TIMESTAMP(sc.signal_at) * 1000 - dm.created_at_ms) > 3600000`,
);
const signalAtFixed = /** @type {{ affectedRows?: number }} */ (sig).affectedRows ?? 0;

console.log(
  JSON.stringify({ ok: true, dryRun, styleFixed, signalAtFixed }, null, 2),
);
await pool.end();
await store.close?.();