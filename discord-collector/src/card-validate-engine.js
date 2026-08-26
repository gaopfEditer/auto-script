/**
 * 卡片列表验证：贴文发布后最大盈利率 / 最大回撤 / 当前盈亏。
 */
import { getCardBacktestPlan } from "./card-backtest-policy.js";
import {
  calcLeveragePnl,
  fetchFuturesPrice,
  fetchKlinesForCard,
  parseEntryPrice,
} from "./card-price-fetch.js";
import { isShortDirection } from "./card-direction.js";
import { resolveLiquidationLeverage } from "./card-liquidation-engine.js";
import { isCardEnteredForEval, resolveCardEvalOutcome } from "./card-eval-outcome.js";
import { normalizeExecution } from "./discord-signal-execution.js";

/**
 * 未完结（止盈/止损/手动平仓前）的卡片：只返回当前盈亏率。
 * @param {ReturnType<typeof import("./card-archive-service.js").archiveCardToClient>} card
 */
export function isCardValidationInProgress(card) {
  const outcome = resolveCardEvalOutcome(card);
  return outcome === "pending";
}

/**
 * @param {Array<{ high: number, low: number, close: number, ts?: number }>} klines
 * @param {number} entry
 * @param {boolean} isShort
 * @param {number} leverage
 */
export function evaluateValidationMetrics(klines, entry, isShort, leverage) {
  const sorted = [...klines].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  if (!entry || !sorted.length) {
    return {
      error: "insufficient_data",
      maxProfitPct: null,
      maxProfitAt: null,
      maxDrawdownPct: null,
      maxDrawdownAt: null,
      currentPnlPct: null,
      klineCount: sorted.length,
    };
  }

  let maxProfitPct = -Infinity;
  /** @type {string | null} */
  let maxProfitAt = null;
  /** @type {number | null} */
  let maxProfitPrice = null;

  let peakPnl = -Infinity;
  let maxDrawdownPct = 0;
  /** @type {string | null} */
  let maxDrawdownAt = null;

  for (const k of sorted) {
    const bestPrice = isShort ? k.low : k.high;
    const bestPnl = calcLeveragePnl(entry, bestPrice, isShort, leverage);
    if (bestPnl && bestPnl.pnlPctOnMargin > maxProfitPct) {
      maxProfitPct = bestPnl.pnlPctOnMargin;
      maxProfitAt = k.ts ? new Date(k.ts).toISOString() : null;
      maxProfitPrice = bestPrice;
    }

    const trackPrices = [k.close, isShort ? k.high : k.low];
    for (const price of trackPrices) {
      const pnl = calcLeveragePnl(entry, price, isShort, leverage);
      if (!pnl) continue;
      if (pnl.pnlPctOnMargin > peakPnl) peakPnl = pnl.pnlPctOnMargin;
      const dd = peakPnl > -Infinity ? peakPnl - pnl.pnlPctOnMargin : 0;
      if (dd > maxDrawdownPct) {
        maxDrawdownPct = dd;
        maxDrawdownAt = k.ts ? new Date(k.ts).toISOString() : null;
      }
    }
  }

  const last = sorted[sorted.length - 1];
  const currentPnl = calcLeveragePnl(entry, last.close, isShort, leverage);

  return {
    maxProfitPct: Number.isFinite(maxProfitPct) ? Math.round(maxProfitPct * 100) / 100 : null,
    maxProfitAt,
    maxProfitPrice,
    maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
    maxDrawdownAt,
    currentPnlPct: currentPnl?.pnlPctOnMargin ?? null,
    currentPrice: last.close,
    klineCount: sorted.length,
    windowEndAt: last.ts ? new Date(last.ts).toISOString() : null,
  };
}

/**
 * @param {ReturnType<typeof import("./card-archive-service.js").archiveCardToClient>} card
 */
export async function validateCardMetrics(card) {
  const signalRaw = card.signalAt ?? card.createdAt;
  const signalMs = new Date(String(signalRaw ?? "")).getTime();
  const sym = String(card.symbol ?? "").trim().toUpperCase();
  const ex = normalizeExecution(card.execution, card.parsedJson);
  const entry = parseEntryPrice(ex.planned?.entryPrice);
  const isShort = isShortDirection(ex.direction);
  const leverage = resolveLiquidationLeverage(sym, card.assetClass);
  const inProgress = isCardValidationInProgress(card);
  const entered = isCardEnteredForEval(card);

  /** @type {Record<string, unknown>} */
  const base = {
    cardId: card.id,
    uid: card.uid ?? null,
    symbol: sym.replace(/USDT$/, ""),
    channelId: card.channelId ?? "",
    channelName: card.channelName ?? "",
    sourceType: card.sourceType ?? "",
    signalAt: card.signalAt ?? card.createdAt ?? null,
    direction: isShort ? "short" : "long",
    entry,
    leverage,
    inProgress,
    entered,
    outcome: resolveCardEvalOutcome(card),
  };

  if (!sym) return { ...base, error: "missing_symbol" };
  if (!Number.isFinite(signalMs)) return { ...base, error: "invalid_signal_time" };
  if (!entry) return { ...base, error: "missing_entry" };

  const plan = getCardBacktestPlan(sym, card.assetClass);
  if (plan.skip) return { ...base, error: "unsupported_asset", reason: plan.reason };

  if (inProgress) {
    try {
      const { price } = await fetchFuturesPrice(sym);
      const pnl = calcLeveragePnl(entry, price, isShort, leverage);
      return {
        ...base,
        mode: "current",
        currentPrice: price,
        currentPnlPct: pnl?.pnlPctOnMargin ?? null,
        currentPnlLabel: pnl?.pnlLabel ?? null,
      };
    } catch (e) {
      return { ...base, error: String(/** @type {Error} */ (e).message ?? e) };
    }
  }

  try {
    const endMs = Date.now();
    const klines = await fetchKlinesForCard(
      sym,
      "crypto",
      signalMs,
      endMs,
      plan.spec.klineInterval
    );
    const metrics = evaluateValidationMetrics(klines, entry, isShort, leverage);
    return {
      ...base,
      mode: "full",
      signalMs,
      ...metrics,
    };
  } catch (e) {
    return { ...base, error: String(/** @type {Error} */ (e).message ?? e) };
  }
}
