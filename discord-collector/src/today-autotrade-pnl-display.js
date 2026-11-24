/**
 * 今日盈亏页：展示口径（不写库、不改下单），过滤错符号计划、对齐方向与标签。
 */
import { isShortDirection } from "./card-direction.js";
import { parseProgressJson, resolveProgressLeverage } from "./card-level-progress.js";
import { flattenBatchBacktestDoc } from "./card-batch-backtest-engine.js";
import { isMarketEntryHint, isValidSlLevel, isValidTpLevel } from "./card-liquidation-engine.js";
import { alignPnlWithOutcome, parseEntryPrice, parsePrice } from "./card-price-fetch.js";
import { resolveCardEvalOutcome } from "./card-eval-outcome.js";
import { executionFromParsed, normalizeExecution } from "./discord-signal-execution.js";

/** @param {unknown} symbol */
export function bareTradeSymbol(symbol) {
  return String(symbol ?? "")
    .toUpperCase()
    .trim()
    .replace(/(USDT|USDC|BUSD)$/, "");
}

/** 主流永续合理价格下限（展示过滤，非行情真值） */
const MAJOR_MIN_DISPLAY_PRICE = {
  BTC: 5000,
  ETH: 200,
  SOL: 5,
  BNB: 50,
  XRP: 0.01,
};

/**
 * @param {Record<string, unknown>} card
 */
export function resolveTodayPnlMarkContext(card) {
  const ex = normalizeExecution(card.execution, card.parsedJson);
  const isShort = isShortDirection(ex.direction);
  const prog = parseProgressJson(card.progress);
  const leverage =
    Number(prog?.leverage) > 0
      ? Number(prog.leverage)
      : resolveProgressLeverage(card);
  return { execution: ex, isShort, leverage };
}

/**
 * 入场价字段若像「斩获800%+」 Marketing 文，不能当价位。
 * @param {unknown} raw
 * @param {unknown} symbol
 */
export function isImplausibleEntryText(raw, symbol) {
  const s = String(raw ?? "").trim();
  if (!s) return false;
  if (!/%/.test(s)) return false;
  const n = parseEntryPrice(s);
  if (n == null) return true;
  const bare = bareTradeSymbol(symbol);
  const minMajor = MAJOR_MIN_DISPLAY_PRICE[bare];
  if (minMajor != null && n < minMajor) return true;
  if (/%/.test(s) && !/[\d,.]{4,}/.test(s.replace(/%\s*/g, ""))) return true;
  return false;
}

/**
 * @param {unknown} symbol
 * @param {number | null} price
 */
export function priceSaneForSymbol(symbol, price) {
  if (price == null || !Number.isFinite(price) || price <= 0) return false;
  const bare = bareTradeSymbol(symbol);
  const floor = MAJOR_MIN_DISPLAY_PRICE[bare];
  if (floor != null && price < floor) return false;
  return true;
}

/**
 * @param {number} anchor
 * @param {number} level
 * @param {number} [maxRatio]
 */
export function levelNearAnchor(anchor, level, maxRatio = 4) {
  if (!Number.isFinite(anchor) || anchor <= 0 || !Number.isFinite(level) || level <= 0) {
    return false;
  }
  const r = level / anchor;
  return r >= 1 / maxRatio && r <= maxRatio;
}

/**
 * execution 币种与卡片不一致时，只用 parsedJson 上的同币种计划。
 * @param {Record<string, unknown>} card
 */
/**
 * 展示用入场锚价：不用 progress 里从营销文偷来的 800 之类。
 * @param {Record<string, unknown>} card
 * @param {ReturnType<typeof normalizeExecution>} ex
 */
export function resolveDisplayEntryAnchor(card, ex) {
  const sym = String(card.symbol ?? ex.symbol ?? "").trim();
  const prog = parseProgressJson(card.progress);
  const fromProg = Number(prog?.entryPriceUsed);
  if (Number.isFinite(fromProg) && fromProg > 0 && priceSaneForSymbol(sym, fromProg)) {
    return fromProg;
  }
  if (card.parsedJson && typeof card.parsedJson === "object") {
    const fromParsed = executionFromParsed(card.parsedJson);
    const e = parseEntryPrice(fromParsed.planned?.entryPrice);
    if (e != null && priceSaneForSymbol(sym, e)) return e;
  }
  const raw = ex.planned?.entryPrice;
  if (!isImplausibleEntryText(raw, sym)) {
    const e = parseEntryPrice(raw);
    if (e != null && priceSaneForSymbol(sym, e)) return e;
  }
  return null;
}

/**
 * @param {number | null} entry
 * @param {number} level
 * @param {boolean} isShort
 * @param {"sl"|"tp"} kind
 */
export function levelMatchesDirection(entry, level, isShort, kind) {
  if (entry == null || !Number.isFinite(entry) || entry <= 0) return true;
  return kind === "sl" ? isValidSlLevel(entry, level, isShort) : isValidTpLevel(entry, level, isShort);
}

function executionForDisplayPlan(card) {
  const ex = normalizeExecution(card.execution, card.parsedJson);
  const cardSym = bareTradeSymbol(card.symbol);
  const exSym = bareTradeSymbol(ex.symbol || card.symbol);
  if (exSym && cardSym && exSym !== cardSym) {
    const fromParsed = executionFromParsed(card.parsedJson);
    if (bareTradeSymbol(fromParsed.symbol) === cardSym || !fromParsed.symbol) {
      return { ...fromParsed, symbol: card.symbol ?? fromParsed.symbol };
    }
    return executionFromParsed({ symbol: card.symbol, direction: ex.direction });
  }
  return ex;
}

/**
 * @param {Record<string, unknown>} card
 * @param {{ stopLossPrice: string | null, takeProfitPrices: string[], takeProfitText: string | null }} raw
 */
function filterTpslLevel(sym, anchor, isShort, kind, priceStr) {
  const n = parsePrice(priceStr);
  if (n == null) return false;
  if (!priceSaneForSymbol(sym, n)) return false;
  if (anchor != null && !levelNearAnchor(anchor, n, 3)) return false;
  if (!levelMatchesDirection(anchor, n, isShort, kind)) return false;
  return true;
}

export function sanitizeDisplayTpsl(card, raw) {
  const ex = executionForDisplayPlan(card);
  const sym = String(card.symbol ?? ex.symbol ?? "").trim();
  const isShort = isShortDirection(ex.direction);
  const anchor = resolveDisplayEntryAnchor(card, ex);

  const slRaw = raw.stopLossPrice;
  const slNum = parsePrice(slRaw);
  if (
    slNum != null &&
    anchor != null &&
    !levelMatchesDirection(anchor, slNum, isShort, "sl")
  ) {
    return { stopLossPrice: null, takeProfitPrices: [], takeProfitText: null };
  }

  let stopLossPrice = slRaw;
  if (slNum != null) {
    if (!filterTpslLevel(sym, anchor, isShort, "sl", slRaw)) stopLossPrice = null;
  }

  const takeProfitPrices = [];
  for (const p of raw.takeProfitPrices ?? []) {
    if (!filterTpslLevel(sym, anchor, isShort, "tp", p)) continue;
    takeProfitPrices.push(String(p).trim());
  }

  const takeProfitText = takeProfitPrices.length ? takeProfitPrices.join(", ") : null;

  const out = {
    stopLossPrice: stopLossPrice || null,
    takeProfitPrices,
    takeProfitText,
  };

  if ((!out.stopLossPrice || !out.takeProfitPrices.length) && card.parsedJson) {
    const fromParsed = executionFromParsed(card.parsedJson);
    const dirShort = isShortDirection(fromParsed.direction || ex.direction);
    const slParsed = parsePrice(fromParsed.planned?.stopLossPrice);
    if (
      slParsed != null &&
      anchor != null &&
      !levelMatchesDirection(anchor, slParsed, dirShort, "sl")
    ) {
      return out;
    }
    if (fromParsed.planned) {
      const sl2 = String(fromParsed.planned.stopLossPrice ?? "").trim();
      if (!out.stopLossPrice && sl2 && filterTpslLevel(sym, anchor, dirShort, "sl", sl2)) {
        out.stopLossPrice = sl2;
      }
      if (!out.takeProfitPrices.length) {
        for (const p of fromParsed.planned.takeProfitPrices ?? []) {
          const s = String(p ?? "").trim();
          if (!s || !filterTpslLevel(sym, anchor, dirShort, "tp", s)) continue;
          out.takeProfitPrices.push(s);
        }
        out.takeProfitText = out.takeProfitPrices.length ? out.takeProfitPrices.join(", ") : null;
      }
    }
  }

  return out;
}

/**
 * 浮盈/路径 pnl 与 outcome 标签对齐（展示用）。
 * @param {unknown} storedOutcome
 * @param {number | null | undefined} pnlPct
 */
/** 展示盈亏：异常入场或离谱倍数不写进今日盈亏表。 */
export function reconcileDisplayPnlPct(card, pnlPct) {
  if (pnlPct == null || !Number.isFinite(Number(pnlPct))) return pnlPct ?? null;
  const p = Number(pnlPct);
  const prog = parseProgressJson(card.progress);
  const entry = Number(prog?.entryPriceUsed);
  if (Number.isFinite(entry) && entry > 0 && !priceSaneForSymbol(card.symbol, entry)) {
    return null;
  }
  const ex = executionForDisplayPlan(card);
  if (isImplausibleEntryText(ex.planned?.entryPrice, card.symbol)) {
    if (resolveDisplayEntryAnchor(card, ex) == null) return null;
  }
  if (Math.abs(p) > 2500) return null;
  return Math.round(p * 100) / 100;
}

export function reconcileDisplayOutcome(storedOutcome, pnlPct) {
  if (pnlPct == null || !Number.isFinite(Number(pnlPct))) {
    return storedOutcome ? String(storedOutcome) : "";
  }
  const p = Number(pnlPct);
  const fromPnl = p >= 0 ? "take_profit" : "stop_loss";
  const stored = String(storedOutcome ?? "").trim();
  if (!stored || stored === "pending") return fromPnl;
  if (stored === "take_profit" && p < 0) return "stop_loss";
  if (stored === "stop_loss" && p > 0) return "take_profit";
  return stored;
}

/**
 * 与卡片 UI `resolveCardPnlPct` 一致：先质量过滤，再按评价 outcome 对齐盈亏符号。
 * @param {Record<string, unknown>} card
 * @param {number | null | undefined} rawPnlPct
 */
export function resolveCardAlignedDisplayPnl(card, rawPnlPct) {
  const filtered = reconcileDisplayPnlPct(card, rawPnlPct);
  if (filtered == null) return null;
  const outcome = resolveCardEvalOutcome(card);
  return alignPnlWithOutcome(outcome, filtered);
}

/**
 * 与卡片 UI `resolveCardEvalOutcome` 一致（任一 TP 命中 → 止盈）。
 * @param {Record<string, unknown>} card
 * @param {unknown} [progressOutcomeFallback]
 */
export function resolveCardAlignedDisplayOutcome(card, progressOutcomeFallback) {
  const o = resolveCardEvalOutcome(card);
  if (o === "take_profit" || o === "stop_loss") return o;
  return reconcileDisplayOutcome(progressOutcomeFallback, null);
}

/**
 * @param {Record<string, unknown>} card
 */
export function resolveMarkEntryPriceForDisplay(card) {
  const ex = executionForDisplayPlan(card);
  return resolveDisplayEntryAnchor(card, ex);
}

/** @param {number} n */
export function formatDisplayPrice(n) {
  if (!Number.isFinite(n)) return null;
  const a = Math.abs(n);
  if (a >= 1000) return String(Math.round(n * 100) / 100);
  if (a >= 1) return String(Math.round(n * 10000) / 10000);
  return String(Math.round(n * 1e6) / 1e6);
}

/** @param {unknown} raw */
function parseCardJsonBlob(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return /** @type {Record<string, unknown>} */ (raw);
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" ? /** @type {Record<string, unknown>} */ (v) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 管线已存的信号时刻市价（非现价 MTM）。
 * @param {Record<string, unknown>} card
 */
export function resolveStoredMarketAtSignal(card) {
  const sym = String(card.symbol ?? "").trim();
  const bt = parseCardJsonBlob(card.backtest ?? card.backtest_json ?? card.backtestJson);
  if (bt) {
    const flat = flattenBatchBacktestDoc(bt) ?? bt;
    const m = Number(flat.marketAtSignal ?? flat.market_at_signal);
    if (Number.isFinite(m) && m > 0 && priceSaneForSymbol(sym, m)) return m;
  }

  const ex = normalizeExecution(card.execution, card.parsedJson);
  const rawEx = parseCardJsonBlob(card.execution);
  const auto =
    rawEx?.autoEval && typeof rawEx.autoEval === "object"
      ? /** @type {Record<string, unknown>} */ (rawEx.autoEval)
      : null;
  const fromAuto = Number(auto?.marketAtSignal ?? auto?.marketAtSignalPrice);
  if (Number.isFinite(fromAuto) && fromAuto > 0 && priceSaneForSymbol(sym, fromAuto)) {
    return fromAuto;
  }

  const pj = parseCardJsonBlob(card.parsedJson);
  const bg =
    pj?.bitgetOrder && typeof pj.bitgetOrder === "object"
      ? /** @type {Record<string, unknown>} */ (pj.bitgetOrder)
      : null;
  if (bg) {
    const fill = Number(bg.avgFillPrice ?? bg.fillPrice ?? bg.executedPrice ?? bg.price);
    const plan =
      bg.plan && typeof bg.plan === "object"
        ? /** @type {Record<string, unknown>} */ (bg.plan)
        : null;
    const fromOrder = Number(
      fill > 0 ? fill : plan?.price ?? plan?.entryPrice ?? bg.markPrice
    );
    if (Number.isFinite(fromOrder) && fromOrder > 0 && priceSaneForSymbol(sym, fromOrder)) {
      return fromOrder;
    }
  }

  const plannedRaw = ex.planned?.entryPrice;
  if (isMarketEntryHint(plannedRaw)) {
    const anchor = resolveDisplayEntryAnchor(card, executionForDisplayPlan(card));
    if (anchor != null) return anchor;
  }

  return null;
}

/**
 * 今日盈亏表入场列：合法计划/成交价，否则发单时刻市价（管线已有字段）。
 * @param {Record<string, unknown>} card
 */
/** 同源渠道 + 同币种 + 信号时间差小于此值 → 今日盈亏列表去重（仅展示，不改库） */
export const TODAY_PNL_SIGNAL_DEDUPE_MS = 5 * 60 * 1000;

/**
 * @param {Record<string, unknown>} t
 */
function tradeDedupeKey(t) {
  const ch = String(t.channelId ?? t.channelName ?? "").trim().toLowerCase();
  const sym = bareTradeSymbol(t.symbol);
  return `${ch}\0${sym}`;
}

/** @param {Record<string, unknown>} t */
function tradeSignalMs(t) {
  const ms = Date.parse(String(t.signalAt ?? t.orderAt ?? ""));
  return Number.isFinite(ms) ? ms : 0;
}

/** @param {Record<string, unknown>} t */
function planCompletenessScore(t) {
  let s = 0;
  if (String(t.stopLossPrice ?? "").trim()) s += 2;
  if (String(t.takeProfitText ?? "").trim() || (Array.isArray(t.takeProfitPrices) && t.takeProfitPrices.length)) {
    s += 2;
  }
  if (String(t.entryPrice ?? t.entryPriceDisplay ?? "").trim()) s += 1;
  if (t.pnlPct != null && Number.isFinite(Number(t.pnlPct))) s += 1;
  return s;
}

/**
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 */
function pickRicherTodayPnlTrade(a, b) {
  const sa = planCompletenessScore(a);
  const sb = planCompletenessScore(b);
  if (sa !== sb) return sa > sb ? a : b;
  return tradeSignalMs(a) >= tradeSignalMs(b) ? a : b;
}

/**
 * @param {Record<string, unknown>[]} trades
 * @param {number} [windowMs]
 */
export function dedupeTodayPnlTrades(trades, windowMs = TODAY_PNL_SIGNAL_DEDUPE_MS) {
  const win = Number(windowMs) > 0 ? Number(windowMs) : TODAY_PNL_SIGNAL_DEDUPE_MS;
  const sorted = [...trades].sort((a, b) => tradeSignalMs(a) - tradeSignalMs(b));
  /** @type {Record<string, unknown>[]} */
  const kept = [];
  for (const t of sorted) {
    const key = tradeDedupeKey(t);
    const tm = tradeSignalMs(t);
    let merged = false;
    for (let i = 0; i < kept.length; i++) {
      if (tradeDedupeKey(kept[i]) !== key) continue;
      const om = tradeSignalMs(kept[i]);
      if (!tm || !om || Math.abs(tm - om) > win) continue;
      kept[i] = pickRicherTodayPnlTrade(kept[i], t);
      merged = true;
      break;
    }
    if (!merged) kept.push(t);
  }
  return kept.sort((a, b) => tradeSignalMs(b) - tradeSignalMs(a));
}

export function resolveTodayPnlEntryDisplay(card) {
  const ex = executionForDisplayPlan(card);
  const anchor = resolveDisplayEntryAnchor(card, ex);
  const plannedRaw = String(ex.planned?.entryPrice ?? "").trim();

  if (anchor != null && plannedRaw && !isMarketEntryHint(plannedRaw) && !isImplausibleEntryText(plannedRaw, card.symbol)) {
    const s = formatDisplayPrice(anchor);
    return {
      entryPrice: s,
      entryPriceKind: "planned",
      entryPriceDisplay: s ?? "—",
    };
  }

  if (anchor != null) {
    const s = formatDisplayPrice(anchor);
    return {
      entryPrice: s,
      entryPriceKind: "used",
      entryPriceDisplay: s ?? "—",
    };
  }

  const mkt = resolveStoredMarketAtSignal(card);
  if (mkt != null) {
    const s = formatDisplayPrice(mkt);
    return {
      entryPrice: s,
      entryPriceKind: "market_at_signal",
      entryPriceDisplay: s ? `发单市价 ${s}` : "发单市价",
    };
  }

  return {
    entryPrice: null,
    entryPriceKind: "market_at_signal",
    entryPriceDisplay: "发单市价",
  };
}