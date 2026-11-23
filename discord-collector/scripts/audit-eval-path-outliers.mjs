#!/usr/bin/env node
/**
 * 审计本地路径评估异常卡（默认大镖客 30d）。
 *   node scripts/audit-eval-path-outliers.mjs [channelId] [days]
 */
import "../src/load-env.js";
import { config } from "../src/config.js";
import { openStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";
import { archiveCardToClient } from "../src/card-archive-service.js";
import { evalCardPathQualityIssue } from "../src/card-eval-path-quality.js";
import { classifyCardEval } from "../src/card-eval-api.js";

const channelId = String(process.argv[2] ?? "1444962339743989843").trim();
const days = Math.max(1, Number(process.argv[3] ?? 30) || 30);
const fromMs = Date.now() - days * 86_400_000;

const log = createLogger("audit-eval-path");
const store = await openStore(config.mysql, log);
const rows = (await store.listSignalCards({ channelId, fromMs, limit: 800 })) ?? [];

/** @type {Array<Record<string, unknown>>} */
const corrupt = [];
let entered = 0;
let sumPnl = 0;

for (const row of rows) {
  const card = archiveCardToClient(row);
  const c = classifyCardEval(card);
  if (!c.entered) continue;
  entered += 1;
  sumPnl += Number(c.pnlPct) || 0;
  const issue = evalCardPathQualityIssue(card);
  if (issue) {
    corrupt.push({
      id: card.id,
      symbol: card.symbol,
      pnlPct: c.pnlPct,
      issue,
    });
  }
}

const cleanPnl = corrupt.reduce((s, x) => s - (Number(x.pnlPct) || 0), sumPnl);
const report = {
  channelId,
  days,
  entered,
  corruptCount: corrupt.length,
  sumPnlRaw: Math.round(sumPnl * 100) / 100,
  sumPnlAfterFilter: Math.round(cleanPnl * 100) / 100,
  samples: corrupt.slice(0, 25),
};
console.log(JSON.stringify(report, null, 2));