/**
 * 分层最优回测：窗口内先判止损，否则取最大有利波动 (MFE) 作为最优平仓点。
 */
import { calcLeveragePnl, fetchKlinesForCard, parseEntryPrice, parsePrice } from "./card-price-fetch.js";
import { getCardBacktestPlan } from "./card-backtest-policy.js";

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
      const result = evaluateOptimalInWindow(card.execution, klines, spec.leverage);
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
 * @param {ReturnType<typeof import("./card-archive-service.js").archiveCardToClient>} card
 * @param {number} signalMs
 * @param {number} [nowMs]
 */
export function isBacktestDue(card, signalMs, nowMs = Date.now()) {
  const plan = getCardBacktestPlan(card.symbol, card.assetClass);
  if (plan.skip) return false;
  if (card.backtest && typeof card.backtest === "object") return false;
  return nowMs - signalMs >= plan.spec.minDueMs;
}
