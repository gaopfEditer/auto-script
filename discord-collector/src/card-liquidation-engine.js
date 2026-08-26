/**
 * 卡片批量清算：按信号时间查交易所 K 线，模拟入场与严格止盈止损结算。
 */
import {
  calcLeveragePnl,
  fetchKlinesForCard,
  parseEntryPrice,
  parsePrice,
} from "./card-price-fetch.js";
import { isShortDirection } from "./card-direction.js";
import { getCardVerifyPlan, getVerifyWindowSpec, resolveVerifyMode } from "./card-verify-policy.js";
import {
  emptyProgress,
  parseProgressJson,
  resolveCardExecution,
} from "./card-level-progress.js";
import { hasEvaluatedYield, normalizeExecution } from "./discord-signal-execution.js";
import { resolveCardSignalAt } from "./discord-signal-card-service.js";
import { archiveCardToClient, normalizeCardSourceType } from "./card-archive-service.js";
import { archiveCardMatchesSourceTypes } from "./card-archive-list-cache.js";
import { detectAssetClass } from "./card-verify-policy.js";

export const LIQUIDATION_ENTRY_TOLERANCE_PCT = 0.5;
export const LIQUIDATION_DEFAULT_TP_SL_PCT = 5;
/** 限价入场最长等待：超时未触及则判未入场，且不再重复匹配 */
export const LIQUIDATION_ENTRY_WINDOW_MS = 12 * 60 * 60 * 1000;

const LEV_100_BASES = new Set([
  "BTC",
  "ETH",
  "SOL",
  "XAU",
  "XAG",
  "GOLD",
  "PAXG",
  "OIL",
  "WTI",
  "USOIL",
  "CL",
  "BRENT",
  "USO",
]);

/**
 * 主流 BTC/ETH/SOL、黄金、原油 100x；其余山寨 20x。
 * @param {unknown} symbol
 * @param {unknown} [assetClass]
 */
export function resolveLiquidationLeverage(symbol, assetClass) {
  const bare = String(symbol ?? "")
    .toUpperCase()
    .trim()
    .replace(/(USDT|USDC|BUSD)$/, "");
  if (LEV_100_BASES.has(bare)) return 100;
  if (/^(XAU|XAG|GOLD|PAXG|OIL|WTI|USOIL|CL|BRENT|USO)/i.test(bare)) return 100;
  const ac = String(assetClass ?? "").toLowerCase();
  if (ac === "stock") return 20;
  return 20;
}

/** @param {unknown} v */
export function isMarketEntryHint(v) {
  const s = String(v ?? "").trim();
  if (!s) return false;
  if (/市价|现价|市场价|market|当前价|现价入场/i.test(s)) return true;
  // 「2520 附近」有具体价位 → 限价附近，不是市价
  if (/附近/i.test(s)) return parseEntryPrice(s) == null;
  return false;
}

/**
 * @param {number} entry
 * @param {boolean} isShort
 * @param {number[]} tps
 * @param {number | null} sl
 */
export function applyDefaultTpSl(entry, isShort, tps, sl) {
  const pct = LIQUIDATION_DEFAULT_TP_SL_PCT / 100;
  /** @type {number[]} */
  const outTps = [...tps];
  let outSl = sl;
  if (!outTps.length) {
    outTps.push(isShort ? entry * (1 - pct) : entry * (1 + pct));
  }
  if (outSl == null) {
    outSl = isShort ? entry * (1 + pct) : entry * (1 - pct);
  }
  return { tps: outTps, sl: outSl };
}

/** @param {number} entry @param {number} tp @param {boolean} isShort */
export function isValidTpLevel(entry, tp, isShort) {
  if (!Number.isFinite(entry) || !Number.isFinite(tp) || tp <= 0) return false;
  return isShort ? tp < entry : tp > entry;
}

/** @param {number} entry @param {number} sl @param {boolean} isShort */
export function isValidSlLevel(entry, sl, isShort) {
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || sl <= 0) return false;
  return isShort ? sl > entry : sl < entry;
}

/**
 * 丢弃方向错误的止盈/止损，再补默认 ±5%。
 * @param {number} entry
 * @param {boolean} isShort
 * @param {number[]} tps
 * @param {number | null} sl
 */
export function sanitizeLiquidationLevels(entry, isShort, tps, sl) {
  const validTps = tps.filter((tp) => isValidTpLevel(entry, tp, isShort));
  const validSl = sl != null && isValidSlLevel(entry, sl, isShort) ? sl : null;
  return applyDefaultTpSl(entry, isShort, validTps, validSl);
}

/** @param {number} a @param {number} b @param {number} ref */
function priceNear(a, b, ref) {
  const tol = Math.max(ref * 0.0005, 1e-8);
  return Math.abs(a - b) <= tol;
}

/**
 * 按结算价相对入场/止盈/止损严格归类（禁止「止损 + 正收益」矛盾展示）。
 * @param {number} entry
 * @param {number} exit
 * @param {boolean} isShort
 * @param {number | null} sl
 * @param {number[]} tps
 */
export function classifyOutcomeByExit(entry, exit, isShort, sl, tps) {
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) return "pending";
  if (sl != null && isValidSlLevel(entry, sl, isShort) && priceNear(exit, sl, entry)) {
    return "stop_loss";
  }
  for (const tp of tps) {
    if (isValidTpLevel(entry, tp, isShort) && priceNear(exit, tp, entry)) {
      return "take_profit";
    }
  }
  const spotMove = isShort ? (entry - exit) / entry : (exit - entry) / entry;
  if (spotMove > 1e-6) return "take_profit";
  if (spotMove < -1e-6) return "stop_loss";
  return "pending";
}

/**
 * 单根 K 线内：open 更接近哪一侧先触达（严格价序，避免误标止损）。
 * @param {number} open
 * @param {boolean} isShort
 * @param {number | null} sl
 * @param {number[]} tpPrices
 */
function isTpHitBeforeSl(open, isShort, sl, tpPrices) {
  if (!Number.isFinite(open) || sl == null || !tpPrices.length) return false;
  const slDist = Math.abs(sl - open);
  const minTpDist = Math.min(...tpPrices.map((tp) => Math.abs(tp - open)));
  return minTpDist < slDist;
}

/**
 * @param {boolean} isShort
 * @param {number} high
 * @param {number} low
 * @param {number} level
 * @param {'entry'|'sl'|'tp'} kind
 */
function touchesLevel(isShort, high, low, level, kind) {
  if (!Number.isFinite(level)) return false;
  if (kind === "entry") return isShort ? high >= level : low <= level;
  if (kind === "sl") return isShort ? high >= level : low <= level;
  return isShort ? low <= level : high >= level;
}

/**
 * @param {Array<{ open?: number, high: number, low: number, close?: number, ts?: number }>} klines
 * @param {number} signalMs
 */
function marketPriceAtSignal(klines, signalMs) {
  const sorted = [...klines].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const bar = sorted.find((k) => (k.ts ?? 0) >= signalMs) ?? sorted[0];
  if (!bar) return null;
  const p = Number(bar.open ?? bar.close ?? bar.high ?? bar.low);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * @param {string} note
 * @param {{ leverage: number, marketAtSignal?: number | null, plannedEntry?: number | null, isShort?: boolean }} ctx
 */
function buildNotEnteredResult(note, ctx) {
  const { leverage, marketAtSignal = null, plannedEntry = null, isShort = false } = ctx;
  return {
    mode: "liquidation",
    entered: false,
    status: "not_entered",
    outcome: "pending",
    pnlPct: 0,
    leverage,
    marketAtSignal,
    plannedEntry,
    note,
    isShort,
    progress: emptyProgress({
      status: "not_entered",
      outcome: "pending",
      pnlPct: 0,
      leverage,
      note,
      lastPrice: marketAtSignal,
      mode: "liquidation",
      entryWindowMs: LIQUIDATION_ENTRY_WINDOW_MS,
    }),
  };
}

/**
 * @param {Record<string, unknown>} card
 * @param {Array<{ open?: number, high: number, low: number, close?: number, ts?: number }>} klines
 * @param {{ signalMs: number }} opts
 */
export function evaluateLiquidation(card, klines, opts) {
  const signalMs = Number(opts.signalMs);
  const execution = resolveCardExecution(card);
  const isShort = isShortDirection(execution.direction);
  const leverage = resolveLiquidationLeverage(
    card.symbol,
    card.assetClass ?? card.asset_class ?? detectAssetClass(card.symbol, card.parsedJson, execution, card.rawContent)
  );
  const plannedEntryRaw = execution.planned?.entryPrice;
  const marketHint = isMarketEntryHint(plannedEntryRaw);
  const plannedEntry = parseEntryPrice(plannedEntryRaw);
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const entryDeadlineMs = signalMs + LIQUIDATION_ENTRY_WINDOW_MS;

  const sorted = [...klines].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  if (!sorted.length) {
    return {
      mode: "liquidation",
      error: "no_klines",
      entered: false,
      status: "watching",
      outcome: "pending",
      pnlPct: 0,
      leverage,
      note: "无 K 线",
    };
  }

  const marketAtSignal = marketPriceAtSignal(sorted, signalMs);
  if (marketAtSignal == null) {
    return {
      mode: "liquidation",
      error: "no_market_price",
      entered: false,
      status: "watching",
      outcome: "pending",
      pnlPct: 0,
      leverage,
      note: "无法取市价",
    };
  }

  /** @type {string | null} */
  let entryHitAt = null;
  /** @type {number | null} */
  let entryPriceUsed = null;

  if (marketHint || plannedEntry == null) {
    entryHitAt = new Date(signalMs).toISOString();
    entryPriceUsed = marketAtSignal;
  } else {
    const diffPct = (Math.abs(marketAtSignal - plannedEntry) / plannedEntry) * 100;
    if (diffPct <= LIQUIDATION_ENTRY_TOLERANCE_PCT) {
      entryHitAt = new Date(signalMs).toISOString();
      entryPriceUsed = marketAtSignal;
    } else {
      for (const k of sorted) {
        const kTs = k.ts ?? 0;
        if (kTs < signalMs) continue;
        if (kTs > entryDeadlineMs) break;
        const high = Number(k.high);
        const low = Number(k.low);
        if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
        if (touchesLevel(isShort, high, low, plannedEntry, "entry")) {
          entryHitAt = k.ts ? new Date(k.ts).toISOString() : nowIso;
          entryPriceUsed = plannedEntry;
          break;
        }
      }
    }
  }

  if (!entryHitAt || entryPriceUsed == null) {
    if (nowMs < entryDeadlineMs) {
      return {
        mode: "liquidation",
        skipped: true,
        reason: "awaiting_entry",
        entered: false,
        status: "watching",
        outcome: "pending",
        pnlPct: 0,
        leverage,
        marketAtSignal,
        plannedEntry: plannedEntry ?? null,
        note: "等待入场（12小时内）",
        isShort,
        entryDeadlineMs,
      };
    }
    return buildNotEnteredResult("12小时内未入场", {
      leverage,
      marketAtSignal,
      plannedEntry: plannedEntry ?? null,
      isShort,
    });
  }

  let sl = parsePrice(execution.planned?.stopLossPrice);
  /** @type {number[]} */
  let tps = (execution.planned?.takeProfitPrices ?? [])
    .map((p) => parsePrice(p))
    .filter((x) => x != null);
  const sanitized = sanitizeLiquidationLevels(entryPriceUsed, isShort, tps, sl);
  tps = sanitized.tps;
  sl = sanitized.sl;

  const n = Math.max(tps.length, 1);
  const sizePct = 1 / n;
  /** @type {Array<{ index: number, price: number, hitAt: string, sizePct: number }>} */
  const tpHits = [];
  /** @type {Set<number>} */
  const hitIdx = new Set();
  let slHitAt = null;
  /** @type {number | null} */
  let settlementPrice = null;
  /** @type {string} */
  let settlementAt = "";
  /** @type {string} */
  let outcome = "pending";

  const entryMs = Date.parse(entryHitAt);

  /** @param {string} hitAt @param {number} high @param {number} low @param {number} remaining */
  function applyStopLoss(hitAt, high, low, remaining) {
    if (remaining <= 1e-9 || sl == null || !touchesLevel(isShort, high, low, sl, "sl")) return false;
    slHitAt = hitAt;
    settlementPrice = sl;
    settlementAt = hitAt;
    outcome = "stop_loss";
    return true;
  }

  /** @param {string} hitAt @param {number} high @param {number} low */
  function applyTakeProfitTouches(hitAt, high, low) {
    for (let i = 0; i < tps.length; i++) {
      if (hitIdx.has(i)) continue;
      const tp = tps[i];
      if (!touchesLevel(isShort, high, low, tp, "tp")) continue;
      hitIdx.add(i);
      tpHits.push({ index: i, price: tp, hitAt, sizePct });
    }
  }

  for (const k of sorted) {
    if ((k.ts ?? 0) < entryMs - 1) continue;
    const hitAt = k.ts ? new Date(k.ts).toISOString() : nowIso;
    const high = Number(k.high);
    const low = Number(k.low);
    const open = Number(k.open ?? (high + low) / 2);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    const remaining = 1 - hitIdx.size * sizePct;
    const slTouch =
      remaining > 1e-9 && sl != null && touchesLevel(isShort, high, low, sl, "sl");
    /** @type {number[]} */
    const pendingTpIdx = [];
    for (let i = 0; i < tps.length; i++) {
      if (hitIdx.has(i)) continue;
      if (touchesLevel(isShort, high, low, tps[i], "tp")) pendingTpIdx.push(i);
    }

    if (slTouch && pendingTpIdx.length > 0) {
      const pendingTpPrices = pendingTpIdx.map((i) => tps[i]);
      if (isTpHitBeforeSl(open, isShort, sl, pendingTpPrices)) {
        applyTakeProfitTouches(hitAt, high, low);
        if (hitIdx.size >= tps.length && tps.length > 0) {
          const lastTp = tpHits[tpHits.length - 1];
          settlementPrice = lastTp?.price ?? tps[tps.length - 1];
          settlementAt = lastTp?.hitAt ?? hitAt;
          outcome = "take_profit";
          break;
        }
        const rem2 = 1 - hitIdx.size * sizePct;
        if (applyStopLoss(hitAt, high, low, rem2)) break;
      } else if (applyStopLoss(hitAt, high, low, remaining)) {
        break;
      } else {
        applyTakeProfitTouches(hitAt, high, low);
      }
    } else if (slTouch && applyStopLoss(hitAt, high, low, remaining)) {
      break;
    } else {
      applyTakeProfitTouches(hitAt, high, low);
    }

    if (hitIdx.size >= tps.length && tps.length > 0) {
      const lastTp = tpHits[tpHits.length - 1];
      settlementPrice = lastTp?.price ?? tps[tps.length - 1];
      settlementAt = lastTp?.hitAt ?? hitAt;
      outcome = "take_profit";
      break;
    }
  }

  if (outcome === "pending" && tpHits.length > 0) {
    const lastTp = tpHits[tpHits.length - 1];
    settlementPrice = lastTp?.price ?? null;
    settlementAt = lastTp?.hitAt ?? "";
    outcome = "take_profit";
  }

  /** @type {import("./card-level-progress.js").ProgressStatus} */
  let status = "entered";
  if (slHitAt) status = "closed_sl";
  else if (tps.length > 0 && hitIdx.size >= tps.length) status = "closed_tp";
  else if (tpHits.length > 0) status = "partial_tp";

  // 严格：盈亏与结果均按「整仓在结算价平仓」核算，与止盈/止损价位一致
  let roundedPnl = 0;
  let pnlLabel = "0%";
  if (settlementPrice != null && entryPriceUsed != null) {
    if (tps.length > 0 && hitIdx.size >= tps.length) {
      outcome = "take_profit";
      const lastTp = tpHits[tpHits.length - 1];
      if (lastTp) settlementPrice = lastTp.price;
    } else {
      const classified = classifyOutcomeByExit(entryPriceUsed, settlementPrice, isShort, sl, tps);
      if (classified !== "pending") outcome = classified;
    }
    const strictPnl = calcLeveragePnl(entryPriceUsed, settlementPrice, isShort, leverage);
    if (strictPnl) {
      roundedPnl = Math.round(strictPnl.pnlPctOnMargin * 100) / 100;
      pnlLabel = strictPnl.pnlLabel;
      if (outcome === "stop_loss" && strictPnl.pnlPctOnMargin > 0) {
        outcome = classifyOutcomeByExit(entryPriceUsed, settlementPrice, isShort, sl, tps);
        if (outcome === "pending") outcome = "take_profit";
      }
      if (outcome === "take_profit" && strictPnl.pnlPctOnMargin < 0) {
        outcome = "stop_loss";
      }
    }
  }

  if (outcome === "take_profit") {
    status =
      tps.length > 0 && hitIdx.size >= tps.length
        ? "closed_tp"
        : tpHits.length > 0
          ? "partial_tp"
          : "entered";
  } else if (outcome === "stop_loss") {
    status = "closed_sl";
  }

  const pnl =
    settlementPrice != null && entryPriceUsed != null
      ? calcLeveragePnl(entryPriceUsed, settlementPrice, isShort, leverage)
      : null;

  const progress = emptyProgress({
    entryHitAt,
    entryPriceUsed,
    tpHits,
    slHitAt,
    slPrice: sl,
    status,
    lastCheckAt: nowIso,
    lastPrice: settlementPrice ?? marketAtSignal,
    pnlPct: roundedPnl,
    outcome: outcome === "pending" ? "pending" : outcome,
    sizePct,
    leverage,
    note: outcome === "pending" ? "窗口内未触达止盈止损" : undefined,
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
    takeProfits: tps,
    stopLoss: sl,
    tpHits,
    slHitAt,
    settlementPrice,
    settlementAt,
    pnlPct: roundedPnl,
    pnlLabel: pnl?.pnlLabel ?? pnlLabel,
    note:
      outcome === "stop_loss"
        ? "止损结算"
        : outcome === "take_profit"
          ? "止盈结算"
          : "窗口内未触达止盈止损",
    progress,
  };
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
export function shouldSkipLiquidation(card) {
  const ex = normalizeExecution(card.execution);
  if (hasEvaluatedYield(ex)) return "evaluated_yield";
  if (ex.outcome && ex.outcome !== "pending") return "outcome_set";

  const progress = parseProgressJson(card.progress);
  if (progress && String(progress.mode) === "liquidation") return "already_liquidated";

  const bt =
    card.backtest && typeof card.backtest === "object"
      ? /** @type {Record<string, unknown>} */ (card.backtest)
      : null;
  if (bt && String(bt.mode) === "liquidation") return "already_liquidated";

  const a = ex.actual;
  if (a?.buyPrice && a?.sellPrice && !ex.autoEval) return "manual_eval";
  return null;
}

/** @param {number | null | undefined} n */
function formatPriceLevel(n) {
  if (n == null || !Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  let digits = 8;
  if (abs >= 1000) digits = 2;
  else if (abs >= 1) digits = 4;
  else if (abs >= 0.01) digits = 6;
  return String(Number(n.toFixed(digits)));
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {ReturnType<typeof evaluateLiquidation>} result
 */
export function buildLiquidationPatch(card, result) {
  const ex = normalizeExecution(card.execution);
  const entry = result.entryPriceUsed;
  const tps = Array.isArray(result.takeProfits) ? result.takeProfits : [];
  const sl = result.stopLoss;
  const plannedTpStrings = tps.map((p) => formatPriceLevel(Number(p)));
  const plannedSlString = sl != null ? formatPriceLevel(Number(sl)) : "";
  const entryString = entry != null ? formatPriceLevel(Number(entry)) : String(ex.planned?.entryPrice ?? "");

  const plannedPatch = {
    ...ex.planned,
    entryPrice: entryString,
    takeProfitPrices: plannedTpStrings,
    stopLossPrice: plannedSlString,
  };

  /** @type {Record<string, unknown>} */
  const patch = {
    progressJson: {
      ...(result.progress && typeof result.progress === "object" ? result.progress : {}),
      mode: "liquidation",
      settledAt: new Date().toISOString(),
    },
    backtestJson: {
      mode: "liquidation",
      outcome: result.outcome,
      settlementPrice: result.settlementPrice ?? null,
      entry: result.entryPriceUsed ?? null,
      pnlPct: result.pnlPct ?? 0,
      pnlLabel: result.pnlLabel ?? null,
      leverage: result.leverage,
      marketAtSignal: result.marketAtSignal ?? null,
      plannedEntry: result.plannedEntry ?? null,
      takeProfits: result.takeProfits ?? [],
      stopLoss: result.stopLoss ?? null,
      note: result.note ?? null,
      entered: result.entered,
      status: result.status,
      settledAt: new Date().toISOString(),
      autoEval: true,
    },
  };

  if (result.entered && (result.outcome === "take_profit" || result.outcome === "stop_loss")) {
    const exit = result.settlementPrice;
    if (entry != null && exit != null) {
      const exitStr = formatPriceLevel(Number(exit));
      /** @type {string[]} */
      const actualTp =
        result.outcome === "take_profit"
          ? (result.tpHits?.length
              ? result.tpHits.map((h) => formatPriceLevel(Number(h.price)))
              : plannedTpStrings)
          : [...(ex.actual?.takeProfitPrices ?? [])];
      const actualSl =
        result.outcome === "stop_loss"
          ? plannedSlString || exitStr
          : plannedSlString || String(ex.actual?.stopLossPrice ?? "");

      patch.executionJson = {
        ...ex,
        planned: plannedPatch,
        outcome: result.outcome,
        outcomeNote: result.note ?? "",
        actual: {
          ...ex.actual,
          buyPrice: entryString,
          sellPrice: exitStr,
          takeProfitPrices: actualTp,
          stopLossPrice: actualSl,
          exitPrice: exitStr,
          closedAt: result.settlementAt ?? ex.actual?.closedAt ?? null,
        },
        autoEval: {
          source: "liquidation",
          pnlPct: result.pnlPct,
          settlementPrice: exit,
          at: result.settlementAt ?? null,
        },
      };
    }
  } else if (result.entered) {
    patch.executionJson = {
      ...ex,
      planned: plannedPatch,
      outcome: ex.outcome && ex.outcome !== "pending" ? ex.outcome : "pending",
      outcomeNote: result.note ?? ex.outcomeNote ?? "",
      autoEval: {
        source: "liquidation",
        pnlPct: result.pnlPct ?? 0,
        note: result.note ?? "",
        at: result.settlementAt ?? null,
      },
    };
  } else if (!result.entered) {
    const note = String(result.note ?? "未入场");
    patch.executionJson = {
      ...ex,
      outcome: "pending",
      outcomeNote: note,
      autoEval: {
        source: "liquidation",
        pnlPct: 0,
        note,
      },
    };
  }

  return patch;
}

/**
 * 是否含有可清空的自动清算结果（非手动评价）。
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
export function hasLiquidationSettlement(card) {
  const progress = parseProgressJson(card.progress);
  if (progress && String(progress.mode) === "liquidation") return true;
  const bt =
    card.backtest && typeof card.backtest === "object"
      ? /** @type {Record<string, unknown>} */ (card.backtest)
      : null;
  if (bt && String(bt.mode) === "liquidation") return true;
  const ex = normalizeExecution(card.execution);
  const rawEx = card.execution;
  if (rawEx && typeof rawEx === "object" && rawEx.autoEval) {
    const src = String(/** @type {Record<string, unknown>} */ (rawEx.autoEval).source ?? "");
    if (src === "liquidation") return true;
  }
  return false;
}

/**
 * 清空自动清算写入的 progress / backtest / execution，便于重新清算。
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
export function buildClearLiquidationPatch(card) {
  const ex = normalizeExecution(card.execution);
  const rawEx =
    card.execution && typeof card.execution === "object"
      ? /** @type {Record<string, unknown>} */ (card.execution)
      : null;
  const autoEval = rawEx?.autoEval;
  const wasLiquidation =
    hasLiquidationSettlement(card) ||
    (autoEval &&
      typeof autoEval === "object" &&
      String(/** @type {Record<string, unknown>} */ (autoEval).source ?? "") === "liquidation");

  /** @type {Record<string, unknown>} */
  const patch = {
    progressJson: null,
    backtestJson: null,
  };

  if (!wasLiquidation) {
    return patch;
  }

  const clearedEx = {
    ...ex,
    outcome: "pending",
    outcomeNote: "",
  };
  if (autoEval) {
    delete /** @type {Record<string, unknown>} */ (clearedEx).autoEval;
  }
  if (wasLiquidation) {
    clearedEx.actual = {
      ...ex.actual,
      buyPrice: "",
      sellPrice: "",
      takeProfitPrices: [],
      stopLossPrice: "",
      exitPrice: "",
      closedAt: null,
    };
  }

  patch.executionJson = clearedEx;
  return patch;
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {{ cardIds?: number[] }} opts
 * @param {{ onCardUpdated?: (id: number) => void | Promise<void> }} [hooks]
 */
export async function runBatchClearLiquidation(store, log, opts = {}, hooks = {}) {
  const ids = (opts.cardIds ?? [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return { ok: false, error: "cardIds required" };

  let cleared = 0;
  let skipped = 0;
  /** @type {Array<Record<string, unknown>>} */
  const items = [];

  for (const id of ids) {
    const row = await store.getSignalCardById(id);
    if (!row) {
      skipped += 1;
      items.push({ id, skipped: "not_found" });
      continue;
    }
    const card = archiveCardToClient(row);
    if (!hasLiquidationSettlement(card)) {
      skipped += 1;
      items.push({ id, symbol: card.symbol, skipped: "no_liquidation" });
      continue;
    }
    const patch = buildClearLiquidationPatch(card);
    await store.updateSignalCard(id, patch);
    if (hooks.onCardUpdated) await hooks.onCardUpdated(id);
    cleared += 1;
    log.info(`清空卡片清算 #${id} ${card.symbol}`);
    items.push({ id, symbol: card.symbol, cleared: true });
  }

  return { ok: true, cleared, skipped, total: ids.length, items };
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 清算用行情计划：USDT 永续一律走 crypto（避免 HYPE 等误标 stock）。
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
export function resolveLiquidationPlan(card) {
  const plan = getCardVerifyPlan(card);
  const sym = String(card.symbol ?? "").trim().toUpperCase();
  if (/(USDT|USDC|BUSD)$/.test(sym)) {
    const assetClass = "crypto";
    const verifyMode = resolveVerifyMode(assetClass, card.verifyMode ?? card.verify_mode);
    return {
      skip: false,
      assetClass,
      verifyMode,
      window: getVerifyWindowSpec(verifyMode),
    };
  }
  if (plan.assetClass === "stock") {
    return { skip: true, reason: "stock_no_market", assetClass: "stock" };
  }
  return { skip: false, ...plan };
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
export async function liquidateCard(card) {
  const plan = resolveLiquidationPlan(card);
  if (plan.skip) {
    return { skipped: true, reason: plan.reason ?? "stock_no_market", mode: "liquidation" };
  }
  const signalAt = resolveCardSignalAt(card) ?? card.signalAt ?? card.createdAt;
  const signalMs = signalAt ? Date.parse(String(signalAt)) : NaN;
  if (!Number.isFinite(signalMs)) {
    return { error: "invalid_signal_at", mode: "liquidation" };
  }
  const sym = String(card.symbol ?? "").trim();
  if (!sym) return { error: "no_symbol", mode: "liquidation" };

  const endMs = Math.min(Date.now(), signalMs + plan.window.durationMs);
  const klines = await fetchKlinesForCard(
    sym,
    plan.assetClass,
    signalMs,
    endMs,
    plan.window.klineInterval
  );
  return evaluateLiquidation(card, klines, { signalMs });
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {{ fromMs?: number, toMs?: number, channelId?: string, sourceType?: string, sourceTypes?: string[], source?: string, symbol?: string, limit?: number, cardIds?: number[] }} opts
 * @param {{ onCardUpdated?: (id: number) => void | Promise<void> }} [hooks]
 */
export async function runBatchLiquidation(store, log, opts = {}, hooks = {}) {
  const fromMs = Number(opts.fromMs);
  const toMs = Number(opts.toMs);
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 300));
  const channelId = String(opts.channelId ?? "").trim();
  const cardIds = (opts.cardIds ?? [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (!store.listCardsForEval && !store.listSignalCards) {
    return { ok: false, error: "store unavailable" };
  }

  const sourceTypes = Array.isArray(opts.sourceTypes)
    ? opts.sourceTypes.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    : [];
  const sourceFilter = String(opts.sourceType ?? opts.source ?? "").trim().toLowerCase();
  const srcList = sourceTypes.length ? sourceTypes : sourceFilter ? [sourceFilter] : [];
  const symbolFilter = String(opts.symbol ?? "").trim().toUpperCase();

  /** @type {Awaited<ReturnType<typeof store.listCardsForEval>>} */
  let rows = [];

  if (cardIds.length) {
    for (const id of cardIds) {
      const row = await store.getSignalCardById(id);
      if (row) rows.push(row);
    }
  } else if (store.listCardsForEval) {
    rows = await store.listCardsForEval({
      fromMs: Number.isFinite(fromMs) ? fromMs : Date.now() - 7 * 86400000,
      toMs: Number.isFinite(toMs) ? toMs : Date.now(),
      channelId: channelId || undefined,
      limit: Math.min(500, limit * 3),
    });
  } else if (store.listSignalCards) {
    rows = await store.listSignalCards({
      fromMs: Number.isFinite(fromMs) ? fromMs : Date.now() - 7 * 86400000,
      toMs: Number.isFinite(toMs) ? toMs : Date.now(),
      channelId: channelId || undefined,
      sourceTypes: srcList.length ? srcList : undefined,
      symbol: symbolFilter || undefined,
      limit,
    });
  }

  if (!cardIds.length && (srcList.length || symbolFilter)) {
    rows = rows.filter((row) => {
      const st = normalizeCardSourceType(row.source_type ?? row.sourceType ?? "");
      if (srcList.length && !archiveCardMatchesSourceTypes(st, srcList)) return false;
      if (symbolFilter) {
        const s = String(row.symbol ?? "").toUpperCase();
        const bare = symbolFilter.replace(/USDT$/, "");
        if (!s.includes(bare)) return false;
      }
      return true;
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

  log.info(
    `卡片清算开始 range=${Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : "?"}..${Number.isFinite(toMs) ? new Date(toMs).toISOString() : "?"} total=${rows.length}`
  );

  for (const row of rows) {
    const card = archiveCardToClient(row);
    const skip = shouldSkipLiquidation(card);
    if (skip) {
      skipped += 1;
      items.push({ id: card.id, symbol: card.symbol, skipped: skip });
      continue;
    }

    try {
      const result = await liquidateCard(card);
      if (result.skipped || result.error) {
        skipped += 1;
        log.info(
          `卡片清算跳过 #${card.id} ${card.symbol} ${result.reason ?? result.error ?? "skipped"}`
        );
        items.push({
          id: card.id,
          symbol: card.symbol,
          skipped: result.reason ?? result.error ?? "skipped",
        });
        continue;
      }

      const patch = buildLiquidationPatch(card, result);
      await store.updateSignalCard(card.id, patch);
      if (hooks.onCardUpdated) await hooks.onCardUpdated(card.id);
      processed += 1;
      log.info(
        `卡片清算 #${card.id} ${card.symbol} ${result.status} outcome=${result.outcome} pnl=${result.pnlPct}% entry=${result.entryPriceUsed ?? "-"} exit=${result.settlementPrice ?? "-"}`
      );
      items.push({
        id: card.id,
        symbol: card.symbol,
        status: result.status,
        outcome: result.outcome,
        pnlPct: result.pnlPct,
        entered: result.entered,
        note: result.note,
      });
    } catch (e) {
      failed += 1;
      const msg = String(/** @type {Error} */ (e).message ?? e);
      log.warn(`卡片清算失败 #${card.id} ${card.symbol}: ${msg}`);
      items.push({ id: card.id, symbol: card.symbol, error: msg });
    }
    await sleep(400);
  }

  const errorHints = [...new Set(items.map((i) => String(i.error ?? "")).filter(Boolean))].slice(0, 5);

  log.info(`卡片清算完成 processed=${processed} skipped=${skipped} failed=${failed} total=${rows.length}`);

  return {
    ok: true,
    processed,
    skipped,
    failed,
    total: rows.length,
    items,
    errorHints,
  };
}
