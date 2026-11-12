/**
 * 按币种补扫未决单（与 progress 队列互补）：
 * node src/card-eval-pending-settle-batch.js AIOUSDT ERAUSDT ...
 */
import "./load-env.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { tryOpenStore } from "./store.js";
import { archiveCardToClient } from "./card-archive-service.js";
import { isCardEnteredForEval } from "./card-eval-outcome.js";
import {
  buildEvalNotEnteredClosePatch,
  buildEvalPendingSettlePatch,
  forceCloseEvalCardAtMark,
  isCardUnsettledForEval,
  settleEvalPendingCard,
} from "./card-eval-pending-settle.js";

const log = createLogger("card-eval-settle");
const symbols = process.argv.slice(2).filter((a) => a && a !== "--");
if (!symbols.length) {
  console.error("用法: node src/card-eval-pending-settle-batch.js SYMBOL [SYMBOL…]");
  process.exit(1);
}

const { store, offline } = await tryOpenStore(config.mysql, log);
if (offline) process.exit(1);
const now = Date.now();
let settled = 0;
let closed = 0;
let skipped = 0;
for (const sym of symbols) {
  const rows = await store.listCardsForEval({
    fromMs: 0,
    toMs: now,
    symbol: sym,
    limit: 80,
  });
  for (const row of rows) {
    const card = archiveCardToClient(row);
    if (!isCardUnsettledForEval(card)) continue;
    if (!isCardEnteredForEval(card)) {
      await store.updateSignalCard(card.id, buildEvalNotEnteredClosePatch(card, "eval_force_not_entered"));
      closed += 1;
      continue;
    }
    const doc = await settleEvalPendingCard(card, {
      force: true,
      nearMarketEntryPct: config.cardEvalNearMarketEntryPct,
    });
    if (doc.ok && doc.notEntered) {
      await store.updateSignalCard(card.id, buildEvalNotEnteredClosePatch(card, String(doc.reason ?? "not_entered")));
      closed += 1;
      continue;
    }
    if (doc.skipped) {
      await store.updateSignalCard(card.id, buildEvalNotEnteredClosePatch(card, String(doc.reason ?? "skipped")));
      closed += 1;
      continue;
    }
    if (!doc.ok || !doc.result) {
      const markResult = await forceCloseEvalCardAtMark(card);
      if (markResult) {
        await store.updateSignalCard(card.id, buildEvalPendingSettlePatch(card, markResult));
        settled += 1;
        continue;
      }
      await store.updateSignalCard(card.id, buildEvalNotEnteredClosePatch(card, String(doc.error ?? "failed")));
      closed += 1;
      log.warn(`失败结案 #${card.id} ${sym} ${doc.error ?? "unknown"}`);
      continue;
    }
    await store.updateSignalCard(card.id, buildEvalPendingSettlePatch(card, doc.result));
    settled += 1;
    log.info(`结算 #${card.id} ${sym} ${doc.result.outcome} pnl=${doc.result.pnlPct}`);
  }
}
console.log(JSON.stringify({ ok: true, symbols, settled, closed, skipped }, null, 2));
await store.close?.();
