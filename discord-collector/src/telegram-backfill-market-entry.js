/**
 * Telegram 回溯：未入场卡片「按信号时刻市价假设入场」覆盖（持久化，可批量清空）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dedupeBackfillCards, dedupeBackfillGroupCards } from "./backfill-card-dedup.js";
import { sanitizeBacktestOutcome } from "./backfill-card-quality.js";
import { runUnifiedBatchBacktestOnSignal } from "./backfill-batch-eval.js";
import { createLogger } from "./logger.js";

const log = createLogger("telegram-backfill-market-entry");
const TELEGRAM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../telegram");
const CACHE_DIR = path.join(TELEGRAM_DIR, ".backfill_cache");
const OVERRIDE_FILE = path.join(CACHE_DIR, "market_entry_overrides.json");
const BACKTEST_CACHE_ROOT = path.join(CACHE_DIR, "backtest");

/** @returns {Record<string, unknown>} */
function loadStore() {
  try {
    if (!fs.existsSync(OVERRIDE_FILE)) return { version: 1, periods: {} };
    const raw = JSON.parse(fs.readFileSync(OVERRIDE_FILE, "utf8"));
    if (raw && typeof raw === "object") return raw;
  } catch {
    /* ignore */
  }
  return { version: 1, periods: {} };
}

/** @param {Record<string, unknown>} store */
function saveStore(store) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(store, null, 2), "utf8");
}

/**
 * @param {string} period
 * @param {string} [chatId]
 */
export function readMarketEntryOverrides(period, chatId) {
  const store = loadStore();
  const periods = /** @type {Record<string, unknown>} */ (store.periods ?? {});
  const bucket = periods[period];
  if (!bucket || typeof bucket !== "object") return chatId ? {} : {};
  if (!chatId) return /** @type {Record<string, unknown>} */ (bucket);
  const row = /** @type {Record<string, unknown>} */ (bucket)[chatId];
  return row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row) : {};
}

/**
 * @param {string} period
 * @param {string} chatId
 * @param {Record<string, unknown>} map digest -> override item
 */
function writeChatOverrides(period, chatId, map) {
  const store = loadStore();
  const periods = /** @type {Record<string, Record<string, unknown>>>} */ (store.periods ?? {});
  if (!periods[period]) periods[period] = {};
  periods[period][chatId] = map;
  store.periods = periods;
  saveStore(store);
}

/**
 * @param {Record<string, unknown>} card
 */
export function backfillCardDigest(card) {
  const d = String(card.digest ?? "").trim();
  if (d) return d;
  const at = String(card.signalAt ?? card.at ?? "").trim();
  const sym = String(card.symbol ?? "").trim();
  return `${at}|${sym}|${String(card.phase ?? "")}`;
}

/**
 * @param {Array<Record<string, unknown>>} items
 */
export function summarizeBacktestItems(items) {
  let wins = 0;
  let losses = 0;
  let notEntered = 0;
  let errors = 0;
  let totalPnlPct = 0;
  let pnlSummedCount = 0;
  let backtestsRun = 0;

  for (const item of items) {
    backtestsRun += 1;
    const p = Number(item.pnlPct);
    if (item.backtestInvalid) {
      errors += 1;
      continue;
    }
    if (item.error && !item.entered) errors += 1;
    else if (!item.entered) notEntered += 1;
    else if (Number.isFinite(p) && p > 0) wins += 1;
    else if (Number.isFinite(p) && p < 0) losses += 1;
    else if (item.outcome === "take_profit") wins += 1;
    else if (item.outcome === "stop_loss") losses += 1;
    if (Number.isFinite(p)) {
      totalPnlPct += p;
      pnlSummedCount += 1;
    }
  }
  const decided = wins + losses;
  return {
    wins,
    losses,
    notEntered,
    backtestErrors: errors,
    backtestsRun,
    winRate: decided ? wins / decided : null,
    totalPnlPct: pnlSummedCount ? Math.round(totalPnlPct * 100) / 100 : null,
    pnlSummedCount,
  };
}

/**
 * @param {Record<string, unknown>} group
 * @param {Record<string, unknown>} overridesByDigest
 */
export function mergeGroupWithMarketOverrides(group, overridesByDigest) {
  const raw = Array.isArray(group.backtestItems) ? group.backtestItems : [];
  if (!raw.length || !overridesByDigest || !Object.keys(overridesByDigest).length) {
    return group;
  }
  /** @type {Array<Record<string, unknown>>} */
  const merged = raw.map((item) => {
    const key = backfillCardDigest(item);
    const ov = overridesByDigest[key];
    const row =
      ov && typeof ov === "object"
        ? { ...item, ...ov, marketEntryOverride: true }
        : item;
    return sanitizeBacktestOutcome(item, row);
  });
  const deduped = dedupeBackfillCards(merged).filter((c) => !c.backtestInvalid);
  const stats = summarizeBacktestItems(deduped);
  return { ...group, backtestItems: deduped, ...stats };
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} period
 */
export function applyMarketOverridesToPayload(payload, period) {
  if (!payload || typeof payload !== "object") return payload;
  const all = readMarketEntryOverrides(period);
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const next = groups.map((g) => {
    if (!g || typeof g !== "object") return g;
    const chatId = String(g.chatId ?? "");
    const map = chatId && all[chatId] && typeof all[chatId] === "object"
      ? /** @type {Record<string, unknown>} */ (all[chatId])
      : {};
    const withOv = mergeGroupWithMarketOverrides(/** @type {Record<string, unknown>} */ (g), map);
    let row = dedupeBackfillGroupCards(withOv);
    if (row.dedupDropped && Array.isArray(row.backtestItems)) {
      row = { ...row, ...summarizeBacktestItems(/** @type {Array<Record<string, unknown>>} */ (row.backtestItems)) };
    }
    return row;
  });
  return { ...payload, groups: next, marketEntryOverridesApplied: true };
}

/**
 * @param {Record<string, unknown>} group
 * @param {string[]} digests
 */
function findSignalsForDigests(group, digests) {
  const want = new Set(digests.map((d) => String(d).trim()).filter(Boolean));
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  const pools = [
    ...(Array.isArray(group.backtestItems) ? group.backtestItems : []),
    ...(Array.isArray(group.cards) ? group.cards : []),
  ];
  const seen = new Set();
  for (const row of pools) {
    if (!row || typeof row !== "object") continue;
    const key = backfillCardDigest(row);
    if (!want.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * @param {{
 *   period: string;
 *   chatId: string;
 *   group: Record<string, unknown>;
 *   digests: string[];
 *   action: "apply" | "clear";
 *   delayMs?: number;
 * }} opts
 */
export async function mutateMarketEntryOverrides(opts) {
  const { period, chatId, group, digests, action } = opts;
  const delayMs = Number(opts.delayMs) >= 0 ? Number(opts.delayMs) : 200;
  const current = readMarketEntryOverrides(period, chatId);
  /** @type {Record<string, unknown>} */
  const next = { ...current };

  if (action === "clear") {
    for (const d of digests) {
      const key = String(d).trim();
      if (key) delete next[key];
    }
    writeChatOverrides(period, chatId, next);
    return { overrides: next, applied: [], cleared: digests };
  }

  const signals = findSignalsForDigests(group, digests);
  const meta = {
    channelId: chatId,
    channelName: String(group.name ?? ""),
    sourceType: "telegram",
    forceMarketEntry: true,
    skipCache: true,
    backtestCacheRoot: BACKTEST_CACHE_ROOT,
  };

  /** @type {Array<Record<string, unknown>>} */
  const applied = [];
  for (const signal of signals) {
    const key = backfillCardDigest(signal);
    if (!key) continue;
    if (signal.entered && !signal.marketEntryOverride) continue;
    const item = await runUnifiedBatchBacktestOnSignal(signal, meta);
    const strip = { ...item };
    delete strip.backtestDoc;
    next[key] = {
      ...strip,
      marketEntryOverride: true,
      overrideAt: new Date().toISOString(),
    };
    applied.push({ digest: key, entered: item.entered, pnlPct: item.pnlPct, error: item.error });
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  writeChatOverrides(period, chatId, next);
  log.info(`市价入场覆盖 ${chatId} period=${period} +${applied.length}`);
  return { overrides: next, applied, cleared: [] };
}
