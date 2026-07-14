/**
 * 山寨之王 / seven 分阶段交易：市价开仓 → 10 分钟内 TP/SL 补充 → 分批止盈；5 分钟内反手。
 */
import { normalizeSymbol } from "./card-fields.js";
import { shouldSkipNumericDuplicate } from "./discord-signal-numeric-dedup.js";

export const STAGED_SYMBOL_DEDUP_MS = 4 * 60 * 60 * 1000;
export const STAGED_REVERSE_WINDOW_MS = 5 * 60 * 1000;
export const STAGED_TPSL_LINK_MS = 10 * 60 * 1000;
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
 * @param {Record<string, unknown>} prevParsed
 * @param {Record<string, unknown>} tpslParsed
 */
export function mergeStagedParsed(prevParsed, tpslParsed) {
  const takeProfits = /** @type {string[]} */ (
    tpslParsed.takeProfits ?? tpslParsed.targets ?? prevParsed.takeProfits ?? []
  );
  const stopLoss = String(tpslParsed.stopLoss ?? prevParsed.stopLoss ?? "").trim();
  const symbol = String(tpslParsed.symbol ?? prevParsed.symbol ?? "").trim();
  const direction = String(tpslParsed.direction ?? prevParsed.direction ?? "").trim();
  const bitgetOrder = prevParsed.bitgetOrder ?? tpslParsed.bitgetOrder;
  const weexOrder = prevParsed.weexOrder ?? tpslParsed.weexOrder;
  return {
    ...prevParsed,
    ...tpslParsed,
    symbol,
    direction,
    takeProfits,
    stopLoss,
    ...(bitgetOrder ? { bitgetOrder } : {}),
    ...(weexOrder ? { weexOrder } : {}),
    signalPhase: "full",
    awaitingTpsl: false,
    orderMode: prevParsed.orderMode ?? "market",
  };
}

/** @param {unknown} prevExecution @param {unknown} nextExecution @param {string} prevContent @param {string} nextContent */
export function isStagedDuplicateContent(prevExecution, nextExecution, prevContent, nextContent) {
  if (prevContent && nextContent && prevContent.trim() === nextContent.trim()) return true;
  return shouldSkipNumericDuplicate(prevExecution, nextExecution);
}
