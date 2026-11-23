#!/usr/bin/env node
/**
 * 按频道 parser 重解析卡片并重跑路径清算。
 *
 *   node scripts/reparse-and-liquidate-channel.mjs 1444962339743989843 30
 */
import "../src/load-env.js";
import { config } from "../src/config.js";
import { openStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";
import { reparseKolvipBriefCard } from "../src/kolvip-brief-card-repair.js";
import { runBatchClearLiquidation, runBatchLiquidation } from "../src/card-liquidation-engine.js";
import { prependKolvipCoinToMessageText, kolvipCoinFromApiRaw } from "../src/kolvip-message-text.js";

const channelId = String(process.argv[2] ?? "").trim();
const days = Math.max(1, Number(process.argv[3] ?? 30) || 30);
if (!channelId) {
  console.error("用法: node scripts/reparse-and-liquidate-channel.mjs <channelId> [days]");
  process.exit(1);
}

const log = createLogger("reparse-liquidate");
const fromMs = Date.now() - days * 86_400_000;
const store = await openStore(config.mysql, log);
const rows = (await store.listSignalCards({ channelId, fromMs, limit: 1200 })) ?? [];

/** @type {number[]} */
const liquidateIds = [];
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
    liquidateIds.push(id);
    continue;
  }
  const prevSym = String(row.symbol ?? "").toUpperCase();
  const nextSym = String(rep.symbol ?? "").toUpperCase();
  await store.updateSignalCard(id, {
    rawContent: rep.content,
    symbol: nextSym,
    assetClass: rep.assetClass,
    parsedJson: rep.parsedJson,
    executionJson: rep.executionJson,
    cardFieldsJson: rep.cardFieldsJson,
    progressJson: null,
    backtestJson: null,
    note: `reparse_liquidate ${new Date().toISOString()}`,
  });
  liquidateIds.push(id);
  report.push({
    id,
    from: prevSym,
    to: nextSym,
    parser: rep.parsedJson?.parser,
    changed: prevSym !== nextSym,
  });
}

/** 重解析后强制可重清算：清 progress/backtest，并将已锁定的 execution.outcome 置回 pending */
for (const id of liquidateIds) {
  const row = await store.getSignalCardById(id);
  if (!row) continue;
  let ex = row.execution_json ?? row.executionJson;
  if (typeof ex === "string") {
    try {
      ex = JSON.parse(ex);
    } catch {
      ex = null;
    }
  }
  const outcome = ex && typeof ex === "object" ? String(ex.outcome ?? "").trim() : "";
  if (outcome && outcome !== "pending") {
    const nextEx = { ...(ex && typeof ex === "object" ? ex : {}), outcome: "pending", actual: null };
    await store.updateSignalCard(id, {
      executionJson: nextEx,
      progressJson: null,
      backtestJson: null,
    });
  }
}

const cleared =
  liquidateIds.length > 0
    ? await runBatchClearLiquidation(store, log, { cardIds: liquidateIds })
    : null;
const liquidation = liquidateIds.length
  ? await runBatchLiquidation(store, log, { cardIds: liquidateIds, limit: liquidateIds.length })
  : null;

console.log(
  JSON.stringify(
    {
      channelId,
      days,
      scanned: rows.length,
      liquidateIds: liquidateIds.length,
      cleared,
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