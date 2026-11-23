#!/usr/bin/env node
/**
 * 重解析巨鲸单行模板误标品种卡，并触发清算。
 *
 *   node scripts/repair-kolvip-brief-cards.mjs kolvip-scan-39 3
 */
import "../src/load-env.js";
import { config } from "../src/config.js";
import { openStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";
import { reparseKolvipBriefCard } from "../src/kolvip-brief-card-repair.js";
import { runBatchLiquidation } from "../src/card-liquidation-engine.js";
import { prependKolvipCoinToMessageText, kolvipCoinFromApiRaw } from "../src/kolvip-message-text.js";

const channelId = String(process.argv[2] ?? "kolvip-scan-39").trim();
const days = Math.max(1, Number(process.argv[3] ?? 3) || 3);
const log = createLogger("kolvip-brief-repair");

const fromMs = Date.now() - days * 24 * 60 * 60 * 1000;
const store = await openStore(config.mysql, log);

const rows = (await store.listSignalCards({ channelId, fromMs, limit: 500 })) ?? [];
/** @type {number[]} */
const repairedIds = [];
/** @type {Array<Record<string, unknown>>} */
const report = [];

for (const row of rows) {
  const id = Number(row.id ?? row.ID);
  if (!Number.isFinite(id)) continue;
  const messageId = String(row.message_id ?? row.messageId ?? "").trim();
  let messageRaw = null;
  if (messageId && store.getDiscordMessageRawJson) {
    messageRaw = await store.getDiscordMessageRawJson(messageId);
  }
  const cardRow = { ...row, message_raw_json: messageRaw };
  let contentOverride = undefined;
  const apiCoin = kolvipCoinFromApiRaw(messageRaw?.kolvip ? { coin: messageRaw.kolvip.coin } : messageRaw);
  if (apiCoin) {
    contentOverride = prependKolvipCoinToMessageText(
      String(row.raw_content ?? row.rawContent ?? ""),
      apiCoin
    );
  }
  const rep = reparseKolvipBriefCard(cardRow, contentOverride);
  if (!rep.ok) {
    report.push({ id, skipped: rep.reason });
    continue;
  }
  const prevSym = String(row.symbol ?? "").toUpperCase();
  const nextSym = String(rep.symbol ?? "").toUpperCase();
  let prevEntry = "";
  try {
    const pj = JSON.parse(String(row.parsed_json ?? row.parsedJson ?? "{}"));
    prevEntry = String(pj?.entry ?? "");
  } catch {
    /* ignore */
  }
  const nextEntry = String(rep.parsedJson?.entry ?? "");
  const same = prevSym === nextSym && prevEntry === nextEntry;
  if (same) {
    report.push({ id, skipped: "unchanged", symbol: prevSym });
    continue;
  }
  await store.updateSignalCard(id, {
    rawContent: rep.content,
    symbol: nextSym,
    parsedJson: rep.parsedJson,
    executionJson: rep.executionJson,
    cardFieldsJson: rep.cardFieldsJson,
    cardsByStyle: rep.cardsByStyle,
    progressJson: null,
    backtestJson: null,
    note: `kolvip_brief_repair ${new Date().toISOString()}`,
  });
  repairedIds.push(id);
  report.push({ id, from: prevSym, to: nextSym, parser: rep.parsedJson?.parser });
}

let liquidation = null;
if (repairedIds.length) {
  liquidation = await runBatchLiquidation(store, log, { cardIds: repairedIds });
}

console.log(
  JSON.stringify(
    {
      channelId,
      days,
      scanned: rows.length,
      repaired: repairedIds.length,
      repairedIds,
      liquidation,
      details: report,
    },
    null,
    2
  )
);

try {
  await store.close?.();
} catch {
  /* ignore */
}