/**
 * 卡片评价默认杠杆：主流 BTC/ETH、黄金、原油 100x；山寨 / 美股 20x。
 */
import { resolveLiquidationLeverage } from "./card-liquidation-engine.js";

/**
 * @param {unknown} symbol
 * @param {unknown} [assetClass]
 * @returns {number}
 */
export function resolveEvalLeverage(symbol, assetClass) {
  return resolveLiquidationLeverage(symbol, assetClass);
}

/** @returns {{ major: number, altcoin: number }} */
export function getEvalLeverageConfig() {
  return {
    major: resolveLiquidationLeverage("BTC"),
    altcoin: resolveLiquidationLeverage("DOGE"),
  };
}
