/**
 * 分层最优回测 + TP1/TP2/TP3 最佳出场结算。
 */
import { calcLeveragePnl, fetchKlinesForCard, parseEntryPrice, parsePrice } from "./card-price-fetch.js";
import { getCardBacktestPlan } from "./card-backtest-policy.js";
import { hasEvaluatedYield, normalizeExecution } from "./discord-signal-execution.js";

/**
 * 在 TP1/TP2/TP3 中选「触及的最高档」作为最佳出场；若先触 SL 则止损结算。
 * @param {{
 *   direction?: string,
 *   planned?: { entryPrice?: string, takeProfitPrices?: string[], stopLossPrice?: string },
 * }} execution
 * @param {Array<{ high: number, low: number, ts?: number }>} klines
 * @param {number} leverage
 */
export function evaluateBestTpSettlement(execution, klines, leverage) {
  const ex = normalizeExecution(execution);
  const dir = String(ex.direction ?? execution?.direction ?? "");
  const isShort = /空|short|sell/i.test(dir);
  const entry = parseEntryPrice(ex.planned?.entryPrice ?? execution?.planned?.entryPrice);
  const sl = parsePrice(ex.planned?.stopLossPrice ?? execution?.planned?.stopLossPrice);
  /** @type {number[]} */
  const tps = [];
  for (const raw of ex.planned?.takeProfitPrices ?? execution?.planned?.takeProfitPrices ?? []) {
    const p = parsePrice(raw);
    if (p != null && p > 0) tps.push(p);
  }
  const levels = isShort ? [...tps].sort((a, b) => b - a) : [...tps].sort((a, b) => a - b);
  const sorted = [...klines].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  if (!entry) {
    return { error: "missing_entry", outcome: "pending", entry: null, pnl: null };
  }
  if (!sorted.length) {
    return { error: "no_klines", outcome: "pending", entry, pnl: null };
  }

  /** @type {number} */
  let bestTpIdx = -1;
  /** @type {number | null} */
  let bestTpPrice = null;
  /** @type {string} */
  let bestAt = "";
  /** @type {number} */
  let bestTs = 0;

  for (const k of sorted) {
    if (sl != null) {
      const slHit = isShort ? k.high >= sl : k.low <= sl;
      if (slHit && bestTpIdx < 0) {
        const pnl = calcLeveragePnl(entry, sl, isShort, leverage);
        return {
          outcome: "stop_loss",
          bestTp: "SL",
          bestTpIndex: 0,
          settlementPrice: sl,
          optimalExitPrice: sl,
          optimalAt: k.ts ? new Date(k.ts).toISOString() : "",
          entry,
          direction: isShort ? "short" : "long",
          stopLoss: sl,
          takeProfits: levels,
          pnl,
          pnlLabel: pnl?.pnlLabel ?? null,
          klineCount: sorted.length,
          autoEval: true,
        };
      }
      if (slHit) break;
    }

    for (let i = 0; i < levels.length; i++) {
      const tp = levels[i];
      const hit = isShort ? k.low <= tp : k.high >= tp;
      if (hit && i >= bestTpIdx) {
        bestTpIdx = i;
        bestTpPrice = tp;
        bestAt = k.ts ? new Date(k.ts).toISOString() : "";
        bestTs = k.ts ?? 0;
      }
    }
  }

  if (bestTpIdx >= 0 && bestTpPrice != null) {
    const pnl = calcLeveragePnl(entry, bestTpPrice, isShort, leverage);
    const label = `TP${bestTpIdx + 1}`;
    return {
      outcome: "take_profit",
      bestTp: label,
      bestTpIndex: bestTpIdx + 1,
      settlementPrice: bestTpPrice,
      optimalExitPrice: bestTpPrice,
      optimalAt: bestAt,
      optimalTs: bestTs,
      entry,
      direction: isShort ? "short" : "long",
      stopLoss: sl,
      takeProfits: levels,
      pnl,
      pnlLabel: pnl?.pnlLabel ?? null,
      klineCount: sorted.length,
      autoEval: true,
    };
  }

  // 未触 TP/SL：仍给 MFE 参考，但不改 outcome 为终态
  const mfe = evaluateOptimalInWindow(execution, klines, leverage);
  return {
    ...mfe,
    outcome: mfe.outcome === "stop_loss" ? "stop_loss" : "pending",
    bestTp: mfe.outcome === "stop_loss" ? "SL" : null,
    settlementPrice: mfe.outcome === "stop_loss" ? mfe.optimalExitPrice : null,
    takeProfits: levels,
    autoEval: true,
    note: "窗口内未触及 TP，保持 pending",
  };
}

/**
 * @param {{
 *   direction?: string,
 *   planned?: { entryPrice?: string, takeProfitPrices?: string[], stopLossPrice?: string },
 * }} execution
 * @param {Array<{ high: number, low: number, ts?: number }>} klines
 * @param {number} leverage
 */
export function evaluateOptimalInWindow(execution, klines, leverage) {
  const dir = String(execution?.direction ?? "");
  const isShort = /空|short|sell/i.test(dir);
  const entry = parseEntryPrice(execution?.planned?.entryPrice);
  const sl = parsePrice(execution?.planned?.stopLossPrice);
  const sorted = [...klines].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  if (!entry) {
    return { error: "missing_entry", outcome: "pending", entry: null, pnl: null };
  }
  if (!sorted.length) {
    return { error: "no_klines", outcome: "pending", entry, pnl: null };
  }

  /** @type {{ price: number, at: string, ts: number } | null} */
  let stopHit = null;
  for (const k of sorted) {
    if (isShort && sl != null && k.high >= sl) {
      stopHit = { price: sl, at: k.ts ? new Date(k.ts).toISOString() : "", ts: k.ts ?? 0 };
      break;
    }
    if (!isShort && sl != null && k.low <= sl) {
      stopHit = { price: sl, at: k.ts ? new Date(k.ts).toISOString() : "", ts: k.ts ?? 0 };
      break;
    }
  }

  if (stopHit) {
    const pnl = calcLeveragePnl(entry, stopHit.price, isShort, leverage);
    return {
      outcome: "stop_loss",
      optimalExitPrice: stopHit.price,
      optimalAt: stopHit.at,
      entry,
      direction: isShort ? "short" : "long",
      stopLoss: sl,
      pnl,
      pnlLabel: pnl?.pnlLabel ?? null,
      klineCount: sorted.length,
    };
  }

  let bestPnl = -Infinity;
  /** @type {{ price: number, at: string, ts: number } | null} */
  let bestExit = null;

  for (const k of sorted) {
    const exitPrice = isShort ? k.low : k.high;
    const pnl = calcLeveragePnl(entry, exitPrice, isShort, leverage);
    if (!pnl) continue;
    if (pnl.pnlPctOnMargin > bestPnl) {
      bestPnl = pnl.pnlPctOnMargin;
      bestExit = {
        price: exitPrice,
        at: k.ts ? new Date(k.ts).toISOString() : "",
        ts: k.ts ?? 0,
      };
    }
  }

  if (!bestExit) {
    return { error: "no_optimal_exit", outcome: "pending", entry, pnl: null, klineCount: sorted.length };
  }

  const pnl = calcLeveragePnl(entry, bestExit.price, isShort, leverage);
  return {
    outcome: "optimal_exit",
    optimalExitPrice: bestExit.price,
    optimalAt: bestExit.at,
    entry,
    direction: isShort ? "short" : "long",
    stopLoss: sl,
    pnl,
    pnlLabel: pnl?.pnlLabel ?? null,
    klineCount: sorted.length,
  };
}

/**
 * @param {ReturnType<typeof import("./card-archive-service.js").archiveCardToClient>} card
 * @param {number} signalMs
 */
export async function runCardTpSettlement(card, signalMs) {
  const sym = String(card.symbol ?? "").trim();
  const plan = getCardBacktestPlan(sym, card.assetClass);
  if (plan.skip) {
    return { skipped: true, reason: plan.reason };
  }
  const { tier, spec } = plan;
  const durationMs = spec.windowDurationsMs[spec.windowDurationsMs.length - 1] ?? 3 * 3600_000;
  const end = Math.min(Date.now(), signalMs + durationMs);
  const klines = await fetchKlinesForCard(sym, "crypto", signalMs, end, spec.klineInterval);
  const result = evaluateBestTpSettlement(card.execution, klines, spec.leverage);
  return {
    tier,
    leverage: spec.leverage,
    symbol: sym,
    signalAt: new Date(signalMs).toISOString(),
    windowMs: durationMs,
    ...result,
    backtestedAt: new Date().toISOString(),
    mode: "tp_settlement",
  };
}

/**
 * @param {ReturnType<typeof import("./card-archive-service.js").archiveCardToClient>} card
 * @param {number} signalMs
 */
export async function runCardBacktest(card, signalMs) {
  const sym = String(card.symbol ?? "").trim();
  const plan = getCardBacktestPlan(sym, card.assetClass);
  if (plan.skip) {
    return { skipped: true, reason: plan.reason };
  }

  const { tier, spec } = plan;
  /** @type {Array<Record<string, unknown>>} */
  const windows = [];

  for (let i = 0; i < spec.windowDurationsMs.length; i++) {
    const durationMs = spec.windowDurationsMs[i];
    const label = spec.windowLabels[i];
    const end = signalMs + durationMs;
    try {
      const klines = await fetchKlinesForCard(sym, "crypto", signalMs, end, spec.klineInterval);
      const result = evaluateBestTpSettlement(card.execution, klines, spec.leverage);
      windows.push({
        window: label,
        durationMs,
        ...result,
        pnlPctOnMargin: result.pnl?.pnlPctOnMargin ?? null,
      });
    } catch (e) {
      windows.push({
        window: label,
        durationMs,
        error: String(/** @type {Error} */ (e).message ?? e),
      });
    }
  }

  const valid = windows.filter((w) => w.pnl && typeof w.pnlPctOnMargin === "number");
  if (!valid.length) {
    return {
      tier,
      leverage: spec.leverage,
      symbol: sym,
      signalAt: new Date(signalMs).toISOString(),
      error: "all_windows_failed",
      windows,
      backtestedAt: new Date().toISOString(),
    };
  }

  const best = valid.reduce((a, b) =>
    /** @type {number} */ (b.pnlPctOnMargin) > /** @type {number} */ (a.pnlPctOnMargin) ? b : a
  );

  return {
    tier,
    leverage: spec.leverage,
    tierLabel: spec.label,
    symbol: sym,
    signalAt: new Date(signalMs).toISOString(),
    bestWindow: best.window,
    bestWindowMs: best.durationMs,
    outcome: best.outcome,
    optimalExitPrice: best.optimalExitPrice,
    optimalAt: best.optimalAt,
    entry: best.entry,
    pnl: best.pnl,
    pnlLabel: best.pnlLabel,
    pnlPctOnMargin: best.pnlPctOnMargin,
    windows,
    backtestedAt: new Date().toISOString(),
  };
}

/**
 * @param {string} reason
 */
export function buildSkippedBacktestJson(reason) {
  return {
    skipped: true,
    reason,
    skippedAt: new Date().toISOString(),
  };
}

/**
 * @param {ReturnType<typeof import("./card-archive-service.js").archiveCardToClient>} card
 */
export function shouldSkipCardBacktest(card) {
  if (hasEvaluatedYield(card.execution)) {
    return { skip: true, reason: "user_evaluated" };
  }
  return { skip: false };
}

/**
 * @param {ReturnType<typeof import("./card-archive-service.js").archiveCardToClient>} card
 * @param {number} signalMs
 * @param {number} [nowMs]
 */
export function isBacktestDue(card, signalMs, nowMs = Date.now()) {
  const plan = getCardBacktestPlan(card.symbol, card.assetClass);
  if (plan.skip) return false;
  if (shouldSkipCardBacktest(card).skip) return false;
  if (card.backtest && typeof card.backtest === "object") return false;
  return nowMs - signalMs >= plan.spec.minDueMs;
}
