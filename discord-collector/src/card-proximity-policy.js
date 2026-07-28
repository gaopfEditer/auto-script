/**
 * 接近价位推送策略：
 * - 加密：默认每 5min 检查，距关键位 ≤ ±5%
 * - 美股/股票：每 1 天检查，距目标价剩余幅度 ≤ 总落差的 10%
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
  const mins = Math.max(1, Math.round(config.cardProximityCryptoCheckMs / 60_000));
  return {
    assetClass: "crypto",
    checkIntervalMs: config.cardProximityCryptoCheckMs,
    checkLabel: `每 ${mins} 分钟`,
    cryptoStyle: true,
    bandPct: config.cardProximityCryptoBandPct,
    bandLabel: `${config.cardProximityCryptoBandPct}%`,
  };
}

/**
 * @param {unknown} entryRaw
 * @returns {number[]}
 */
export function parseEntryPrices(entryRaw) {
  const s = String(entryRaw ?? "").trim().replace(/,/g, "");
  if (!s) return [];
  const rangeMatch = s.match(/([\d.]+)\s*[-–—~～至到]\s*([\d.]+)/);
  if (rangeMatch) {
    const a = parseFloat(rangeMatch[1]);
    const b = parseFloat(rangeMatch[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return a <= b ? [a, b] : [b, a];
    }
  }
  const single = parsePrice(s);
  return single != null ? [single] : [];
}

/**
 * @param {Record<string, unknown>} card
 */
export function getCardCoinWatchMeta(card) {
  const parsed = card.parsedJson ?? card.parsed_json;
  const p = parsed && typeof parsed === "object" ? /** @type {Record<string, unknown>} */ (parsed) : {};
  const watch = p.coinWatch ?? p.coin_watch;
  const w = watch && typeof watch === "object" ? /** @type {Record<string, unknown>} */ (watch) : {};
  const bandRaw = w.bandPct ?? w.band_pct ?? p.proximityBandPct;
  const band = Number(bandRaw);
  const intervalRaw = w.checkIntervalMs ?? w.check_interval_ms;
  const interval = Number(intervalRaw);
  return {
    entryOnly: Boolean(w.entryOnly ?? w.entry_only ?? p.entryWatchOnly),
    bandPct: Number.isFinite(band) && band > 0 ? band : null,
    checkIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : null,
  };
}

/**
 * @param {Record<string, unknown>} card
 * @param {'crypto' | 'stock'} [assetClass]
 */
export function getCardProximityBandPct(card, assetClass = "crypto") {
  const meta = getCardCoinWatchMeta(card);
  if (meta.bandPct != null) return meta.bandPct;
  if (assetClass === "stock") return config.cardProximityCryptoBandPct;
  return config.cardProximityCryptoBandPct;
}

/**
 * @param {Record<string, unknown>} card
 */
export function getCardProximityCheckIntervalMs(card) {
  const meta = getCardCoinWatchMeta(card);
  if (meta.checkIntervalMs != null) return meta.checkIntervalMs;
  const { assetClass } = getCardVerifyPlan(card);
  return getProximityPolicy(assetClass).checkIntervalMs;
}

/**
 * @param {number} price
 * @param {number[]} entryPrices
 * @param {number} bandPct
 */
export function isEntryRangeNear(price, entryPrices, bandPct) {
  if (!Number.isFinite(price) || !entryPrices.length) return false;
  const min = Math.min(...entryPrices);
  const max = Math.max(...entryPrices);
  const bandLow = min * (1 - bandPct / 100);
  const bandHigh = max * (1 + bandPct / 100);
  return price >= bandLow && price <= bandHigh;
}

/**
 * @param {Record<string, unknown>} card
 */
export function getCardProximityPolicy(card) {
  const { assetClass } = getCardVerifyPlan(card);
  const base = getProximityPolicy(assetClass);
  const meta = getCardCoinWatchMeta(card);
  const bandPct = getCardProximityBandPct(card, assetClass);
  const checkIntervalMs = meta.checkIntervalMs ?? base.checkIntervalMs;
  if (assetClass === "stock") {
    return { ...base, checkIntervalMs };
  }
  return {
    ...base,
    checkIntervalMs,
    bandPct,
    bandLabel: `${bandPct}%`,
  };
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
 * @param {{ kind?: string, entryRange?: number[], bandPct?: number }} [levelMeta]
 */
export function isLevelNear(price, level, assetClass, referencePrice, levelMeta = {}) {
  const bandPct =
    levelMeta.bandPct != null && Number.isFinite(levelMeta.bandPct)
      ? levelMeta.bandPct
      : config.cardProximityCryptoBandPct;
  if (levelMeta.kind === "entry_range" && Array.isArray(levelMeta.entryRange) && levelMeta.entryRange.length >= 2) {
    return isEntryRangeNear(price, levelMeta.entryRange, bandPct);
  }
  if (assetClass === "stock") {
    return isStockLevelNear(price, level, referencePrice, config.cardProximityStockGapPct);
  }
  return distancePct(price, level) <= bandPct;
}

/**
 * @param {number} price
 * @param {number} level
 * @param {'crypto' | 'stock'} assetClass
 * @param {number | null} referencePrice
 * @param {{ kind?: string, entryRange?: number[], bandPct?: number }} [levelMeta]
 */
export function proximityDistanceLabel(price, level, assetClass, referencePrice, levelMeta = {}) {
  const bandPct =
    levelMeta.bandPct != null && Number.isFinite(levelMeta.bandPct)
      ? levelMeta.bandPct
      : config.cardProximityCryptoBandPct;
  if (levelMeta.kind === "entry_range" && Array.isArray(levelMeta.entryRange) && levelMeta.entryRange.length >= 2) {
    const [min, max] = levelMeta.entryRange;
    const bandLow = min * (1 - bandPct / 100);
    const bandHigh = max * (1 + bandPct / 100);
    if (price >= bandLow && price <= bandHigh) {
      return `位于入场区间 ±${bandPct}% 带内（${min}–${max}）`;
    }
    const toLow = Math.abs(price - min);
    const toHigh = Math.abs(price - max);
    const nearest = Math.min(toLow, toHigh);
    const ref = price !== 0 ? (nearest / Math.abs(price)) * 100 : 0;
    return `距入场带 ${nearest.toFixed(4)}（约 ${ref.toFixed(2)}%）`;
  }
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
  const watchMeta = getCardCoinWatchMeta(card);
  const bandPct = getCardProximityBandPct(card);
  const entryPrices = parseEntryPrices(planned.entryPrice);
  /** @type {Array<{ kind: string, price: number, referencePrice: number | null, entryRange?: number[], bandPct?: number }>} */
  const levels = [];
  if (entryPrices.length === 1) {
    levels.push({
      kind: "entry",
      price: entryPrices[0],
      referencePrice: entryPrices[0],
      bandPct,
    });
  } else if (entryPrices.length >= 2) {
    const min = Math.min(...entryPrices);
    const max = Math.max(...entryPrices);
    levels.push({
      kind: "entry_range",
      price: (min + max) / 2,
      referencePrice: min,
      entryRange: [min, max],
      bandPct,
    });
  }
  if (watchMeta.entryOnly) return levels;

  const entry = entryPrices[0] ?? null;
  const sl = parsePrice(planned.stopLossPrice);
  if (sl) levels.push({ kind: "stop_loss", price: sl, referencePrice: entry, bandPct });
  for (const tp of planned.takeProfitPrices ?? []) {
    const p = parsePrice(tp);
    if (p) levels.push({ kind: "take_profit", price: p, referencePrice: entry, bandPct });
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
    case "entry_range":
      return "入场区间";
    case "stop_loss":
      return "止损";
    case "take_profit":
      return "止盈";
    default:
      return kind;
  }
}
