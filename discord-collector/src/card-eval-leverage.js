/**
 * 卡片评价默认杠杆：主流 BTC/ETH vs 山寨。
 */
import { detectSymbolTier } from "./card-backtest-policy.js";
import { config } from "./config.js";

/**
 * @param {unknown} symbol
 * @returns {number}
 */
export function resolveEvalLeverage(symbol) {
  const tier = detectSymbolTier(symbol);
  return tier === "major" ? config.cardEvalMajorLeverage : config.cardEvalAltcoinLeverage;
}

/** @returns {{ major: number, altcoin: number }} */
export function getEvalLeverageConfig() {
  return {
    major: config.cardEvalMajorLeverage,
    altcoin: config.cardEvalAltcoinLeverage,
  };
}
