/**
 * 山寨之王 / seven 分阶段交易：市价开仓 → 20 分钟内 TP/SL 补充 → 分批止盈；5 分钟内反手。
 */
import { normalizeSymbol } from "./card-fields.js";
import { shouldSkipNumericDuplicate } from "./discord-signal-numeric-dedup.js";

export const STAGED_SYMBOL_DEDUP_MS = 4 * 60 * 60 * 1000;
export const STAGED_REVERSE_WINDOW_MS = 5 * 60 * 1000;
/** 开仓后补 TP/SL 的关联窗口（山寨之王常见 20 分钟内补发） */
export const STAGED_TPSL_LINK_MS = 20 * 60 * 1000;
export const STAGED_INITIAL_SL_PCT = 4.3;
export const STAGED_TP_PARTIAL_RATIOS = [0.3, 0.3, 1];

/** @type {Set<string>} */
export const STAGED_TRADE_PARSERS = new Set(["altcoin_king", "tw_opg"]);

/** @param {string} channelId */
export function isStagedTradeChannel(channelId) {
  return channelId === "1444963506431463474" || channelId === "1444963372134301827";
}

/** @param {Record<string, unknown> | null | undefined} parsed */
export function isStagedTradeSignal(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (!STAGED_TRADE_PARSERS.has(String(parsed.parser ?? ""))) return false;
  const phase = String(parsed.signalPhase ?? "");
  return phase === "open" || phase === "tpsl" || phase === "full" || parsed.orderMode === "market";
}

/** @param {string} direction */
export function isLongDirection(direction) {
  return /多|long|buy|進多|做多/i.test(String(direction ?? ""));
}

/** @param {string} direction */
export function isShortDirection(direction) {
  return /空|short|sell|進空|做空/i.test(String(direction ?? ""));
}

/** @param {string} a @param {string} b */
export function isOppositeDirection(a, b) {
  return (isLongDirection(a) && isShortDirection(b)) || (isShortDirection(a) && isLongDirection(b));
}

/**
 * @param {number} fillPrice
 * @param {string} direction
 * @param {number} [pct]
 */
export function calcInitialStopLoss(fillPrice, direction, pct = STAGED_INITIAL_SL_PCT) {
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return null;
  const ratio = pct / 100;
  if (isLongDirection(direction)) return Number((fillPrice * (1 - ratio)).toFixed(8));
  if (isShortDirection(direction)) return Number((fillPrice * (1 + ratio)).toFixed(8));
  return null;
}

/** @param {string} size @param {number} ratio */
export function partialSize(size, ratio) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0 || ratio <= 0) return "";
  const raw = n * ratio;
  const decimals = String(size).includes(".") ? (String(size).split(".")[1]?.length ?? 2) : 2;
  const rounded = Number(raw.toFixed(Math.min(decimals, 8)));
  return rounded > 0 ? String(rounded) : "";
}

/** @param {unknown} row */
export function cardRowParsed(row) {
  const raw = row?.parsed_json ?? row?.parsedJson;
  if (!raw) return null;
  if (typeof raw === "object") return /** @type {Record<string, unknown>} */ (raw);
  try {
    return /** @type {Record<string, unknown>} */ (JSON.parse(String(raw)));
  } catch {
    return null;
  }
}

/** @param {unknown} row */
export function cardRowSymbol(row) {
  const sym = row?.symbol ?? cardRowParsed(row)?.symbol;
  return normalizeSymbol(sym);
}

/** @param {unknown} row */
export function cardRowDirection(row) {
  return String(cardRowParsed(row)?.direction ?? "").trim();
}

/** @param {unknown} row */
export function cardAwaitingTpsl(row) {
  const p = cardRowParsed(row);
  if (!p) return false;
  if (p.awaitingTpsl === true) return true;
  const bitget = p.bitgetOrder;
  const weex = p.weexOrder;
  if (bitget && typeof bitget === "object") {
    const bo = /** @type {Record<string, unknown>} */ (bitget);
    if (bo.phase === "open" && (bo.status === "open_placed" || bo.status === "dry_run")) return true;
  }
  if (weex && typeof weex === "object") {
    const wo = /** @type {Record<string, unknown>} */ (weex);
    if (wo.phase === "open" && (wo.status === "open_placed" || wo.status === "dry_run")) return true;
  }
  return p.signalPhase === "open" && !String(p.stopLoss ?? "").trim();
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function preferNonEmpty(a, b) {
  const sa = String(a ?? "").trim();
  const sb = String(b ?? "").trim();
  return sa || sb;
}

/**
 * @param {Record<string, unknown>} prevParsed
 * @param {Record<string, unknown>} tpslParsed
 */
export function mergeStagedParsed(prevParsed, tpslParsed) {
  const nextTps = /** @type {unknown} */ (tpslParsed.takeProfits ?? tpslParsed.targets);
  const prevTps = /** @type {unknown} */ (prevParsed.takeProfits ?? prevParsed.targets);
  const takeProfits = /** @type {string[]} */ (
    Array.isArray(nextTps) && nextTps.length ? nextTps : Array.isArray(prevTps) ? prevTps : []
  );
  const stopLoss = preferNonEmpty(tpslParsed.stopLoss, prevParsed.stopLoss);
  // 开仓消息的方向/币种优先；TP/SL 补充常无币种，方向推断可能反
  const symbol = preferNonEmpty(prevParsed.symbol, tpslParsed.symbol);
  const direction = preferNonEmpty(prevParsed.direction, tpslParsed.direction);
  const entry = preferNonEmpty(prevParsed.entry, tpslParsed.entry);
  // 保留开仓标题；勿被「…TP/SL」空壳标题覆盖
  const tpslTitle = String(tpslParsed.title ?? "").trim();
  const title = preferNonEmpty(
    prevParsed.title,
    /TP\/SL/i.test(tpslTitle) ? "" : tpslTitle
  ) || (symbol ? `${symbol} ${direction}`.trim() : tpslTitle);
  const bitgetOrder = prevParsed.bitgetOrder ?? tpslParsed.bitgetOrder;
  const weexOrder = prevParsed.weexOrder ?? tpslParsed.weexOrder;
  return {
    ...prevParsed,
    ...tpslParsed,
    symbol,
    asset: preferNonEmpty(tpslParsed.asset, prevParsed.asset) || symbol,
    direction,
    entry,
    title,
    takeProfits,
    stopLoss,
    ...(bitgetOrder ? { bitgetOrder } : {}),
    ...(weexOrder ? { weexOrder } : {}),
    signalPhase: "full",
    awaitingTpsl: false,
    orderMode: prevParsed.orderMode ?? tpslParsed.orderMode ?? "market",
  };
}

/** @param {unknown} prevExecution @param {unknown} nextExecution @param {string} prevContent @param {string} nextContent */
export function isStagedDuplicateContent(prevExecution, nextExecution, prevContent, nextContent) {
  if (prevContent && nextContent && prevContent.trim() === nextContent.trim()) return true;
  return shouldSkipNumericDuplicate(prevExecution, nextExecution);
}

/** @param {unknown} raw */
function parsePriceNum(raw) {
  const n = Number(String(raw ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 取 TP1 价格（优先订单 tpPlans / takeProfits，再看 parsed）。
 * @param {Record<string, unknown> | null | undefined} order
 * @param {Record<string, unknown> | null | undefined} [parsed]
 */
export function resolveStagedTp1Price(order, parsed) {
  const plans = order && Array.isArray(order.tpPlans) ? order.tpPlans : [];
  if (plans.length) {
    const p = parsePriceNum(/** @type {Record<string, unknown>} */ (plans[0]).price);
    if (p) return p;
  }
  const tps = order && Array.isArray(order.takeProfits) ? order.takeProfits : [];
  if (tps.length) {
    const p = parsePriceNum(tps[0]);
    if (p) return p;
  }
  const fromParsed = parsed && Array.isArray(parsed.takeProfits) ? parsed.takeProfits : [];
  if (fromParsed.length) {
    const p = parsePriceNum(fromParsed[0]);
    if (p) return p;
  }
  return null;
}

/**
 * 开仓价：优先成交价 fillPrice，其次 initial / entry。
 * @param {Record<string, unknown> | null | undefined} order
 * @param {Record<string, unknown> | null | undefined} [parsed]
 */
export function resolveStagedEntryPrice(order, parsed) {
  for (const raw of [order?.fillPrice, order?.entryPrice, parsed?.entry]) {
    const p = parsePriceNum(raw);
    if (p) return p;
  }
  // entry 可能是区间 "1.2-1.3"
  const entryStr = String(parsed?.entry ?? "").trim();
  if (entryStr.includes("-") || entryStr.includes("~") || entryStr.includes("/")) {
    const parts = entryStr.split(/[-~/]/).map((x) => parsePriceNum(x)).filter(Boolean);
    if (parts.length) {
      return /** @type {number[]} */ (parts).reduce((a, b) => a + b, 0) / parts.length;
    }
  }
  return parsePriceNum(entryStr);
}

/**
 * @param {number} price
 * @param {number} tp1
 * @param {"long"|"short"|string} holdSide
 */
export function isTp1Reached(price, tp1, holdSide) {
  if (!Number.isFinite(price) || !Number.isFinite(tp1) || price <= 0 || tp1 <= 0) return false;
  const hs = String(holdSide ?? "").toLowerCase();
  if (hs === "long" || hs === "buy") return price >= tp1;
  if (hs === "short" || hs === "sell") return price <= tp1;
  return false;
}

/**
 * 卡片是否挂了需 TP1 保本的 Bitget/WEEX 分阶段单。
 * @param {Record<string, unknown> | null | undefined} order
 */
export function needsTp1Breakeven(order) {
  if (!order || typeof order !== "object") return false;
  if (order.breakevenArmed === true || order.slMovedToEntry === true) return false;
  const status = String(order.status ?? "");
  if (status === "failed" || status === "closed" || status === "reversed") return false;
  // 已挂上完整 TP/SL，或至少有 TP1 计划
  const phase = String(order.phase ?? "");
  if (phase === "full" || status === "tpsl_set" || status === "tpsl_partial" || status === "dry_run") {
    return Boolean(resolveStagedTp1Price(order) || (Array.isArray(order.takeProfits) && order.takeProfits.length));
  }
  return false;
}
