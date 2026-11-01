/**
 * 回溯卡片/回测结果质量：多币种营销、盈亏离谱、入场与市价偏离。
 */
import { config } from "./config.js";
import { humanBaseAsset } from "./symbol-aliases.js";

const USDT_PAIR_RE = /#?([A-Z0-9]{2,12})USDT\b/gi;
const MIXED_PROMO_RE =
  /VIP|内部群|涨幅榜|长期共赢|每单精确|从不模糊喊单|193[,.]?\d+\s*%|🚀|💵|📉/i;

export function maxAbsBackfillPnlPct() {
  const n = Number(config.telegramBackfillMaxAbsPnlPct);
  return Number.isFinite(n) && n > 0 ? n : 600;
}

export function maxEntryMarketRatio() {
  const n = Number(config.telegramBackfillMaxEntryMarketRatio);
  return Number.isFinite(n) && n > 1 ? n : 3;
}

/** @param {string} text */
export function mentionedUsdtBases(text) {
  /** @type {Set<string>} */
  const bases = new Set();
  const s = String(text ?? "");
  for (const m of s.matchAll(USDT_PAIR_RE)) {
    const b = String(m[1] ?? "").trim().toUpperCase();
    if (b && !["USDT", "USDC", "BUSD", "USD"].includes(b)) bases.add(b);
  }
  return bases;
}

/** @param {Record<string, unknown>} card */
export function isPollutedBackfillCard(card) {
  const preview = String(card.preview ?? card.body ?? card.raw_content ?? "");
  const symBase = humanBaseAsset(String(card.symbol ?? ""));
  const bases = mentionedUsdtBases(preview);
  if (bases.size >= 2) return true;
  if (symBase && bases.size === 1 && !bases.has(symBase)) return true;
  if (MIXED_PROMO_RE.test(preview) && (bases.size >= 1 || /#\w+USDT/i.test(preview))) {
    return true;
  }
  return false;
}

/**
 * @param {Array<Record<string, unknown>>} cards
 */
export function filterQualityBackfillCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.filter((c) => c && typeof c === "object" && !isPollutedBackfillCard(c));
}

/** @param {Record<string, unknown> | null | undefined} item */
export function isBackfillKlineMiss(item) {
  if (!item || typeof item !== "object") return false;
  if (item.klineFailed) return true;
  const err = String(item.error ?? item.errorDetail ?? "");
  return /K线暂缺|K线全部|FUTURES_ALL|no_klines/i.test(err);
}

/**
 * @param {Record<string, unknown>} signal
 * @param {Record<string, unknown>} outcome
 */
export function sanitizeBacktestOutcome(signal, outcome) {
  if (!outcome || typeof outcome !== "object") return outcome;
  if (!outcome.entered) return outcome;

  const flat = outcome.flat ?? outcome.backtest ?? outcome;
  const pnl = Number(outcome.pnlPct ?? flat?.pnlPct);
  const maxPnl = maxAbsBackfillPnlPct();

  if (Number.isFinite(pnl) && Math.abs(pnl) > maxPnl) {
    return invalidateOutcome(outcome, "pnl_outlier", `盈亏超阈值 (|${pnl.toFixed(0)}|% > ${maxPnl}%)`);
  }

  const entry = Number(outcome.entryPriceUsed ?? flat?.entryPriceUsed ?? signal.entry);
  const mkt = Number(outcome.marketAtSignal ?? flat?.marketAtSignal);
  const ratioMax = maxEntryMarketRatio();
  if (Number.isFinite(entry) && entry > 0 && Number.isFinite(mkt) && mkt > 0) {
    const ratio = entry / mkt;
    if (ratio > ratioMax || ratio < 1 / ratioMax) {
      return invalidateOutcome(
        outcome,
        "entry_market_mismatch",
        `入场价与信号市价偏离过大 (${entry} vs ${mkt})`,
      );
    }
  }

  const stopLoss = Number(signal.stopLoss ?? flat?.sl ?? flat?.stopLoss);
  const entryUsed = Number(outcome.entryPriceUsed ?? flat?.entryPriceUsed ?? entry);
  if (Number.isFinite(stopLoss) && stopLoss > 0 && Number.isFinite(entryUsed) && entryUsed > 0) {
    const slDist = Math.abs(stopLoss - entryUsed) / entryUsed;
    if (slDist > 2.5) {
      return invalidateOutcome(outcome, "stop_loss_implausible", "止损相对入场偏离过大");
    }
  }

  if (isPollutedBackfillCard(signal)) {
    return invalidateOutcome(outcome, "polluted_signal", "多币种/营销混排消息");
  }

  return outcome;
}

/**
 * @param {Record<string, unknown>} outcome
 * @param {string} code
 * @param {string} message
 */
function invalidateOutcome(outcome, code, message) {
  return {
    ...outcome,
    entered: false,
    outcome: "error",
    pnlPct: null,
    pnlLabel: null,
    error: message,
    backtestInvalid: true,
    backtestInvalidCode: code,
  };
}
