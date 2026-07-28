/**
 * 同博主 + 同币种：10 分钟内数值完全一致则跳过；部分重叠则保留第二条。
 * 文稿 coin-action：1 小时内同币种 + 入场价相近则跳过。
 */
import { normalizeSymbol } from "./card-fields.js";
import { normalizeExecution } from "./discord-signal-execution.js";
import { parseEntryPrices } from "./card-proximity-policy.js";

export const NUMERIC_DEDUP_WINDOW_MS = 10 * 60 * 1000;
/** 文稿解析同步：近 1 小时去重窗口 */
export const COIN_ACTION_DEDUP_WINDOW_MS = 60 * 60 * 1000;
/** 入场价相对偏差 ≤ 该百分比视为相似 */
export const COIN_ACTION_ENTRY_SIMILAR_PCT = 1;

/** @param {string} s */
function extractNumbersFromString(s) {
  const text = String(s ?? "").trim();
  if (!text) return [];
  /** @type {string[]} */
  const nums = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) nums.push(String(n));
  }
  return nums;
}

/** @param {unknown} execution */
export function extractNumericValues(execution) {
  const ex = normalizeExecution(execution);
  const nums = [
    ...extractNumbersFromString(ex.planned.entryPrice),
    ...extractNumbersFromString(ex.planned.stopLossPrice),
    ...ex.planned.takeProfitPrices.flatMap((p) => extractNumbersFromString(p)),
  ];
  return nums.sort((a, b) => Number(a) - Number(b));
}

/** @param {string[]} a @param {string[]} b */
export function numericValuesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * @param {unknown} prevExecution
 * @param {unknown} nextExecution
 * @returns {boolean} true = 应跳过第二条
 */
export function shouldSkipNumericDuplicate(prevExecution, nextExecution) {
  const prevNums = extractNumericValues(prevExecution);
  const nextNums = extractNumericValues(nextExecution);
  if (!prevNums.length || !nextNums.length) return false;
  return numericValuesEqual(prevNums, nextNums);
}

/**
 * 入场价是否相近（区间取中点，相对偏差 ≤ similarPct%）
 * 支持「跌破1890」「突破 12.5」等带前缀文案。
 * @param {unknown} entryA
 * @param {unknown} entryB
 * @param {number} [similarPct]
 */
export function isSimilarEntryPrice(entryA, entryB, similarPct = COIN_ACTION_ENTRY_SIMILAR_PCT) {
  const midA = entryMidPrice(entryA);
  const midB = entryMidPrice(entryB);
  if (midA != null && midB != null && midA > 0 && midB > 0) {
    const pct = (Math.abs(midA - midB) / Math.max(midA, midB)) * 100;
    return pct <= similarPct;
  }
  const sa = String(entryA ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  const sb = String(entryB ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  return Boolean(sa) && sa === sb;
}

/** @param {unknown} entryRaw @returns {number | null} */
function entryMidPrice(entryRaw) {
  const prices = parseEntryPrices(entryRaw);
  if (prices.length) {
    return (Math.min(...prices) + Math.max(...prices)) / 2;
  }
  const nums = extractNumbersFromString(String(entryRaw ?? ""))
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  if (nums.length === 1) return nums[0];
  return (Math.min(...nums) + Math.max(...nums)) / 2;
}

/**
 * @param {unknown} prevExecution
 * @param {unknown} nextExecution
 * @param {number} [similarPct]
 */
export function shouldSkipSimilarCoinAction(prevExecution, nextExecution, similarPct = COIN_ACTION_ENTRY_SIMILAR_PCT) {
  const prev = normalizeExecution(prevExecution);
  const next = normalizeExecution(nextExecution);
  const prevSym = normalizeDedupSymbol(prev.symbol);
  const nextSym = normalizeDedupSymbol(next.symbol);
  if (!prevSym || !nextSym || prevSym !== nextSym) return false;
  return isSimilarEntryPrice(prev.planned.entryPrice, next.planned.entryPrice, similarPct);
}

/** @param {unknown} symbol */
export function normalizeDedupSymbol(symbol) {
  return normalizeSymbol(symbol);
}
