/**
 * 今日盈亏页：展示口径（不写库、不改下单），过滤错符号计划、对齐方向与标签。
 */
import { isShortDirection } from "./card-direction.js";
import { parseProgressJson, resolveProgressLeverage } from "./card-level-progress.js";
import { parseEntryPrice, parsePrice } from "./card-price-fetch.js";
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
export function sanitizeDisplayTpsl(card, raw) {
  const ex = executionForDisplayPlan(card);
  const prog = parseProgressJson(card.progress);
  const sym = String(card.symbol ?? ex.symbol ?? "").trim();

  let anchor =
    Number(prog?.entryPriceUsed) > 0
      ? Number(prog.entryPriceUsed)
      : parseEntryPrice(ex.planned?.entryPrice);

  if (isImplausibleEntryText(ex.planned?.entryPrice, sym)) {
    const fromProg = Number(prog?.entryPriceUsed);
    anchor = Number.isFinite(fromProg) && fromProg > 0 ? fromProg : null;
  }

  const slRaw = raw.stopLossPrice;
  let stopLossPrice = slRaw;
  const slNum = parsePrice(slRaw);
  if (slNum != null) {
    const okScale = priceSaneForSymbol(sym, slNum);
    const okAnchor = anchor == null || levelNearAnchor(anchor, slNum, 3);
    if (!okScale || !okAnchor) stopLossPrice = null;
  }

  const takeProfitPrices = [];
  for (const p of raw.takeProfitPrices ?? []) {
    const n = parsePrice(p);
    if (n == null) continue;
    if (!priceSaneForSymbol(sym, n)) continue;
    if (anchor != null && !levelNearAnchor(anchor, n, 3)) continue;
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
    if (fromParsed.planned) {
      const sl2 = String(fromParsed.planned.stopLossPrice ?? "").trim();
      const tps2 = (fromParsed.planned.takeProfitPrices ?? [])
        .map((x) => String(x ?? "").trim())
        .filter(Boolean);
      const slNum2 = parsePrice(sl2);
      if (!out.stopLossPrice && slNum2 != null && priceSaneForSymbol(sym, slNum2)) {
        if (anchor == null || levelNearAnchor(anchor, slNum2, 3)) out.stopLossPrice = sl2;
      }
      if (!out.takeProfitPrices.length) {
        for (const p of tps2) {
          const n = parsePrice(p);
          if (n == null) continue;
          if (!priceSaneForSymbol(sym, n)) continue;
          if (anchor != null && !levelNearAnchor(anchor, n, 3)) continue;
          out.takeProfitPrices.push(p);
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
    const saneEntry = Number(prog?.entryPriceUsed);
    if (!Number.isFinite(saneEntry) || saneEntry <= 0) return null;
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
 * @param {Record<string, unknown>} card
 */
export function resolveMarkEntryPriceForDisplay(card) {
  const prog = parseProgressJson(card.progress);
  const fromProg = Number(prog?.entryPriceUsed);
  if (Number.isFinite(fromProg) && fromProg > 0) return fromProg;
  const ex = executionForDisplayPlan(card);
  const raw = ex.planned?.entryPrice;
  if (isImplausibleEntryText(raw, card.symbol)) return null;
  const parsed = parseEntryPrice(raw);
  if (parsed == null) return null;
  if (!priceSaneForSymbol(card.symbol, parsed)) return null;
  return parsed;
}