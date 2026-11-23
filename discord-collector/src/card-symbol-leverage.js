/**
 * 卡片统计 / 清算默认杠杆：XAU 系 50x，BTC/ETH 100x，其余 20x。
 */
import { config } from "./config.js";

const GOLD_BASES = new Set(["XAU", "XAG", "GOLD", "PAXG"]);
const MAJOR_BASES = new Set(["BTC", "ETH"]);

/**
 * @param {unknown} symbol
 * @param {unknown} [_assetClass] 保留兼容；股票等仍 20x
 * @returns {number}
 */
export function resolveStatsLeverage(symbol, _assetClass) {
  const bare = String(symbol ?? "")
    .toUpperCase()
    .trim()
    .replace(/(USDT|USDC|BUSD)$/, "");
  if (MAJOR_BASES.has(bare)) {
    return Number(config.cardStatsLeverageMajor) || 100;
  }
  if (GOLD_BASES.has(bare)) {
    return Number(config.cardStatsLeverageGold) || 50;
  }
  const ac = String(_assetClass ?? "").toLowerCase();
  if (ac === "stock") return Number(config.cardStatsLeverageAltcoin) || 20;
  return Number(config.cardStatsLeverageAltcoin) || 20;
}