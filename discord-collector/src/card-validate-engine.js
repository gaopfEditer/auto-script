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
import { BACKTEST_WINDOW_DAYS } from "./card-validate-signals.js";
import {
  evaluateTelegramOiRollingWindow,
  getTelegramOiRollingSpec,
} from "./card-telegram-oi-backtest.js";

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

/**
 * @param {Array<{ open?: number, high: number, low: number, close?: number, ts?: number }>} klines
 * @param {number} signalMs
 */
export function marketPriceAtOrAfter(klines, signalMs) {
  const sorted = [...klines].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const bar = sorted.find((k) => (k.ts ?? 0) >= signalMs) ?? sorted[0];
  if (!bar) return null;
  const p = Number(bar.open ?? bar.close ?? bar.high ?? bar.low);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * @param {import("./card-validate-signals.js").BacktestSignalInput} sig
 * @param {Array<{ open?: number, high: number, low: number, close?: number, ts?: number }>} klines
 * @param {number} signalMs
 */
export function resolveBacktestEntry(sig, klines, signalMs) {
  const isShort = sig.direction === "short";
  const marketAtSignal = marketPriceAtOrAfter(klines, signalMs);
  if (marketAtSignal == null) {
    return { error: "no_market_price", marketAtSignal: null, entry: null, entryHitAt: null };
  }

  const entryMode = sig.entryMode === "limit" && sig.entry != null ? "limit" : "market";
  /** @type {number | null} */
  let entry = null;
  /** @type {string | null} */
  let entryHitAt = null;

  if (entryMode === "market" || sig.entry == null) {
    entry = marketAtSignal;
    entryHitAt = new Date(signalMs).toISOString();
  } else {
    const planned = Number(sig.entry);
    const diffPct = (Math.abs(marketAtSignal - planned) / planned) * 100;
    if (diffPct <= 0.5) {
      entry = marketAtSignal;
      entryHitAt = new Date(signalMs).toISOString();
    } else {
      const deadline = signalMs + 12 * 60 * 60 * 1000;
      for (const k of [...klines].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
        const ts = k.ts ?? 0;
        if (ts < signalMs) continue;
        if (ts > deadline) break;
        const high = Number(k.high);
        const low = Number(k.low);
        if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
        const touched = isShort ? high >= planned : low <= planned;
        if (touched) {
          entry = planned;
          entryHitAt = new Date(ts).toISOString();
          break;
        }
      }
    }
  }

  if (entry == null || !entryHitAt) {
    return {
      error: "not_entered",
      marketAtSignal,
      entry: sig.entry,
      entryHitAt: null,
    };
  }

  return { entry, entryHitAt, marketAtSignal, entryMode };
}

/**
 * 真实 K 线回测：信号时刻入场，窗口内最大/最小盈亏与阈值触及。
 * @param {import("./card-validate-signals.js").BacktestSignalInput} sig
 * @param {{ windowDays?: number }} [opts]
 */
export async function backtestSignalReal(sig, opts = {}) {
  const policy = sig.backtestPolicy ?? "window_days";
  const symbol = String(sig.symbol ?? "").trim().toUpperCase();
  const signalMs = Date.parse(String(sig.signalAt ?? ""));
  const isShort = sig.direction === "short";
  const leverage = resolveLiquidationLeverage(symbol, "crypto");

  if (policy === "telegram_oi") {
    return backtestSignalTelegramOi(sig, { leverage, signalMs, symbol, isShort });
  }

  const windowDays = Number(opts.windowDays) > 0 ? Number(opts.windowDays) : BACKTEST_WINDOW_DAYS;
  const profitThresholdPct = Number(sig.profitThresholdPct) || (sig.tier === "major" ? 2 : 5);
  const entryMode = sig.entryMode === "limit" && sig.entry != null ? "limit" : "market";

  /** @type {Record<string, unknown>} */
  const base = {
    signalId: sig.id,
    symbol,
    signalAt: sig.signalAt,
    direction: sig.direction,
    entryMode,
    leverage,
    tier: sig.tier,
    backtestPolicy: policy,
    windowDays,
    profitThresholdPct,
    mock: false,
  };

  if (!symbol) return { ...base, error: "missing_symbol" };
  if (!Number.isFinite(signalMs)) return { ...base, error: "invalid_signal_time" };

  const endMs = Math.min(Date.now(), signalMs + windowDays * 86400_000);
  /** @type {Array<{ open?: number, high: number, low: number, close?: number, ts?: number }>} */
  let klines;
  try {
    klines = await fetchKlinesForCard(symbol, "crypto", signalMs, endMs, "5m");
  } catch (e) {
    return { ...base, error: String(/** @type {Error} */ (e).message ?? e) };
  }

  const entryRes = resolveBacktestEntry(sig, klines, signalMs);
  if (entryRes.error || entryRes.entry == null || !entryRes.entryHitAt) {
    return {
      ...base,
      mode: "backtest_window",
      entered: false,
      entry: sig.entry,
      marketAtSignal: entryRes.marketAtSignal,
      klineCount: klines.length,
      note: entryRes.error === "not_entered" ? "窗口内未入场" : undefined,
      error: entryRes.error ?? "not_entered",
    };
  }

  const { entry, entryHitAt, marketAtSignal } = entryRes;
  const entryMs = Date.parse(entryHitAt);
  const sorted = [...klines]
    .filter((k) => (k.ts ?? 0) >= entryMs - 1)
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  let peak = -Infinity;
  let trough = Infinity;
  let peakAt = /** @type {string | null} */ (null);
  let troughAt = /** @type {string | null} */ (null);
  let peakPrice = /** @type {number | null} */ (null);
  let troughPrice = /** @type {number | null} */ (null);
  let hitProfitThresholdBeforeMax = false;
  let hitProfitThresholdBeforeMin = false;
  let hitTh = false;
  for (const k of sorted) {
    const high = Number(k.high);
    const low = Number(k.low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
    const at = k.ts ? new Date(k.ts).toISOString() : null;
    const bestPrice = isShort ? low : high;
    const worstPrice = isShort ? high : low;
    const best = calcLeveragePnl(entry, bestPrice, isShort, leverage);
    const worst = calcLeveragePnl(entry, worstPrice, isShort, leverage);
    if (best && best.pnlPctOnMargin > peak) {
      peak = best.pnlPctOnMargin;
      peakAt = at;
      peakPrice = bestPrice;
      hitProfitThresholdBeforeMax = hitTh;
    }
    if (worst && worst.pnlPctOnMargin < trough) {
      trough = worst.pnlPctOnMargin;
      troughAt = at;
      troughPrice = worstPrice;
      hitProfitThresholdBeforeMin = hitTh;
    }
    if (best && best.pnlPctOnMargin >= profitThresholdPct) hitTh = true;
    if (worst && worst.pnlPctOnMargin >= profitThresholdPct) hitTh = true;
  }

  const last = sorted[sorted.length - 1];
  const currentPnl =
    last != null
      ? calcLeveragePnl(entry, Number(last.close ?? last.high ?? last.low), isShort, leverage)
      : null;

  return {
    ...base,
    mode: "backtest_window",
    entered: true,
    entry,
    entryHitAt,
    marketAtSignal,
    maxProfitPct: Number.isFinite(peak) ? Math.round(peak * 100) / 100 : null,
    maxProfitAt: peakAt,
    maxProfitPrice: peakPrice,
    minProfitPct: Number.isFinite(trough) ? Math.round(trough * 100) / 100 : null,
    minProfitAt: troughAt,
    minProfitPrice: troughPrice,
    hitProfitThresholdBeforeMax,
    hitProfitThresholdBeforeMin,
    currentPnlPct: currentPnl?.pnlPctOnMargin ?? null,
    klineCount: klines.length,
    windowEndAt: last?.ts ? new Date(last.ts).toISOString() : new Date(endMs).toISOString(),
  };
}

/**
 * OI Telegram 形态推送回测：阶梯触达延时窗口。
 * @param {import("./card-validate-signals.js").BacktestSignalInput} sig
 * @param {{ leverage: number, signalMs: number, symbol: string, isShort: boolean }} ctx
 */
async function backtestSignalTelegramOi(sig, ctx) {
  const { leverage, signalMs, symbol, isShort } = ctx;
  const rolling = getTelegramOiRollingSpec(sig.tier, sig.rollingOverrides ?? {});
  const entryMode = sig.entryMode === "limit" && sig.entry != null ? "limit" : "market";

  /** @type {Record<string, unknown>} */
  const base = {
    signalId: sig.id,
    symbol,
    signalAt: sig.signalAt,
    direction: sig.direction,
    entryMode,
    leverage,
    tier: sig.tier,
    backtestPolicy: "telegram_oi",
    profitThresholdPct: rolling.stepPct,
    source: sig.source,
    interval: sig.interval,
    signalKind: sig.signalKind,
    typeLabel: sig.typeLabel,
    mock: false,
  };

  if (!symbol) return { ...base, error: "missing_symbol" };
  if (!Number.isFinite(signalMs)) return { ...base, error: "invalid_signal_time" };

  const endMs = Math.min(Date.now(), signalMs + rolling.maxWindowMs + 3600_000);
  let klines;
  try {
    klines = await fetchKlinesForCard(symbol, "crypto", signalMs, endMs, "5m");
  } catch (e) {
    return { ...base, error: String(/** @type {Error} */ (e).message ?? e) };
  }

  const entryRes = resolveBacktestEntry(sig, klines, signalMs);
  if (entryRes.error || entryRes.entry == null || !entryRes.entryHitAt) {
    return {
      ...base,
      mode: "telegram_oi_rolling",
      entered: false,
      entry: sig.entry,
      marketAtSignal: entryRes.marketAtSignal,
      rollingSpec: rolling,
      klineCount: klines.length,
      note: entryRes.error === "not_entered" ? "窗口内未入场" : undefined,
      error: entryRes.error ?? "not_entered",
    };
  }

  const { entry, entryHitAt, marketAtSignal } = entryRes;
  const entryMs = Date.parse(entryHitAt);
  const rollingResult = evaluateTelegramOiRollingWindow(
    klines,
    entry,
    isShort,
    leverage,
    rolling,
    entryMs
  );

  return {
    ...base,
    mode: "telegram_oi_rolling",
    entered: true,
    entry,
    entryHitAt,
    marketAtSignal,
    ...rollingResult,
    klineCount: klines.length,
    windowEndAt: rollingResult.windowEndAt,
  };
}
