/**
 * 卡片评价默认杠杆：XAU 50x · BTC/ETH 100x · 其余 20x。
 */
import { resolveStatsLeverage } from "./card-symbol-leverage.js";

/**
 * @param {unknown} symbol
 * @param {unknown} [assetClass]
 * @returns {number}
 */
export function resolveEvalLeverage(symbol, assetClass) {
  return resolveStatsLeverage(symbol, assetClass);
}

/** @returns {{ major: number, gold: number, altcoin: number }} */
export function getEvalLeverageConfig() {
  return {
    major: resolveStatsLeverage("BTC"),
    gold: resolveStatsLeverage("XAU"),
    altcoin: resolveStatsLeverage("DOGE"),
  };
}
