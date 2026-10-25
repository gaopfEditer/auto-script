/**
 * 最高浮盈 M（现货 %）≥7% 后，止损下限 L(M)（锁定利润，现货 %）。
 * M<7：仍用原始 -5% 止损。
 */
import { calcLeveragePnl } from "./card-price-fetch.js";
import { emptyProgress } from "./card-level-progress.js";

/** @param {number} mSpotPct 最高浮盈 M（现货涨跌幅 %，≥0） */
export function profitProtectionFloorSpotPct(mSpotPct) {
  const m = Number(mSpotPct);
  if (!Number.isFinite(m) || m < 7) return null;
  if (m < 10) return 1 + (m - 7);
  if (m < 15) return 4 + (4 / 5) * (m - 10);
  if (m < 20) return 8 + (4 / 5) * (m - 15);
  return 12 + (4 / 5) * (m - 20);
}

/**
 * @param {number} entry
 * @param {boolean} isShort
 * @param {number} slSpotPct 止损线相对入场的现货 %（多：+为锁利；-为亏损）
 */
export function slPriceFromSpotPct(entry, isShort, slSpotPct) {
  const e = Number(entry);
  const p = Number(slSpotPct);
  if (!Number.isFinite(e) || e <= 0 || !Number.isFinite(p)) return null;
  if (isShort) return e * (1 - p / 100);
  return e * (1 + p / 100);
}

/**
 * @param {number} entry
 * @param {boolean} isShort
 * @param {number} high
 * @param {number} low
 */
export function maxSpotExcursionPct(entry, isShort, high, low) {
  const e = Number(entry);
  if (!Number.isFinite(e) || e <= 0) return 0;
  if (isShort) {
    const m = ((e - low) / e) * 100;
    return Number.isFinite(m) && m > 0 ? m : 0;
  }
  const m = ((high - e) / e) * 100;
  return Number.isFinite(m) && m > 0 ? m : 0;
}

/** M7 利润保护：仅 trailing 止损退出（无 7/10/20 分批止盈） */
export const M7_INITIAL_STOP_SPOT_PCT = -5;

/**
 * @param {boolean} isShort
 * @param {number} high
 * @param {number} low
 * @param {number} slPrice
 */
function touchesStopPrice(isShort, high, low, slPrice) {
  if (!Number.isFinite(slPrice)) return false;
  if (isShort) return high >= slPrice;
  return low <= slPrice;
}

/**
 * @param {{
 *   sorted: Array<{ ts?: number; high: number; low: number; close?: number; open?: number }>;
 *   entryHitAt: string;
 *   entryPriceUsed: number;
 *   isShort: boolean;
 *   leverage: number;
 *   marketAtSignal: number;
 *   plannedEntry: number | null;
 *   maxEndMs: number;
 *   nowIso: string;
 * }} ctx
 */
export function runM7ProfitProtectionLiquidation(ctx) {
  const {
    sorted,
    entryHitAt,
    entryPriceUsed,
    isShort,
    leverage,
    marketAtSignal,
    plannedEntry,
    maxEndMs,
    nowIso,
  } = ctx;
  const entryMs = Date.parse(entryHitAt);
  let maxM = 0;
  let slSpot = M7_INITIAL_STOP_SPOT_PCT;
  /** @type {string | null} */
  let slHitAt = null;
  /** @type {number | null} */
  let settlementPrice = null;
  /** @type {string} */
  let settlementAt = "";
  /** @type {string} */
  let outcome = "pending";

  for (const k of sorted) {
    const ts = k.ts ?? 0;
    if (ts < entryMs - 1) continue;
    if (Number.isFinite(maxEndMs) && ts > maxEndMs) break;
    const high = Number(k.high);
    const low = Number(k.low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    const barM = maxSpotExcursionPct(entryPriceUsed, isShort, high, low);
    if (barM > maxM) maxM = barM;

    if (maxM < 7) {
      slSpot = M7_INITIAL_STOP_SPOT_PCT;
    } else {
      const floor = profitProtectionFloorSpotPct(maxM);
      if (floor != null) slSpot = floor;
    }

    const slPrice = slPriceFromSpotPct(entryPriceUsed, isShort, slSpot);
    if (slPrice == null) continue;
    if (!touchesStopPrice(isShort, high, low, slPrice)) continue;

    slHitAt = k.ts ? new Date(k.ts).toISOString() : nowIso;
    settlementPrice = slPrice;
    settlementAt = slHitAt;
    outcome = slSpot >= 0 ? "take_profit" : "stop_loss";
    break;
  }

  let roundedPnl = 0;
  let pnlLabel = "0%";
  if (settlementPrice != null) {
    const strictPnl = calcLeveragePnl(entryPriceUsed, settlementPrice, isShort, leverage);
    if (strictPnl) {
      roundedPnl = Math.round(strictPnl.pnlPctOnMargin * 100) / 100;
      pnlLabel = `${roundedPnl >= 0 ? "+" : ""}${roundedPnl.toFixed(2)}% (@${leverage}x)`;
    }
  }

  /** @type {import("./card-level-progress.js").ProgressStatus} */
  let status = "entered";
  if (slHitAt) status = outcome === "take_profit" ? "closed_tp" : "closed_sl";

  const note =
    outcome === "pending"
      ? "M7利润保护：窗口内未触达止损线"
      : `M7利润保护：峰值浮盈≈${maxM.toFixed(2)}% · 止损线${slSpot >= 0 ? "+" : ""}${slSpot.toFixed(2)}%`;

  const progress = emptyProgress({
    entryHitAt,
    entryPriceUsed,
    tpHits: [],
    slHitAt,
    slPrice: settlementPrice,
    status,
    lastCheckAt: nowIso,
    lastPrice: settlementPrice ?? marketAtSignal,
    pnlPct: roundedPnl,
    outcome: outcome === "pending" ? "pending" : outcome,
    leverage,
    note,
    mode: "liquidation",
  });

  return {
    mode: "liquidation",
    entered: true,
    status,
    outcome,
    isShort,
    leverage,
    marketAtSignal,
    plannedEntry: plannedEntry ?? null,
    entryPriceUsed,
    entryHitAt,
    takeProfits: [],
    stopLoss: slPriceFromSpotPct(entryPriceUsed, isShort, slSpot),
    tpHits: [],
    slHitAt,
    settlementPrice,
    settlementAt,
    pnlPct: roundedPnl,
    pnlLabel,
    profitProtectionM7: true,
    maxSpotExcursionPct: maxM,
    protectionStopSpotPct: slSpot,
    note,
    progress,
  };
}
