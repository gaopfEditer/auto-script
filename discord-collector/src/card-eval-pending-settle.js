/**
 * 评估口径：已入场且超过固定窗口仍未触达 TP/SL → 按窗口末价强制结算。
 */
import { archiveCardToClient } from "./card-archive-service.js";
import {
  alignPnlWithOutcome,
  calcLeveragePnl,
  fetchFuturesPrice,
  fetchKlinesForCard,
  parseEntryPrice,
} from "./card-price-fetch.js";
import {
  cardSignalStartMs,
  emptyProgress,
  parseProgressJson,
} from "./card-level-progress.js";
import { isCardEnteredForEval, resolveCardEvalOutcome } from "./card-eval-outcome.js";
import { evaluateLiquidation, resolveLiquidationPlan } from "./card-liquidation-engine.js";
import { resolveTodayPnlMarkContext } from "./today-autotrade-pnl-display.js";
import { hasEvaluatedYield, normalizeExecution } from "./discord-signal-execution.js";
import { resolveCardSignalAt } from "./discord-signal-card-service.js";
import { config } from "./config.js";

export function cardEvalPendingMaxAgeMs() {
  const fromEnv = Number(config.cardEvalPendingMaxAgeMs);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 16 * 3_600_000;
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
export function resolveEvalPendingAnchorMs(card) {
  const prog = parseProgressJson(card.progress);
  const entryMs = prog?.entryHitAt ? Date.parse(String(prog.entryHitAt)) : NaN;
  if (Number.isFinite(entryMs) && entryMs > 0) return entryMs;
  return cardSignalStartMs(card);
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {number} [nowMs]
 */
export function isCardPendingSettleDue(card, nowMs = Date.now()) {
  if (!config.cardEvalPendingSettleEnabled) return false;
  const ex = normalizeExecution(card.execution);
  if (hasEvaluatedYield(ex)) return false;
  if (ex.outcome && ex.outcome !== "pending") return false;
  if (!isCardEnteredForEval(card)) return false;
  if (resolveCardEvalOutcome(card) !== "pending") return false;
  const anchor = resolveEvalPendingAnchorMs(card);
  if (!Number.isFinite(anchor) || anchor <= 0) return false;
  return nowMs >= anchor + cardEvalPendingMaxAgeMs();
}

/**
 * @param {Array<{ ts?: number, close?: number, open?: number }>} klines
 * @param {number} ts
 */
function markPriceAtOrBefore(klines, ts) {
  const sorted = [...klines].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  let last = null;
  for (const k of sorted) {
    const kts = k.ts ?? 0;
    if (kts > ts) break;
    const p = Number(k.close ?? k.open);
    if (Number.isFinite(p) && p > 0) last = p;
  }
  return last;
}

/**
 * @param {ReturnType<typeof evaluateLiquidation>} base
 * @param {Array<{ ts?: number, close?: number, open?: number }>} klines
 * @param {number} windowEndMs
 */
function forceWindowEndSettlement(base, klines, windowEndMs) {
  if (!base?.entered || base.entryPriceUsed == null || !Number.isFinite(Number(base.entryPriceUsed))) {
    return base;
  }
  if (base.outcome === "take_profit" || base.outcome === "stop_loss") return base;
  const price = markPriceAtOrBefore(klines, windowEndMs);
  if (price == null) return base;

  const entry = Number(base.entryPriceUsed);
  const lev = Number(base.leverage) || 20;
  const pnl = calcLeveragePnl(entry, price, Boolean(base.isShort), lev);
  const raw = pnl ? Math.round(pnl.pnlPctOnMargin * 100) / 100 : 0;
  const outcome = raw >= 0 ? "take_profit" : "stop_loss";
  const rounded = alignPnlWithOutcome(outcome, raw);
  const status = outcome === "take_profit" ? "closed_tp" : "closed_sl";
  const settlementAt = new Date(windowEndMs).toISOString();

  const progress = emptyProgress({
    ...(base.progress && typeof base.progress === "object" ? base.progress : {}),
    entryHitAt: base.entryHitAt ?? null,
    entryPriceUsed: entry,
    tpHits: base.tpHits ?? [],
    slHitAt: base.slHitAt ?? null,
    slPrice: base.stopLoss ?? base.slPrice ?? null,
    status,
    lastCheckAt: new Date().toISOString(),
    lastPrice: price,
    pnlPct: rounded,
    outcome,
    leverage: lev,
    note: "eval_pending_window_settle",
    mode: "eval_pending_settle",
    settledAt: settlementAt,
    windowHours: Math.round(cardEvalPendingMaxAgeMs() / 3_600_000),
  });

  return {
    ...base,
    status,
    outcome,
    settlementPrice: price,
    settlementAt,
    pnlPct: rounded,
    pnlLabel: pnl?.pnlLabel ?? `${rounded >= 0 ? "+" : ""}${rounded.toFixed(2)}% (@${lev}x)`,
    note: `超过 ${Math.round(cardEvalPendingMaxAgeMs() / 3_600_000)}h 未触达 TP/SL，按窗口末价结算`,
    progress,
  };
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
export function isCardUnsettledForEval(card) {
  const ex = normalizeExecution(card.execution);
  if (hasEvaluatedYield(ex)) return false;
  const o = String(ex.outcome ?? "").trim();
  if (o === "take_profit" || o === "stop_loss" || o === "cancelled" || o === "manual_close") return false;
  return resolveCardEvalOutcome(card) === "pending";
}

function nearMarketEntryPct(opts = {}) {
  const n = Number(opts.nearMarketEntryPct ?? config.cardEvalNearMarketEntryPct);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {{ force?: boolean, nearMarketEntryPct?: number }} [opts]
 */
export async function settleEvalPendingCard(card, opts = {}) {
  const force = Boolean(opts.force);
  const nearPct = nearMarketEntryPct(opts);

  const plan = resolveLiquidationPlan(card);
  if (plan.skip) {
    return { skipped: true, reason: plan.reason ?? "unsupported_asset" };
  }

  const signalAt = resolveCardSignalAt(card) ?? card.signalAt ?? card.createdAt;
  const signalMs = signalAt ? Date.parse(String(signalAt)) : NaN;
  if (!Number.isFinite(signalMs)) return { error: "invalid_signal_at" };

  const anchorMs = resolveEvalPendingAnchorMs(card);
  const now = Date.now();
  const windowEndMs = force ? now : Math.min(now, anchorMs + cardEvalPendingMaxAgeMs());
  const endMs = force ? now : Math.min(now, windowEndMs + 60_000);

  const sym = String(card.symbol ?? "").trim();
  if (!sym) return { error: "no_symbol" };

  const klines = await fetchKlinesForCard(
    sym,
    plan.assetClass,
    signalMs,
    endMs,
    plan.window?.klineInterval ?? "5m"
  );

  const prog = parseProgressJson(card.progress);
  /** @type {Record<string, unknown>} */
  const evalOpts = {
    signalMs,
    maxEndMs: windowEndMs,
    entryTolerancePct: nearPct,
    ignoreEntryDeadline: force,
  };
  if (
    force &&
    prog?.entryHitAt &&
    prog?.entryPriceUsed != null &&
    Number.isFinite(Number(prog.entryPriceUsed))
  ) {
    evalOpts.forcedEntry = {
      price: Number(prog.entryPriceUsed),
      hitAt: String(prog.entryHitAt),
    };
  }

  let result = evaluateLiquidation(card, klines, evalOpts);
  if (result.error) return { error: result.error };

  if (!result.entered && force && !result.skipped) {
    const ex = normalizeExecution(card.execution);
    const planned = parseEntryPrice(ex.planned?.entryPrice);
    try {
      const tick = await fetchFuturesPrice(sym);
      const price = tick.price;
      let allowForced = false;
      if (planned == null || !Number.isFinite(planned) || planned <= 0) {
        allowForced = true;
      } else {
        const diffPct = (Math.abs(price - planned) / planned) * 100;
        allowForced = diffPct <= nearPct;
      }
      if (allowForced) {
        result = evaluateLiquidation(card, klines, {
          ...evalOpts,
          forcedEntry: { price, hitAt: new Date().toISOString() },
        });
        result.nearMarketEntry = true;
      }
    } catch {
      /* 取价失败则保持未入场 */
    }
  }

  if (result.error) return { error: result.error };

  const shouldForceEnd =
    result.entered &&
    result.outcome === "pending" &&
    (force || now >= anchorMs + cardEvalPendingMaxAgeMs());

  if (shouldForceEnd) {
    result = forceWindowEndSettlement(result, klines, windowEndMs);
  }

  if (result.outcome !== "take_profit" && result.outcome !== "stop_loss") {
    if (force) {
      if (result.entered) {
        result = forceWindowEndSettlement(result, klines, windowEndMs);
      }
      if (result.outcome === "take_profit" || result.outcome === "stop_loss") {
        return { ok: true, result, windowEndMs, forced: force };
      }
      if (result.entered && result.entryPriceUsed != null) {
        try {
          const tick = await fetchFuturesPrice(sym);
          const px = tick.price;
          if (Number.isFinite(px) && px > 0) {
            result = forceWindowEndSettlement(
              result,
              [{ ts: now, close: px, open: px }],
              now
            );
          }
        } catch {
          /* ignore */
        }
      }
      if (result.outcome === "take_profit" || result.outcome === "stop_loss") {
        return { ok: true, result, windowEndMs, forced: force };
      }
      return {
        ok: true,
        notEntered: true,
        reason: result.entered ? "force_close_pending" : "not_entered",
      };
    }
    return {
      skipped: true,
      reason: result.entered ? "still_pending" : "not_entered",
      entered: Boolean(result.entered),
    };
  }

  return { ok: true, result, windowEndMs, forced: force };
}

/**
 * 强制结案：未入场 / 无法结算 → 已取消（不再显示进行中）。
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {string} [reason]
 */
/**
 * 已入场但 K 线/引擎失败时，按现价强制结算。
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
export async function forceCloseEvalCardAtMark(card) {
  const prog = parseProgressJson(card.progress);
  const entry = Number(prog?.entryPriceUsed);
  if (!prog?.entryHitAt || !Number.isFinite(entry) || entry <= 0) return null;
  const sym = String(card.symbol ?? "").trim();
  if (!sym) return null;
  const { isShort, leverage: lev } = resolveTodayPnlMarkContext(card);
  try {
    const tick = await fetchFuturesPrice(sym);
    const px = tick.price;
    if (!Number.isFinite(px) || px <= 0) return null;
    const pnl = calcLeveragePnl(entry, px, isShort, lev);
    const raw = pnl ? Math.round(pnl.pnlPctOnMargin * 100) / 100 : 0;
    const outcome = raw >= 0 ? "take_profit" : "stop_loss";
    const rounded = alignPnlWithOutcome(outcome, raw);
    const status = outcome === "take_profit" ? "closed_tp" : "closed_sl";
    const now = Date.now();
    const progress = emptyProgress({
      ...(prog && typeof prog === "object" ? prog : {}),
      status,
      outcome,
      pnlPct: rounded,
      lastPrice: px,
      lastCheckAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
      note: "eval_force_mark_close",
      mode: "eval_pending_settle",
    });
    return {
      entered: true,
      status,
      outcome,
      settlementPrice: px,
      settlementAt: new Date(now).toISOString(),
      pnlPct: rounded,
      pnlLabel: pnl?.pnlLabel ?? `${rounded >= 0 ? "+" : ""}${rounded.toFixed(2)}% (@${lev}x)`,
      entryPriceUsed: entry,
      entryHitAt: prog.entryHitAt,
      leverage: lev,
      isShort,
      note: "评估强制按现价结算",
      progress,
    };
  } catch {
    return null;
  }
}

export function buildEvalNotEnteredClosePatch(card, reason = "eval_force_not_entered") {
  const ex = normalizeExecution(card.execution);
  const signalAt = resolveCardSignalAt(card) ?? card.signalAt ?? card.createdAt;
  return {
    progressJson: emptyProgress({
      status: "not_entered",
      outcome: "pending",
      pnlPct: 0,
      note: reason,
      mode: "eval_pending_settle",
      lastCheckAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
    }),
    backtestJson: {
      mode: "eval_not_entered",
      entered: false,
      outcome: "cancelled",
      pnlPct: 0,
      signalAt: signalAt ?? null,
      note: reason,
      autoEval: true,
      source: "eval_force_not_entered",
    },
    executionJson: {
      ...ex,
      outcome: "cancelled",
      autoEval: {
        source: "eval_force_not_entered",
        at: new Date().toISOString(),
        note: reason,
      },
    },
  };
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {import("./logger.js").Logger} log
 * @param {{ force?: boolean, nearMarketEntryPct?: number, limit?: number }} [opts]
 */
export async function runEvalPendingSettleSweep(store, log, opts = {}) {
  const force = opts.force !== false;
  const nearPct = nearMarketEntryPct(opts);
  const lim = Math.min(2000, Math.max(1, Number(opts.limit) || 2000));
  if (!store.listCardsForProgressCheck) {
    return { ok: false, error: "store_unavailable" };
  }

  /** @type {Map<number, unknown>} */
  const byId = new Map();
  const progRows = await store.listCardsForProgressCheck({ limit: Math.min(2000, lim) });
  for (const row of progRows) {
    const id = Number(row.id ?? row.card_id);
    if (Number.isFinite(id)) byId.set(id, row);
  }
  if (store.listCardsForEval) {
    const evalRows = await store.listCardsForEval({
      fromMs: 0,
      toMs: Date.now(),
      limit: lim,
    });
    for (const row of evalRows) {
      const id = Number(row.id ?? row.card_id);
      if (!Number.isFinite(id)) continue;
      const card = archiveCardToClient(row);
      if (isCardUnsettledForEval(card)) byId.set(id, row);
    }
  }
  const rows = [...byId.values()];
  let settled = 0;
  let closed = 0;
  let skipped = 0;
  let failed = 0;
  let nearEntry = 0;
  /** @type {Array<Record<string, unknown>>} */
  const items = [];

  for (const row of rows) {
    const card = archiveCardToClient(row);
    if (!isCardUnsettledForEval(card)) continue;
    try {
      if (force && !isCardEnteredForEval(card)) {
        const patch = buildEvalNotEnteredClosePatch(card, "eval_force_not_entered");
        await store.updateSignalCard(card.id, patch);
        closed += 1;
        log.info(`评估结案 #${card.id} ${card.symbol} cancelled (not_entered)`);
        items.push({ id: card.id, symbol: card.symbol, outcome: "cancelled", reason: "not_entered" });
        continue;
      }
      const doc = await settleEvalPendingCard(card, { force, nearMarketEntryPct: nearPct });
      if (doc.ok && doc.notEntered) {
        const patch = buildEvalNotEnteredClosePatch(card, String(doc.reason ?? "not_entered"));
        await store.updateSignalCard(card.id, patch);
        closed += 1;
        log.info(`评估结案 #${card.id} ${card.symbol} cancelled (${doc.reason ?? "not_entered"})`);
        items.push({ id: card.id, symbol: card.symbol, outcome: "cancelled", reason: doc.reason });
        continue;
      }
      if (doc.skipped) {
        if (force) {
          const patch = buildEvalNotEnteredClosePatch(card, String(doc.reason ?? "skipped"));
          await store.updateSignalCard(card.id, patch);
          closed += 1;
          items.push({ id: card.id, symbol: card.symbol, outcome: "cancelled", reason: doc.reason });
          continue;
        }
        skipped += 1;
        items.push({
          id: card.id,
          symbol: card.symbol,
          skipped: doc.reason,
          entered: doc.entered,
        });
        continue;
      }
      if (doc.error || !doc.ok || !doc.result) {
        if (force) {
          const markResult = await forceCloseEvalCardAtMark(card);
          if (markResult) {
            const patch = buildEvalPendingSettlePatch(card, markResult);
            await store.updateSignalCard(card.id, patch);
            settled += 1;
            log.info(
              `评估强制现价 #${card.id} ${card.symbol} outcome=${markResult.outcome} pnl=${markResult.pnlPct ?? "-"}`
            );
            items.push({
              id: card.id,
              symbol: card.symbol,
              outcome: markResult.outcome,
              pnlPct: markResult.pnlPct,
              forceMark: true,
            });
            continue;
          }
          const patch = buildEvalNotEnteredClosePatch(
            card,
            String(doc.error ?? doc.reason ?? "eval_force_failed")
          );
          await store.updateSignalCard(card.id, patch);
          closed += 1;
          items.push({
            id: card.id,
            symbol: card.symbol,
            outcome: "cancelled",
            reason: doc.error ?? "force_failed",
          });
          continue;
        }
        failed += 1;
        items.push({ id: card.id, symbol: card.symbol, error: doc.error ?? "unknown" });
        continue;
      }
      const patch = buildEvalPendingSettlePatch(card, doc.result);
      await store.updateSignalCard(card.id, patch);
      settled += 1;
      if (doc.result.nearMarketEntry) nearEntry += 1;
      log.info(
        `评估结算扫 #${card.id} ${card.symbol} outcome=${doc.result.outcome} pnl=${doc.result.pnlPct ?? "-"}${doc.result.nearMarketEntry ? " near_market_entry" : ""}`
      );
      items.push({
        id: card.id,
        symbol: card.symbol,
        outcome: doc.result.outcome,
        pnlPct: doc.result.pnlPct,
        nearMarketEntry: Boolean(doc.result.nearMarketEntry),
      });
    } catch (e) {
      failed += 1;
      const msg = String(/** @type {Error} */ (e).message ?? e);
      log.warn(`评估结算扫失败 #${card.id}: ${msg}`);
      items.push({ id: card.id, symbol: card.symbol, error: msg });
    }
  }

  return { ok: true, force, nearMarketEntryPct: nearPct, settled, closed, skipped, failed, nearEntry, items };
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {ReturnType<typeof evaluateLiquidation>} result
 */
export function buildEvalPendingSettlePatch(card, result) {
  const ex = normalizeExecution(card.execution);
  const prog =
    result.progress && typeof result.progress === "object"
      ? /** @type {Record<string, unknown>} */ (result.progress)
      : {};

  /** @type {Record<string, unknown>} */
  const patch = {
    progressJson: {
      ...prog,
      mode: "eval_pending_settle",
      lastCheckAt: new Date().toISOString(),
    },
    backtestJson: {
      mode: "eval_pending_settle",
      outcome: result.outcome,
      pnlPct: result.pnlPct ?? 0,
      pnlLabel: result.pnlLabel ?? null,
      settlementPrice: result.settlementPrice ?? null,
      settlementAt: result.settlementAt ?? null,
      entered: Boolean(result.entered),
      entryPriceUsed: result.entryPriceUsed ?? null,
      entryHitAt: result.entryHitAt ?? null,
      note: result.note ?? null,
      autoEval: true,
      source: "eval_pending_settle",
    },
  };

  if (
    (result.outcome === "take_profit" || result.outcome === "stop_loss") &&
    result.entryPriceUsed != null &&
    result.settlementPrice != null
  ) {
    patch.executionJson = {
      ...ex,
      outcome: result.outcome,
      autoEval: {
        source: "eval_pending_settle",
        pnlPct: result.pnlPct,
        settlementPrice: result.settlementPrice,
        at: result.settlementAt ?? result.entryHitAt ?? null,
      },
    };
  }

  return patch;
}
