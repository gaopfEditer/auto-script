#!/usr/bin/env node
/** 从 kolvip-scan-27 历史消息补建「新开仓」卡片 */
import "../src/load-env.js";
import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { openStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";
import { createDiscordSignalCardService } from "../src/discord-signal-card-service.js";
import { runSignalCardPipelineForRows } from "../src/discord-signal-pipeline.js";

const CHANNEL = "kolvip-scan-27";
const DAYS = Math.max(1, Number(process.argv[2] ?? 60) || 60);

const log = createLogger("aoying-backfill");
const store = await openStore(config.mysql, log);
const signalCards = createDiscordSignalCardService(store, log, () => {}, {
  skipTelegram: true,
});
const toMs = Date.now();
const fromMs = toMs - DAYS * 86_400_000;
const pool = await mysql.createConnection({
  host: config.mysql.host,
  port: config.mysql.port,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database,
});
const [messages] = await pool.query(
  `SELECT message_id, channel_id, created_at_ms, content, source, raw_json
   FROM discord_messages
   WHERE channel_id = ? AND created_at_ms >= ? AND created_at_ms <= ?
     AND content LIKE '%新开仓%'
   ORDER BY created_at_ms ASC
   LIMIT 500`,
  [CHANNEL, fromMs, toMs],
);
await pool.end();
const norm = (s) => String(s ?? "").replace(/\\n/g, "\n");
const rows = messages
  .filter((m) => /注意[，,]?\s*新开仓/.test(norm(m.content)))
  .map((m) => {
    const createdAtMs = Number(m.created_at_ms ?? m.createdAtMs ?? 0);
    return {
      messageId: m.message_id ?? m.messageId,
      channelId: CHANNEL,
      content: norm(m.content),
      createdAt: m.created_at ?? m.createdAt,
      createdAtMs: Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : undefined,
      rawJson: m.raw_json ?? m.rawJson ?? {},
      source: m.source ?? "kolvip_api_backfill",
    };
  });

log.info(`待处理新开仓消息 ${rows.length} 条（${DAYS}d）`);
const pipe = await runSignalCardPipelineForRows(rows, {
  signalCards,
  store,
  log,
  skipTelegram: true,
  respectKolvipBypass: false,
  skipOllamaFallback: true,
  skipKolvipTop10Mirror: true,
});
console.log(JSON.stringify({ ok: true, queued: rows.length, created: pipe.created, skipCounts: pipe.skipCounts }, null, 2));