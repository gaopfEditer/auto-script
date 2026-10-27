/**
 * 卡片评价结果统计（与前端 signalExecution 对齐）。
 */
import { flattenBatchBacktestDoc } from "./card-batch-backtest-engine.js";
import { normalizeExecution, hasEvaluatedYield } from "./discord-signal-execution.js";
import { parseProgressJson } from "./card-level-progress.js";

/** @param {Record<string, unknown> | null} bt */
function backtestView(bt) {
  if (!bt) return null;
  const flat = flattenBatchBacktestDoc(bt);
  return flat && typeof flat === "object" ? flat : bt;
}

/** @param {ReturnType<typeof import("./discord-signal-card-service.js").signalCardToClient>} card */
export function resolveCardEvalOutcome(card) {
  const ex = normalizeExecution(card.execution, card.parsedJson);
  if (ex.outcome && ex.outcome !== "pending") return ex.outcome;

  const progress = parseProgressJson(card.progress);
  const status = String(progress?.status ?? "").trim();
  const tpHits = Array.isArray(progress?.tpHits) ? progress.tpHits : [];
  const po = String(progress?.outcome ?? "").trim();

  if (tpHits.length > 0 || po === "take_profit" || status === "closed_tp") return "take_profit";
  if (status === "closed_sl" || po === "stop_loss" || progress?.slHitAt) return "stop_loss";

  const btRaw =
    card.backtest && typeof card.backtest === "object"
      ? /** @type {Record<string, unknown>} */ (card.backtest)
      : null;
  const bt = backtestView(btRaw);
  const bo = String(bt?.outcome ?? "").trim();
  if (bo === "take_profit" || bo === "stop_loss") {
    const entryHit = Boolean(progress?.entryHitAt);
    if (entryHit || bt?.entry != null || bt?.entered === true) return bo;
  }
  if (bt?.mode === "batch_backtest" && String(progress?.mode ?? "") === "batch_backtest") {
    const po2 = String(progress?.outcome ?? bt?.outcome ?? "").trim();
    if (
      (po2 === "take_profit" || po2 === "stop_loss") &&
      (progress?.entered || bt?.entered || bt?.entry != null)
    ) {
      return po2;
    }
  }

  if (hasEvaluatedYield(ex)) {
    if (tpHits.length > 0) return "take_profit";
    if (progress?.slHitAt || status === "closed_sl") return "stop_loss";
  }

  return ex.outcome || "pending";
}

/**
 * 是否已触发入场（未入场不计入盈亏统计）。
 * @param {ReturnType<typeof import("./discord-signal-card-service.js").signalCardToClient>} card
 */
export function isCardEnteredForEval(card) {
  const progress = parseProgressJson(card.progress);
  const status = String(progress?.status ?? "").trim();
  if (status === "not_entered") return false;

  const entryHit = Boolean(progress?.entryHitAt);
  if (entryHit) return true;
  if (
    status === "entered" ||
    status === "partial_tp" ||
    status === "closed_tp" ||
    status === "closed_sl"
  ) {
    return true;
  }

  const ex = normalizeExecution(card.execution, card.parsedJson);
  if (ex.outcome === "take_profit" || ex.outcome === "stop_loss") return true;
  if (hasEvaluatedYield(ex)) return true;

  const po = String(progress?.outcome ?? "").trim();
  if (po === "take_profit" || po === "stop_loss") return true;

  const btRaw =
    card.backtest && typeof card.backtest === "object"
      ? /** @type {Record<string, unknown>} */ (card.backtest)
      : null;
  const bt = backtestView(btRaw);
  const bo = String(bt?.outcome ?? "").trim();
  if (bo === "take_profit" || bo === "stop_loss") {
    if (bt?.entry != null || bt?.entered === true || entryHit) return true;
  }
  if (bt?.mode === "batch_backtest" && (progress?.entered || bt?.entered)) return true;

  return false;
}

/** @param {ReturnType<typeof import("./discord-signal-card-service.js").signalCardToClient>} card */
export function isSignalCardActiveClient(card) {
  if (card.status === "expired") return false;
  if (!card.expiresAt) return card.status === "active";
  return card.status === "active" && new Date(String(card.expiresAt)).getTime() > Date.now();
}

/**
 * @param {ReturnType<typeof import("./discord-signal-card-service.js").signalCardToClient>[]} cards
 * @param {string} [statusFilter] `active` | `all`
 */
export function filterSignalCardsByUiStatus(cards, statusFilter) {
  const f = String(statusFilter ?? "active").trim().toLowerCase();
  if (f === "all") return cards;
  return cards.filter(isSignalCardActiveClient);
}

/** @param {ReturnType<typeof import("./discord-signal-card-service.js").signalCardToClient>[]} cards */
export function summarizeCardsByOutcome(cards) {
  /** @type {Record<string, number>} */
  const byOutcome = {
    total: 0,
    pending: 0,
    take_profit: 0,
    stop_loss: 0,
    manual_close: 0,
    cancelled: 0,
    not_entered: 0,
  };
  for (const c of cards) {
    if (!isCardEnteredForEval(c)) {
      byOutcome.not_entered++;
      continue;
    }
    byOutcome.total++;
    const o = resolveCardEvalOutcome(c);
    if (o in byOutcome && o !== "total" && o !== "not_entered") byOutcome[o]++;
    else byOutcome.pending++;
  }
  return byOutcome;
}
