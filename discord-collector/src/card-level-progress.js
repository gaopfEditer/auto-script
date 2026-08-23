/**
 * 卡片档位进度状态机：入场 → 分批 TP（各 1/N）→ SL。
 * 价格源：Binance 永续 K 线 / 现价（由调用方注入）。
 */
import { getCardBacktestPlan } from "./card-backtest-policy.js";
import { calcLeveragePnl, parseEntryPrice, parsePrice } from "./card-price-fetch.js";
import { normalizeExecution } from "./discord-signal-execution.js";
import { resolveCardSignalAt } from "./discord-signal-card-service.js";
import { config } from "./config.js";

/** @typedef {'watching'|'entered'|'partial_tp'|'closed_tp'|'closed_sl'|'expired'} ProgressStatus */
/** @typedef {'pending'|'take_profit'|'stop_loss'} ProgressOutcome */

/**
 * @returns {{
 *   entryHitAt: string|null,
 *   entryPriceUsed: number|null,
 *   tpHits: Array<{ index: number, price: number, hitAt: string, sizePct: number }>,
 *   slHitAt: string|null,
 *   slPrice: number|null,
 *   status: ProgressStatus,
 *   lastCheckAt: string,
 *   lastPrice: number|null,
 *   pnlPct: number,
 *   outcome: ProgressOutcome,
 *   sizePct: number,
 *   leverage: number,
 *   note?: string,
 * }}
 */
export function emptyProgress(extra = {}) {
  return {
    entryHitAt: null,
    entryPriceUsed: null,
    tpHits: [],
    slHitAt: null,
    slPrice: null,
    status: "watching",
    lastCheckAt: new Date().toISOString(),
    lastPrice: null,
    pnlPct: 0,
    outcome: "pending",
    sizePct: 0,
    leverage: Number(config.cardVerifyLeverage) || 100,
    ...extra,
  };
}

/** @param {unknown} raw */
export function parseProgressJson(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return /** @type {Record<string, unknown>} */ (raw);
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} card archiveCardToClient 或 store row
 */
export function resolveCardExecution(card) {
  const ex = card.execution ?? card.execution_json ?? card.executionJson;
  return normalizeExecution(ex);
}

/**
 * @param {Record<string, unknown>} card
 */
export function resolveProgressLeverage(card) {
  const plan = getCardBacktestPlan(card.symbol, card.assetClass ?? card.asset_class);
  if (!plan.skip && plan.spec?.leverage) return Number(plan.spec.leverage);
  return Number(config.cardVerifyLeverage) || 100;
}

/**
 * @param {ProgressStatus} a
 * @param {ProgressStatus} b
 */
function statusRank(s) {
  switch (s) {
    case "watching":
      return 0;
    case "entered":
      return 1;
    case "partial_tp":
      return 2;
    case "closed_tp":
    case "closed_sl":
    case "expired":
      return 3;
    default:
      return 0;
  }
}

/**
 * 只前进不回退。
 * @param {ReturnType<typeof emptyProgress>|null|undefined} prev
 * @param {ReturnType<typeof emptyProgress>} next
 */
export function mergeProgress(prev, next) {
  if (!prev || typeof prev !== "object") return next;
  const p = /** @type {ReturnType<typeof emptyProgress>} */ ({ ...emptyProgress(), ...prev });
  const n = next;

  /** @type {Map<number, { index: number, price: number, hitAt: string, sizePct: number }>} */
  const tpMap = new Map();
  for (const h of p.tpHits ?? []) {
    if (h && Number.isFinite(Number(h.index))) tpMap.set(Number(h.index), h);
  }
  for (const h of n.tpHits ?? []) {
    if (h && Number.isFinite(Number(h.index)) && !tpMap.has(Number(h.index))) {
      tpMap.set(Number(h.index), h);
    }
  }
  const tpHits = [...tpMap.values()].sort((a, b) => a.index - b.index);

  const entryHitAt = p.entryHitAt || n.entryHitAt || null;
  const entryPriceUsed =
    p.entryPriceUsed != null && Number.isFinite(Number(p.entryPriceUsed))
      ? Number(p.entryPriceUsed)
      : n.entryPriceUsed;
  const slHitAt = p.slHitAt || n.slHitAt || null;
  const slPrice = p.slPrice ?? n.slPrice ?? null;

  let status = n.status;
  if (statusRank(p.status) > statusRank(n.status)) status = p.status;
  if (slHitAt) status = "closed_sl";
  else if (tpHits.length && n.status === "closed_tp") status = "closed_tp";
  else if (tpHits.length && status !== "closed_tp" && status !== "closed_sl") status = "partial_tp";
  else if (entryHitAt && statusRank(status) < 1) status = "entered";

  let outcome = /** @type {ProgressOutcome} */ ("pending");
  if (tpHits.length > 0) outcome = "take_profit";
  else if (slHitAt) outcome = "stop_loss";

  const pnlPct = Math.max(Number(p.pnlPct) || 0, Number(n.pnlPct) || 0);
  // 若 next 完整重算且含更多命中，以 next 的 pnl 为准（通常更大或更完整）
  const useNextPnl =
    (n.tpHits?.length ?? 0) >= (p.tpHits?.length ?? 0) &&
    (Boolean(n.slHitAt) || !p.slHitAt) &&
    Number.isFinite(Number(n.pnlPct));

  return {
    ...n,
    entryHitAt,
    entryPriceUsed,
    tpHits,
    slHitAt,
    slPrice,
    status,
    lastCheckAt: n.lastCheckAt || p.lastCheckAt,
    lastPrice: n.lastPrice ?? p.lastPrice ?? null,
    pnlPct: useNextPnl ? Number(n.pnlPct) : pnlPct,
    outcome,
    sizePct: n.sizePct || p.sizePct || 0,
    leverage: n.leverage || p.leverage,
  };
}

/**
 * @param {boolean} isShort
 * @param {number} high
 * @param {number} low
 * @param {number} level
 */
function touchesLevel(isShort, high, low, level, kind) {
  if (!Number.isFinite(level)) return false;
  if (kind === "entry") {
    // 做多：价格触及入场（low<=entry）；做空：high>=entry
    return isShort ? high >= level : low <= level;
  }
  if (kind === "sl") {
    return isShort ? high >= level : low <= level;
  }
  // tp
  return isShort ? low <= level : high >= level;
}

/**
 * @param {Record<string, unknown>} card
 * @param {{ price?: number|null, klines?: Array<{ high: number, low: number, close?: number, ts?: number }> }} opts
 */
export function evaluateCardProgress(card, opts = {}) {
  const nowIso = new Date().toISOString();
  const execution = resolveCardExecution(card);
  const isShort = /空|short|sell/i.test(String(execution.direction ?? ""));
  const entry = parseEntryPrice(execution.planned?.entryPrice);
  const sl = parsePrice(execution.planned?.stopLossPrice);
  const tps = (execution.planned?.takeProfitPrices ?? [])
    .map((p) => parsePrice(p))
    .filter((x) => x != null);
  const n = Math.max(tps.length, 1);
  const sizePct = 1 / n;
  const leverage = resolveProgressLeverage(card);
  const lastPrice =
    opts.price != null && Number.isFinite(Number(opts.price)) ? Number(opts.price) : null;

  const base = emptyProgress({
    lastCheckAt: nowIso,
    lastPrice,
    sizePct,
    leverage,
    slPrice: sl,
    entryPriceUsed: entry,
  });

  if (entry == null) {
    return { ...base, note: "no_entry", status: "watching" };
  }

  /** @type {Array<{ high: number, low: number, close?: number, ts?: number }>} */
  const klines = Array.isArray(opts.klines) ? [...opts.klines] : [];
  klines.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  if (lastPrice != null) {
    klines.push({
      high: lastPrice,
      low: lastPrice,
      close: lastPrice,
      ts: Date.now(),
    });
  }

  if (!klines.length) {
    return { ...base, note: "no_klines" };
  }

  let entryHitAt = null;
  let entryPriceUsed = entry;
  /** @type {Array<{ index: number, price: number, hitAt: string, sizePct: number }>} */
  const tpHits = [];
  /** @type {Set<number>} */
  const hitIdx = new Set();
  let slHitAt = null;
  let pnlPct = 0;

  for (const k of klines) {
    const hitAt = k.ts ? new Date(k.ts).toISOString() : nowIso;
    const high = Number(k.high);
    const low = Number(k.low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    if (!entryHitAt) {
      if (touchesLevel(isShort, high, low, entry, "entry")) {
        entryHitAt = hitAt;
        entryPriceUsed = entry;
      } else {
        continue;
      }
    }

    // 已入场：同根 K 线不利优先（先 SL 再 TP）
    const remaining = 1 - hitIdx.size * sizePct;
    if (remaining > 1e-9 && sl != null && touchesLevel(isShort, high, low, sl, "sl")) {
      const pnl = calcLeveragePnl(entryPriceUsed, sl, isShort, leverage);
      if (pnl) pnlPct += remaining * pnl.pnlPctOnMargin;
      slHitAt = hitAt;
      break;
    }

    for (let i = 0; i < tps.length; i++) {
      if (hitIdx.has(i)) continue;
      const tp = tps[i];
      if (!touchesLevel(isShort, high, low, tp, "tp")) continue;
      const pnl = calcLeveragePnl(entryPriceUsed, tp, isShort, leverage);
      if (pnl) pnlPct += sizePct * pnl.pnlPctOnMargin;
      hitIdx.add(i);
      tpHits.push({ index: i, price: tp, hitAt, sizePct });
    }

    if (hitIdx.size >= tps.length && tps.length > 0) break;
  }

  /** @type {ProgressStatus} */
  let status = "watching";
  if (slHitAt) status = "closed_sl";
  else if (tps.length > 0 && hitIdx.size >= tps.length) status = "closed_tp";
  else if (hitIdx.size > 0) status = "partial_tp";
  else if (entryHitAt) status = "entered";

  /** @type {ProgressOutcome} */
  let outcome = "pending";
  if (tpHits.length > 0) outcome = "take_profit";
  else if (slHitAt) outcome = "stop_loss";

  return {
    ...base,
    entryHitAt,
    entryPriceUsed,
    tpHits,
    slHitAt,
    slPrice: sl,
    status,
    lastCheckAt: nowIso,
    lastPrice,
    pnlPct: Math.round(pnlPct * 100) / 100,
    outcome,
    sizePct,
    leverage,
  };
}

/**
 * 进度是否相对上次有实质变化（需写库）。
 * @param {ReturnType<typeof emptyProgress>|null} prev
 * @param {ReturnType<typeof emptyProgress>} next
 */
export function progressChanged(prev, next) {
  if (!prev) return true;
  if (prev.status !== next.status) return true;
  if (prev.outcome !== next.outcome) return true;
  if ((prev.tpHits?.length ?? 0) !== (next.tpHits?.length ?? 0)) return true;
  if (Boolean(prev.entryHitAt) !== Boolean(next.entryHitAt)) return true;
  if (Boolean(prev.slHitAt) !== Boolean(next.slHitAt)) return true;
  if (Math.abs((Number(prev.pnlPct) || 0) - (Number(next.pnlPct) || 0)) > 0.001) return true;
  return false;
}

/**
 * @param {Record<string, unknown>} card
 * @param {number} [nowMs]
 */
export function isCardVerifyStale(card, nowMs = Date.now()) {
  const startMs = cardSignalStartMs(card);
  const maxAge = Number(config.cardKlineVerifyMaxAgeMs) || 8 * 3_600_000;
  return nowMs - startMs > maxAge;
}

/**
 * 超过有效窗口 → progress.status=expired，不再做 K 线核验。
 * @param {Record<string, unknown>} card
 * @param {number} [nowMs]
 * @returns {ReturnType<typeof emptyProgress> | null} 需写库时返回新 progress，已过期则 null
 */
export function expireProgressIfStale(card, nowMs = Date.now()) {
  if (!isCardVerifyStale(card, nowMs)) return null;
  const prev = parseProgressJson(card.progress);
  if (prev && String(prev.status ?? "") === "expired") return null;
  return mergeProgress(
    prev ?? emptyProgress(),
    emptyProgress({
      status: "expired",
      note: "stale_8h",
      lastCheckAt: new Date().toISOString(),
    })
  );
}

/**
 * @param {Record<string, unknown>} card
 */
export function cardSignalStartMs(card) {
  const iso = resolveCardSignalAt(card) ?? card.signalAt ?? card.signal_at ?? card.createdAt ?? card.created_at;
  const ms = iso ? new Date(String(iso)).getTime() : Date.now();
  return Number.isFinite(ms) ? ms : Date.now();
}

/**
 * 终态（不再检查）。
 * @param {unknown} progress
 */
export function isProgressTerminal(progress) {
  const p = parseProgressJson(progress);
  if (!p) return false;
  const s = String(p.status ?? "");
  return s === "closed_tp" || s === "closed_sl" || s === "expired";
}
