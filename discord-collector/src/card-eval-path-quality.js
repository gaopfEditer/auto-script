/**
 * 本地路径评估：剔除明显错误的卡片（错标品种、pnl% 爆炸、异常杠杆）。
 */
import { parseProgressJson } from "./card-level-progress.js";
import { parseEntryPrice } from "./card-price-fetch.js";

export const EVAL_PATH_PNL_ABS_MAX = 1_500;
export const EVAL_PATH_LEVERAGE_ABS_MAX = 125;

/** @param {Record<string, unknown>} card */
function cardSymbolBare(card) {
  return String(card.symbol ?? "")
    .toUpperCase()
    .trim()
    .replace(/(USDT|USDC|BUSD)$/, "");
}

/** @param {number | null} entry @param {string} bare */
function entryMismatchBare(entry, bare) {
  if (entry == null || !Number.isFinite(entry)) return false;
  const goldBand = entry >= 500 && entry <= 15_000;
  if ((bare === "BTC" || bare === "ETH") && goldBand) return true;
  if (bare === "BTC" && entry > 0 && entry < 0.05) return true;
  if (/^(XAU|XAG|GOLD|PAXG)$/i.test(bare) && entry > 80_000) return true;
  if (/^(XAU|XAG|GOLD|PAXG)$/i.test(bare) && entry > 0 && entry < 5) return true;
  return false;
}

/**
 * @param {Record<string, unknown>} card
 * @returns {{ code: string, detail: string } | null}
 */
export function evalCardPathQualityIssue(card) {
  const progress = parseProgressJson(card.progress ?? card.progress_json);
  const backtest = card.backtest && typeof card.backtest === "object" ? card.backtest : null;
  let pnl = progress?.pnlPct;
  if (pnl == null && backtest) pnl = backtest.pnl ?? backtest.pnlPct;
  const pnlN = Number(pnl);
  if (Number.isFinite(pnlN) && Math.abs(pnlN) > EVAL_PATH_PNL_ABS_MAX) {
    return { code: "pnl_outlier", detail: `pnlPct=${pnlN}` };
  }

  const lev = Number(progress?.leverage);
  if (Number.isFinite(lev) && lev > EVAL_PATH_LEVERAGE_ABS_MAX) {
    return { code: "leverage_outlier", detail: `${lev}x` };
  }

  const bare = cardSymbolBare(card);
  const parsed =
    card.parsedJson && typeof card.parsedJson === "object"
      ? /** @type {Record<string, unknown>} */ (card.parsedJson)
      : null;
  const ex = card.execution && typeof card.execution === "object" ? card.execution : null;
  const planned = ex?.planned && typeof ex.planned === "object" ? ex.planned : null;
  const entryRaw = parsed?.entry ?? planned?.entryPrice ?? card.entry;
  const entry = parseEntryPrice(String(entryRaw ?? ""));
  if (entryMismatchBare(entry, bare)) {
    return { code: "symbol_entry_mismatch", detail: `${bare} entry≈${entry}` };
  }

  if (bare === "COIN" || bare === "UNKNOWN") {
    return { code: "symbol_invalid", detail: bare };
  }

  return null;
}

/** @param {Record<string, unknown>} card */
export function isCorruptEvalCard(card) {
  return Boolean(evalCardPathQualityIssue(card));
}