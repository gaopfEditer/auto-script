/**
 * 回溯场景：虚拟归档卡片 + 统一 batch_backtest（card-batch-backtest-engine）。
 */
import "./load-env.js";
import fs from "node:fs";
import path from "node:path";
import { archiveCardToClient } from "./card-archive-service.js";
import { dedupeBackfillCards } from "./backfill-card-dedup.js";
import {
  filterQualityBackfillCards,
  isBackfillKlineMiss,
  sanitizeBacktestOutcome,
} from "./backfill-card-quality.js";
import { config } from "./config.js";
import {
  BATCH_PROFILES,
  flattenBatchBacktestDoc,
  runCardBatchBacktest,
} from "./card-batch-backtest-engine.js";
import { resolveDiscordMessageCreatedAtMs } from "./discord-gateway.js";
import { normalizeExecution } from "./discord-signal-execution.js";

/** 回测逻辑或 profile 变更时递增，使磁盘缓存失效 */
export const BACKFILL_BACKTEST_ENGINE_VERSION = "6";

/** @param {string} msg @param {string} [symbol] */
function softenKlineErrorForUi(msg, symbol) {
  const sym = String(symbol ?? "").trim();
  if (/K线全部|FUTURES_ALL|no_klines|no_market_price/i.test(msg)) {
    return {
      error: sym ? `K线暂缺 (${sym})` : "K线暂缺",
      klineFailed: true,
      errorDetail: msg.slice(0, 240),
    };
  }
  return null;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {Record<string, unknown>} item */
function shouldPersistBacktestCache(item) {
  if (item.backtestInvalid) return false;
  const err = String(item.error ?? "");
  if (/K线全部|FUTURES_ALL|no_klines|no_market_price/i.test(err)) return false;
  if (err && !item.entered && item.outcome === "error") return false;
  return true;
}

/**
 * @param {string} root
 * @param {string} chatId
 * @param {string} digest
 */
function backtestCachePath(root, chatId, digest) {
  const safeChat = String(chatId || "unknown").replace(/[^\w-]/g, "_");
  const safeDigest = String(digest || "").replace(/[^\w-]/g, "_").slice(0, 120);
  return path.join(root, safeChat, `${safeDigest}.json`);
}

/**
 * @param {string} filePath
 */
function readBacktestCache(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    if (String(raw.engineVersion) !== BACKFILL_BACKTEST_ENGINE_VERSION) return null;
    if (!raw.item || typeof raw.item !== "object") return null;
    return /** @type {Record<string, unknown>} */ (raw.item);
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {Record<string, unknown>} item
 */
function writeBacktestCache(filePath, item) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          engineVersion: BACKFILL_BACKTEST_ENGINE_VERSION,
          cachedAt: new Date().toISOString(),
          item,
        },
        null,
        0,
      ),
      "utf8",
    );
  } catch {
    /* ignore cache write errors */
  }
}

/**
 * @param {unknown} raw
 */
export function normalizeBackfillDirection(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "long" || s === "多") return "long";
  if (s === "short" || s === "空") return "short";
  return "";
}

/**
 * @param {unknown} raw
 */
function normalizeTargets(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x ?? "").trim()).filter(Boolean);
  const s = String(raw ?? "").trim();
  if (!s) return [];
  return s
    .split(/[,，;/\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * @param {Record<string, unknown>} signal
 * @param {{ channelId?: string, channelName?: string, sourceType?: string }} meta
 */
export function buildVirtualArchiveCard(signal, meta = {}) {
  const payload =
    signal.cardPayload && typeof signal.cardPayload === "object"
      ? /** @type {Record<string, unknown>} */ (signal.cardPayload)
      : {};
  const symbol = String(signal.symbol ?? payload.symbol ?? "").trim().toUpperCase();
  const dirNorm =
    normalizeBackfillDirection(signal.directionNorm) ||
    normalizeBackfillDirection(payload.direction) ||
    normalizeBackfillDirection(signal.direction);
  const directionLabel =
    dirNorm === "long" ? "多" : dirNorm === "short" ? "空" : String(signal.direction ?? "");
  const entry = String(signal.entry ?? payload.entry ?? "").trim();
  const stopLoss = String(signal.stopLoss ?? payload.stopLoss ?? "").trim();
  const targets = normalizeTargets(signal.targets ?? payload.targets);
  let signalAt = String(signal.signalAt ?? signal.at ?? payload.signalAt ?? "").trim();
  if (!signalAt) {
    const ms = resolveDiscordMessageCreatedAtMs({
      messageId: signal.messageId ?? payload.messageId,
      rawMessage: signal.rawJson ?? payload.rawJson,
    });
    if (ms > 0) signalAt = new Date(ms).toISOString();
  }
  const rawContent = String(signal.preview ?? signal.body ?? payload.body ?? "").trim();
  const channelId = String(meta.channelId ?? payload.channelId ?? signal.channelId ?? "").trim();
  const channelName = String(meta.channelName ?? payload.channelName ?? "").trim();

  const execution = normalizeExecution(
    {
      symbol,
      direction: directionLabel,
      planned: {
        entryPrice: entry,
        stopLossPrice: stopLoss,
        takeProfitPrices: targets,
      },
    },
    {
      symbol,
      direction: directionLabel,
      entry,
      stopLoss,
      targets,
    },
  );

  const row = {
    id: `bf-${channelId}-${signalAt}-${symbol}`.slice(0, 120),
    source_type: meta.sourceType ?? "telegram",
    source: meta.sourceType ?? "telegram",
    channel_id: channelId,
    channel_name: channelName,
    symbol,
    raw_content: rawContent,
    signal_at: signalAt,
    execution_json: execution,
    parsed_json: {
      symbol,
      direction: directionLabel,
      entry: entry || undefined,
      stopLoss: stopLoss || undefined,
      targets: targets.length ? targets : undefined,
    },
    source_ref: payload.sourceRef ?? signal.sourceRef ?? null,
  };
  return archiveCardToClient(row);
}

/**
 * @param {Record<string, unknown> | null | undefined} doc
 */
export function batchBacktestOutcome(doc) {
  const flat = flattenBatchBacktestDoc(doc);
  if (!flat) return { entered: false, outcome: "error", pnlPct: null, pnlLabel: null, error: "no_doc" };
  if (flat.error) {
    return {
      entered: false,
      outcome: "error",
      pnlPct: null,
      pnlLabel: null,
      error: String(flat.error),
      flat,
    };
  }
  if (flat.skipped) {
    return {
      entered: false,
      outcome: "skipped",
      pnlPct: null,
      pnlLabel: null,
      error: String(flat.reason ?? "skipped"),
      flat,
    };
  }
  const entered = Boolean(flat.entered);
  const pnlPct = Number(flat.pnlPct);
  const pnlLabel = flat.pnlLabel != null ? String(flat.pnlLabel) : null;
  let outcome = String(flat.outcome ?? "pending");
  if (entered && Number.isFinite(pnlPct)) {
    if (pnlPct > 0) outcome = "take_profit";
    else if (pnlPct < 0) outcome = "stop_loss";
  }
  const base = {
    entered,
    outcome,
    pnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
    pnlLabel,
    flat,
    backtest: flat,
  };
  return sanitizeBacktestOutcome({}, base);
}

/**
 * @param {Record<string, unknown>} signal
 * @param {{ channelId?: string, channelName?: string, sourceType?: string, profiles?: string[]; backtestCacheRoot?: string; skipCache?: boolean }} meta
 */
export async function runUnifiedBatchBacktestOnSignal(signal, meta = {}) {
  const digest = String(signal.digest ?? "").trim();
  const cacheRoot = meta.backtestCacheRoot ? String(meta.backtestCacheRoot) : "";
  const chatId = String(meta.channelId ?? signal.channelId ?? "").trim();
  if (cacheRoot && digest && !meta.skipCache) {
    const cached = readBacktestCache(backtestCachePath(cacheRoot, chatId, digest));
    if (cached) {
      return sanitizeBacktestOutcome(
        { ...signal, digest },
        { ...cached, fromCache: true },
      );
    }
  }

  /** @type {Record<string, unknown>} */
  const base = {
    phase: signal.phase,
    symbol: signal.symbol,
    direction: signal.direction,
    signalAt: signal.signalAt ?? signal.at,
    entry: signal.entry ?? null,
    stopLoss: signal.stopLoss ?? null,
    preview: signal.preview ?? null,
    digest: digest || signal.digest || null,
  };
  const fullSignal = { ...signal, ...base };
  try {
    const client = buildVirtualArchiveCard(signal, meta);
    const doc = await runCardBatchBacktest(client, {
      force: true,
      forceMarketEntry: Boolean(meta.forceMarketEntry),
      // 与卡片批量回溯一致：首轮单轮换所，失败后再开自适应（减请求、少 429）
      adaptiveKlines: Boolean(meta.klineRetried),
      profiles: meta.profiles?.length
        ? meta.profiles
        : [BATCH_PROFILES.CARD, BATCH_PROFILES.FIXED],
    });
    const parsed = batchBacktestOutcome(doc);
    if (doc.error) {
      return sanitizeBacktestOutcome(fullSignal, {
        ...base,
        ...parsed,
        error: String(doc.error),
        backtestDoc: doc,
      });
    }
    if (doc.skipped) {
      const out = sanitizeBacktestOutcome(fullSignal, {
        ...base,
        ...parsed,
        entered: false,
        skipped: true,
        skipReason: String(doc.reason ?? "skipped"),
        backtestDoc: doc,
      });
      if (cacheRoot && digest && shouldPersistBacktestCache(out)) {
        writeBacktestCache(backtestCachePath(cacheRoot, chatId, digest), out);
      }
      return out;
    }
    const out = sanitizeBacktestOutcome(fullSignal, {
      ...base,
      ...parsed,
      primaryProfile: doc.primaryProfile,
      backtestDoc: doc,
      marketEntryOverride: Boolean(meta.forceMarketEntry),
      marketAtSignal: parsed.flat?.marketAtSignal ?? parsed.backtest?.marketAtSignal ?? null,
      entryPriceUsed: parsed.flat?.entryPriceUsed ?? parsed.backtest?.entryPriceUsed ?? null,
    });
    if (cacheRoot && digest && shouldPersistBacktestCache(out)) {
      writeBacktestCache(backtestCachePath(cacheRoot, chatId, digest), out);
    }
    return out;
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message ?? e);
    if (!meta.klineRetried && /FUTURES_ALL|K线全部|no_klines/i.test(msg)) {
      await sleep(3500);
      return runUnifiedBatchBacktestOnSignal(signal, {
        ...meta,
        skipCache: true,
        klineRetried: true,
      });
    }
    const soft = softenKlineErrorForUi(msg, String(signal.symbol ?? ""));
    const out = sanitizeBacktestOutcome(fullSignal, {
      ...base,
      entered: false,
      outcome: "pending",
      pnlPct: null,
      pnlLabel: null,
      ...(soft ?? { error: msg.slice(0, 80), klineFailed: /K线|FUTURES_ALL/i.test(msg) }),
    });
    return out;
  }
}

/**
 * @param {Record<string, unknown>} group
 * @param {{ maxBacktests?: number; sourceType?: string; delayMs?: number; backtestCacheRoot?: string; skipBacktestCache?: boolean }} [opts]
 */
export async function backtestBackfillGroupUnified(group, opts = {}) {
  const maxBt = Math.max(0, Number(opts.maxBacktests) || 200);
  const defaultDelay = Math.max(0, Number(config.telegramBackfillBacktestDelayMs) || 450);
  const meta = {
    channelId: String(group.chatId ?? group.channelId ?? ""),
    channelName: String(group.name ?? ""),
    sourceType: opts.sourceType ?? "telegram",
    backtestCacheRoot: opts.backtestCacheRoot,
    skipCache: Boolean(opts.skipBacktestCache),
  };
  /** @type {Array<Record<string, unknown>>} */
  const rawCards = Array.isArray(group.cards)
    ? group.cards
    : Array.isArray(group.samples)
      ? group.samples
      : [];
  const cardsToTest = dedupeBackfillCards(
    filterQualityBackfillCards(/** @type {Array<Record<string, unknown>>} */ (rawCards)),
  );
  const baseDelay =
    Number(opts.delayMs) >= 0 ? Number(opts.delayMs) : defaultDelay;
  const delayMs = Math.min(1500, baseDelay + Math.floor(cardsToTest.length / 60) * 75);

  /** @type {Array<Record<string, unknown>>} */
  const backtestItems = [];
  let backtestsRun = 0;
  let wins = 0;
  let losses = 0;
  let notEntered = 0;
  let errors = 0;
  let klineMiss = 0;
  let skipped = 0;
  let cacheHits = 0;
  let klineStreak = 0;

  for (let i = 0; i < cardsToTest.length && backtestsRun < maxBt; i += 1) {
    const row = cardsToTest[i];
    if (!row || typeof row !== "object") continue;
    const signal = /** @type {Record<string, unknown>} */ ({ ...row });
    const noEntry = !String(signal.entry ?? "").trim();
    let item = await runUnifiedBatchBacktestOnSignal(signal, {
      ...meta,
      forceMarketEntry: Boolean(meta.forceMarketEntry) || noEntry,
    });
    item = sanitizeBacktestOutcome(signal, item);
    if (item.backtestInvalid) {
      errors += 1;
      backtestItems.push(item);
      if (delayMs > 0) await sleep(delayMs);
      continue;
    }
    backtestsRun += 1;
    backtestItems.push(item);
    if (item.fromCache) cacheHits += 1;

    if (item.skipped) skipped += 1;
    else if (isBackfillKlineMiss(item)) klineMiss += 1;
    else if (item.error && !item.entered) errors += 1;
    else if (!item.entered) notEntered += 1;
    else if (item.pnlPct != null && Number(item.pnlPct) > 0) wins += 1;
    else if (item.pnlPct != null && Number(item.pnlPct) < 0) losses += 1;
    else if (item.outcome === "take_profit") wins += 1;
    else if (item.outcome === "stop_loss") losses += 1;

    if (item.fromCache) {
      klineStreak = 0;
      continue;
    }
    let waitMs = delayMs;
    if (isBackfillKlineMiss(item)) {
      klineStreak += 1;
      waitMs += Math.min(10_000, 1200 * klineStreak);
    } else {
      klineStreak = 0;
    }
    if (waitMs > 0) await sleep(waitMs);
    await new Promise((r) => setImmediate(r));
  }

  const decided = wins + losses;
  let totalPnlPct = 0;
  let pnlSummedCount = 0;
  for (const item of backtestItems) {
    const p = Number(item.pnlPct);
    if (Number.isFinite(p)) {
      totalPnlPct += p;
      pnlSummedCount += 1;
    }
  }
  return {
    ...group,
    backtestItems,
    backtestsRun,
    wins,
    losses,
    notEntered,
    backtestErrors: errors,
    backtestKlineMiss: klineMiss,
    backtestSkipped: skipped,
    winRate: decided ? wins / decided : null,
    totalPnlPct: pnlSummedCount ? Math.round(totalPnlPct * 100) / 100 : null,
    pnlSummedCount,
    backtestMode: "batch_backtest",
    backtestCacheHits: cacheHits,
  };
}
