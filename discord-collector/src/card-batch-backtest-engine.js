/**
 * 卡片批量回溯：双策略（固定 5% 止损 + 7/10/20% 止盈 vs 卡片自带 TP/SL）、
 * 市价/限价入场、每 4h 标记盈亏、超 3 天取消任务。
 */
import { calcLeveragePnl, fetchKlinesForCard } from "./card-price-fetch.js";
import { archiveCardToClient } from "./card-archive-service.js";
import { config } from "./config.js";
import { hasEvaluatedYield, normalizeExecution } from "./discord-signal-execution.js";
import { resolveCardSignalAt } from "./discord-signal-card-service.js";
import {
  evaluateLiquidation,
  resolveLiquidationPlan,
  shouldSkipLiquidation,
} from "./card-liquidation-engine.js";

/** @typedef {'fixed_5_7_10_20' | 'card'} BatchBacktestProfileId */

export const BATCH_PROFILES = /** @type {const} */ ({
  FIXED: "fixed_5_7_10_20",
  CARD: "card",
});

/** @param {boolean} isShort @param {number} entry */
export function buildFixed5071020Levels(entry, isShort) {
  const slPct = 0.05;
  const tpPcts = [0.07, 0.1, 0.2];
  const sl = isShort ? entry * (1 + slPct) : entry * (1 - slPct);
  const tps = tpPcts.map((p) => (isShort ? entry * (1 - p) : entry * (1 + p)));
  return { tps, sl, tpPcts, slPct };
}

export function batchBacktestSliceMs() {
  return Math.max(3_600_000, (Number(config.cardBacktestSliceHours) || 4) * 3_600_000);
}

export function batchBacktestMaxMs() {
  return Math.max(batchBacktestSliceMs(), (Number(config.cardBacktestMaxDays) || 3) * 86_400_000);
}

/**
 * @param {Array<{ ts?: number, close?: number, open?: number, high?: number, low?: number }>} klines
 * @param {number} ts
 */
function markPriceAtOrBefore(klines, ts) {
  const sorted = [...klines].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  let last = null;
  for (const k of sorted) {
    const kts = k.ts ?? 0;
    if (kts > ts) break;
    const p = Number(k.close ?? k.open ?? (Number(k.high) + Number(k.low)) / 2);
    if (Number.isFinite(p) && p > 0) last = p;
  }
  return last;
}

/**
 * @param {ReturnType<typeof evaluateLiquidation>} base
 * @param {Array<{ ts?: number, close?: number, open?: number, high?: number, low?: number }>} klines
 * @param {number} endMs
 */
function attachPeriodicSettlements(base, klines, endMs) {
  const entryMs = base.entryHitAt ? Date.parse(String(base.entryHitAt)) : NaN;
  if (!base.entered || !Number.isFinite(entryMs)) {
    return { periodicSettlements: [], taskCancelled: false };
  }
  const sliceMs = batchBacktestSliceMs();
  const capMs = entryMs + batchBacktestMaxMs();
  const evalEnd = Math.min(endMs, capMs);
  /** @type {Array<{ at: string, ts: number, price: number, pnlPct: number }>} */
  const periodicSettlements = [];
  for (let t = entryMs + sliceMs; t <= evalEnd; t += sliceMs) {
    const price = markPriceAtOrBefore(klines, t);
    if (price == null) continue;
    const pnl = calcLeveragePnl(
      base.entryPriceUsed,
      price,
      Boolean(base.isShort),
      Number(base.leverage) || 20
    );
    periodicSettlements.push({
      at: new Date(t).toISOString(),
      ts: t,
      price,
      pnlPct: pnl ? Math.round(pnl.pnlPctOnMargin * 100) / 100 : 0,
    });
  }
  const taskCancelled = evalEnd >= capMs && base.outcome === "pending";
  return { periodicSettlements, taskCancelled };
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {Array<{ ts?: number, high: number, low: number, close?: number, open?: number }>} klines
 * @param {{ signalMs: number, profile: BatchBacktestProfileId, endMs?: number }} opts
 */
export function evaluateProfileBacktest(card, klines, opts) {
  const signalMs = Number(opts.signalMs);
  const profile = opts.profile;
  const endMs = Number.isFinite(Number(opts.endMs))
    ? Math.min(Number(opts.endMs), signalMs + batchBacktestMaxMs())
    : Math.min(Date.now(), signalMs + batchBacktestMaxMs());

  /** @type {{ tps: number[], sl: number } | undefined} */
  let fixedLevels;
  if (profile === BATCH_PROFILES.FIXED) {
    const ex = normalizeExecution(card.execution);
    const isShort = String(ex.direction ?? "").toLowerCase().includes("short");
    const entryProbe = evaluateLiquidation(card, klines, { signalMs, maxEndMs: endMs });
    const entry = entryProbe.entryPriceUsed ?? entryProbe.marketAtSignal;
    if (entry != null && Number.isFinite(Number(entry))) {
      fixedLevels = buildFixed5071020Levels(Number(entry), isShort);
    }
  }

  const base = evaluateLiquidation(card, klines, {
    signalMs,
    maxEndMs: endMs,
    fixedLevels,
  });
  const { periodicSettlements, taskCancelled } =
    base.outcome === "pending" || base.outcome === "take_profit"
      ? attachPeriodicSettlements(base, klines, endMs)
      : { periodicSettlements: [], taskCancelled: false };

  /** @type {Record<string, unknown>} */
  const out = {
    ...base,
    profile,
    entryMode: base.plannedEntry != null && !base.marketAtSignal ? "limit" : "market",
    sliceHours: Number(config.cardBacktestSliceHours) || 4,
    maxDays: Number(config.cardBacktestMaxDays) || 3,
    backtestEndMs: endMs,
    periodicSettlements,
    taskCancelled,
  };

  if (taskCancelled) {
    out.outcome = "expired";
    out.status = "expired";
    out.note = "超过 3 天未触达止盈/止损，回溯任务已取消";
    if (periodicSettlements.length) {
      const last = periodicSettlements[periodicSettlements.length - 1];
      out.pnlPct = last.pnlPct;
      out.periodicMark = last;
      const lev = Number(base.leverage) || 20;
      out.pnlLabel = `${last.pnlPct >= 0 ? "+" : ""}${last.pnlPct.toFixed(2)}% (@${lev}x, 4h标记)`;
    }
  } else if (base.outcome === "pending" && periodicSettlements.length) {
    const last = periodicSettlements[periodicSettlements.length - 1];
    out.periodicMark = last;
    out.pnlPct = last.pnlPct;
    const lev = Number(base.leverage) || 20;
    out.pnlLabel = `${last.pnlPct >= 0 ? "+" : ""}${last.pnlPct.toFixed(2)}% (@${lev}x, 4h标记)`;
    out.note = "未触达止盈止损，按最近 4h 收盘价估算盈亏";
  }

  return out;
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {{ profiles?: BatchBacktestProfileId[], force?: boolean }} [opts]
 */
export async function runCardBatchBacktest(card, opts = {}) {
  const skip = shouldSkipBatchBacktest(card, opts);
  if (skip) return { skipped: true, reason: skip, mode: "batch_backtest" };

  const plan = resolveLiquidationPlan(card);
  if (plan.skip) {
    return { skipped: true, reason: plan.reason ?? "stock_no_market", mode: "batch_backtest" };
  }

  const signalAt = resolveCardSignalAt(card) ?? card.signalAt ?? card.createdAt;
  const signalMs = signalAt ? Date.parse(String(signalAt)) : NaN;
  if (!Number.isFinite(signalMs)) {
    return { error: "invalid_signal_at", mode: "batch_backtest" };
  }

  const sym = String(card.symbol ?? "").trim();
  if (!sym) return { error: "no_symbol", mode: "batch_backtest" };

  const endMs = Math.min(Date.now(), signalMs + batchBacktestMaxMs());
  const klines = await fetchKlinesForCard(
    sym,
    plan.assetClass,
    signalMs,
    endMs,
    plan.window?.klineInterval ?? "5m"
  );

  const profiles = (opts.profiles?.length ? opts.profiles : [BATCH_PROFILES.FIXED, BATCH_PROFILES.CARD]).filter(
    (p) => p === BATCH_PROFILES.FIXED || p === BATCH_PROFILES.CARD
  );

  /** @type {Record<string, unknown>} */
  const byProfile = {};
  for (const profile of profiles) {
    byProfile[profile] = evaluateProfileBacktest(card, klines, { signalMs, profile, endMs });
  }

  const primary =
    byProfile[BATCH_PROFILES.CARD] ?? byProfile[BATCH_PROFILES.FIXED] ?? Object.values(byProfile)[0];

  const taskCancelled = Object.values(byProfile).some(
    (p) => p && typeof p === "object" && /** @type {Record<string, unknown>} */ (p).taskCancelled
  );

  return {
    mode: "batch_backtest",
    signalAt: new Date(signalMs).toISOString(),
    symbol: sym,
    profiles: byProfile,
    primaryProfile: profiles.includes(BATCH_PROFILES.CARD) ? BATCH_PROFILES.CARD : profiles[0],
    outcome: primary?.outcome ?? "pending",
    pnlPct: primary?.pnlPct ?? 0,
    pnlLabel: primary?.pnlLabel ?? null,
    settledAt: new Date().toISOString(),
    sliceHours: Number(config.cardBacktestSliceHours) || 4,
    maxDays: Number(config.cardBacktestMaxDays) || 3,
    taskCancelled,
  };
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {{ force?: boolean }} [opts]
 */
export function shouldSkipBatchBacktest(card, opts = {}) {
  if (opts.force) return null;
  const ex = normalizeExecution(card.execution);
  if (hasEvaluatedYield(ex)) return "evaluated_yield";
  const prog = card.progress && typeof card.progress === "object" ? card.progress : null;
  if (prog && prog.taskCancelled === true) return "task_cancelled_3d";
  const bt =
    card.backtest && typeof card.backtest === "object"
      ? /** @type {Record<string, unknown>} */ (card.backtest)
      : null;
  if (bt?.mode === "batch_backtest") {
    if (bt.taskCancelled === true) return "already_cancelled";
    return null;
  }
  if (ex.outcome && ex.outcome !== "pending") return "outcome_set";
  return null;
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {Record<string, unknown>} doc
 */
export function buildBatchBacktestPatch(card, doc) {
  const ex = normalizeExecution(card.execution);
  const primaryKey = String(doc.primaryProfile ?? BATCH_PROFILES.CARD);
  const primary =
    doc.profiles && typeof doc.profiles === "object"
      ? /** @type {Record<string, unknown>} */ (doc.profiles)[primaryKey]
      : null;
  const p =
    primary && typeof primary === "object" ? /** @type {Record<string, unknown>} */ (primary) : null;

  const nextCheckAt = new Date(Date.now() + batchBacktestSliceMs()).toISOString();

  /** @type {Record<string, unknown>} */
  const patch = {
    backtestJson: {
      ...doc,
      autoEval: true,
    },
    progressJson: {
      mode: "batch_backtest",
      lastCheckAt: new Date().toISOString(),
      nextCheckAt,
      primaryProfile: primaryKey,
      outcome: doc.outcome ?? "pending",
      pnlPct: doc.pnlPct ?? 0,
      taskCancelled: Boolean(doc.taskCancelled ?? p?.taskCancelled),
      sliceHours: doc.sliceHours ?? 4,
      maxDays: doc.maxDays ?? 3,
    },
  };

  if (
    p &&
    p.entered &&
    (p.outcome === "take_profit" || p.outcome === "stop_loss") &&
    p.entryPriceUsed != null &&
    p.settlementPrice != null
  ) {
    patch.executionJson = {
      ...ex,
      outcome: p.outcome,
      autoEval: {
        source: "batch_backtest",
        profile: primaryKey,
        pnlPct: p.pnlPct,
        settlementPrice: p.settlementPrice,
        at: p.settlementAt ?? p.entryHitAt ?? null,
      },
    };
  }

  return patch;
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {{ fromMs?: number, toMs?: number, channelId?: string, sourceTypes?: string[], symbol?: string, limit?: number, cardIds?: number[], profiles?: BatchBacktestProfileId[], force?: boolean }} opts
 * @param {{ onCardUpdated?: (id: number) => void | Promise<void> }} [hooks]
 */
export async function runBatchBacktest(store, log, opts = {}, hooks = {}) {
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 300));
  const cardIds = (opts.cardIds ?? [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  /** @type {Awaited<ReturnType<typeof store.listCardsForEval>>} */
  let rows = [];
  if (cardIds.length) {
    for (const id of cardIds) {
      const row = await store.getSignalCardById(id);
      if (row) rows.push(row);
    }
  } else if (store.listCardsForEval) {
    const fromMs = Number(opts.fromMs);
    const toMs = Number(opts.toMs);
    rows = await store.listCardsForEval({
      fromMs: Number.isFinite(fromMs) ? fromMs : Date.now() - 7 * 86400000,
      toMs: Number.isFinite(toMs) ? toMs : Date.now(),
      channelId: opts.channelId || undefined,
      limit,
    });
  }

  if (!cardIds.length) {
    rows = rows.slice(0, limit);
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  /** @type {Array<Record<string, unknown>>} */
  const items = [];

  for (const row of rows) {
    const card = archiveCardToClient(row);
    try {
      const result = await runCardBatchBacktest(card, {
        profiles: opts.profiles,
        force: Boolean(opts.force),
      });
      if (result.skipped) {
        skipped += 1;
        items.push({ id: card.id, symbol: card.symbol, skipped: result.reason });
        continue;
      }
      if (result.error) {
        failed += 1;
        items.push({ id: card.id, symbol: card.symbol, error: result.error });
        continue;
      }
      const patch = buildBatchBacktestPatch(card, result);
      await store.updateSignalCard(card.id, patch);
      if (hooks.onCardUpdated) await hooks.onCardUpdated(card.id);
      processed += 1;
      log.info(
        `批量回溯 #${card.id} ${card.symbol} outcome=${result.outcome} pnl=${result.pnlPct ?? "-"}`
      );
      items.push({
        id: card.id,
        symbol: card.symbol,
        outcome: result.outcome,
        pnlPct: result.pnlPct,
      });
    } catch (e) {
      failed += 1;
      items.push({
        id: card.id,
        symbol: card.symbol,
        error: String(/** @type {Error} */ (e).message ?? e),
      });
    }
  }

  return { ok: true, processed, skipped, failed, total: rows.length, items };
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {number} [nowMs]
 */
export function isBatchBacktestDue(card, nowMs = Date.now()) {
  if (!config.cardBatchBacktestEnabled) return false;
  if (shouldSkipBatchBacktest(card, {})) return false;
  const prog = card.progress && typeof card.progress === "object" ? card.progress : null;
  if (prog?.mode !== "batch_backtest") return false;
  if (prog.taskCancelled) return false;
  const signalAt = resolveCardSignalAt(card) ?? card.signalAt ?? card.createdAt;
  const signalMs = signalAt ? Date.parse(String(signalAt)) : NaN;
  if (!Number.isFinite(signalMs)) return false;
  if (nowMs - signalMs > batchBacktestMaxMs()) return false;
  const ex = normalizeExecution(card.execution);
  if (ex.outcome && ex.outcome !== "pending") return false;
  const next = prog.nextCheckAt ? Date.parse(String(prog.nextCheckAt)) : NaN;
  if (Number.isFinite(next) && nowMs < next) return false;
  return true;
}
