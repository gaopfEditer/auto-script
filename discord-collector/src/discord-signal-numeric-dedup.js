/**
 * 同博主 + 同币种：10 分钟内数值完全一致则跳过；部分重叠则保留第二条。
 */
import { normalizeSymbol } from "./card-fields.js";
import { normalizeExecution } from "./discord-signal-execution.js";

export const NUMERIC_DEDUP_WINDOW_MS = 10 * 60 * 1000;

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

/** @param {unknown} symbol */
export function normalizeDedupSymbol(symbol) {
  return normalizeSymbol(symbol);
}
