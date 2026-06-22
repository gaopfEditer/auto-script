/**
 * 接近价位推送策略：
 * - 加密：每 1h 检查，现价距关键位 ≤ 1%
 * - 美股/股票：每 1 天检查，距目标价剩余幅度 ≤ 总落差的 10%（例：100→110，109–110 提醒）
 */
import { config } from "./config.js";
import { distancePct, parsePrice } from "./card-price-fetch.js";
import { getCardVerifyPlan } from "./card-verify-policy.js";

/**
 * @param {'crypto' | 'stock'} assetClass
 */
export function getProximityPolicy(assetClass) {
  if (assetClass === "stock") {
    return {
      assetClass: "stock",
      checkIntervalMs: config.cardProximityStockCheckMs,
      checkLabel: "每天",
      cryptoStyle: false,
      gapFraction: config.cardProximityStockGapPct,
      gapLabel: `${config.cardProximityStockGapPct * 100}% 落差`,
    };
  }
  return {
    assetClass: "crypto",
    checkIntervalMs: config.cardProximityCryptoCheckMs,
    checkLabel: "每 1 小时",
    cryptoStyle: true,
    bandPct: config.cardProximityCryptoBandPct,
    bandLabel: `${config.cardProximityCryptoBandPct}%`,
  };
}

/**
 * @param {Record<string, unknown>} card
 */
export function getCardProximityPolicy(card) {
  const { assetClass } = getCardVerifyPlan(card);
  return getProximityPolicy(assetClass);
}

/**
 * @param {Record<string, unknown> | null | undefined} proximity
 * @param {number} nowMs
 * @param {number} checkIntervalMs
 */
export function shouldCheckCardProximity(proximity, nowMs, checkIntervalMs) {
  const meta = proximity?._meta;
  const last = meta?.lastCheckAt ? new Date(String(meta.lastCheckAt)).getTime() : 0;
  if (!last) return true;
  return nowMs - last >= checkIntervalMs;
}

/**
 * @param {number} price
 * @param {number} level
 * @param {number | null} referencePrice
 * @param {number} gapFraction
 */
export function isStockLevelNear(price, level, referencePrice, gapFraction) {
  const ref = referencePrice ?? level;
  const totalMove = Math.abs(level - ref);
  if (totalMove <= 0) {
    return distancePct(price, level) <= config.cardProximityCryptoBandPct;
  }
  const remaining = Math.abs(price - level);
  return remaining <= totalMove * gapFraction;
}

/**
 * @param {number} price
 * @param {number} level
 * @param {'crypto' | 'stock'} assetClass
 * @param {number | null} referencePrice
 */
export function isLevelNear(price, level, assetClass, referencePrice) {
  if (assetClass === "stock") {
    return isStockLevelNear(price, level, referencePrice, config.cardProximityStockGapPct);
  }
  return distancePct(price, level) <= config.cardProximityCryptoBandPct;
}

/**
 * @param {number} price
 * @param {number} level
 * @param {'crypto' | 'stock'} assetClass
 * @param {number | null} referencePrice
 */
export function proximityDistanceLabel(price, level, assetClass, referencePrice) {
  if (assetClass === "stock") {
    const ref = referencePrice ?? level;
    const totalMove = Math.abs(level - ref);
    const remaining = Math.abs(price - level);
    if (totalMove > 0) {
      const pctOfMove = ((remaining / totalMove) * 100).toFixed(1);
      return `距目标 ${remaining.toFixed(4)}（占落差 ${pctOfMove}%）`;
    }
  }
  return `距离 ${distancePct(price, level).toFixed(2)}%`;
}

/**
 * @param {Record<string, unknown>} card
 */
export function collectProximityLevels(card) {
  const ex = card.execution ?? {};
  const planned = ex.planned ?? {};
  const entry = parsePrice(planned.entryPrice);
  /** @type {Array<{ kind: string, price: number, referencePrice: number | null }>} */
  const levels = [];
  if (entry) levels.push({ kind: "entry", price: entry, referencePrice: entry });
  const sl = parsePrice(planned.stopLossPrice);
  if (sl) levels.push({ kind: "stop_loss", price: sl, referencePrice: entry });
  for (const tp of planned.takeProfitPrices ?? []) {
    const p = parsePrice(tp);
    if (p) levels.push({ kind: "take_profit", price: p, referencePrice: entry });
  }
  return levels;
}

/**
 * @param {string} kind
 */
export function levelKindLabel(kind) {
  switch (kind) {
    case "entry":
      return "入场";
    case "stop_loss":
      return "止损";
    case "take_profit":
      return "止盈";
    default:
      return kind;
  }
}
