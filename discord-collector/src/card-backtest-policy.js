/**
 * 分层回测策略：BTC/ETH 主流 vs 山寨；OI Telegram 推送另见 card-telegram-oi-backtest.js。
 */

/** @typedef {'major' | 'altcoin'} SymbolTier */

const MAJOR_BASES = new Set(["BTC", "ETH"]);

/**
 * @param {unknown} symbol
 * @returns {SymbolTier}
 */
export function detectSymbolTier(symbol) {
  const bare = String(symbol ?? "")
    .toUpperCase()
    .trim()
    .replace(/USDT$|USDC$|BUSD$/, "");
  return MAJOR_BASES.has(bare) ? "major" : "altcoin";
}

/**
 * @param {SymbolTier} tier
 */
export function getBacktestSpec(tier) {
  if (tier === "major") {
    const hours = [4, 5, 6, 7, 8];
    return {
      tier: /** @type {SymbolTier} */ ("major"),
      leverage: 100,
      label: "主流 (BTC/ETH)",
      windowDurationsMs: hours.map((h) => h * 60 * 60 * 1000),
      windowLabels: hours.map((h) => `${h}h`),
    minDueMs: 60 * 60 * 1000,
      klineInterval: "5m",
    };
  }
  const minutes = [15, 30, 45, 60, 90, 120, 150, 180];
  return {
    tier: /** @type {SymbolTier} */ ("altcoin"),
    leverage: 30,
    label: "山寨",
    windowDurationsMs: minutes.map((m) => m * 60 * 1000),
    windowLabels: minutes.map((m) => (m >= 60 ? `${m / 60}h` : `${m}m`)),
    minDueMs: 30 * 60 * 1000,
    klineInterval: "5m",
  };
}

/**
 * @param {unknown} symbol
 * @param {unknown} [assetClass]
 */
export function getCardBacktestPlan(symbol, assetClass) {
  const ac = String(assetClass ?? "crypto").toLowerCase();
  if (ac === "stock") {
    return { skip: true, reason: "stock" };
  }
  // alpha 与合约同走加密回测规则（山寨档）；K 线源由 card-price-fetch 路由
  const tier = detectSymbolTier(symbol);
  const spec = getBacktestSpec(tier);
  return { skip: false, tier, spec, assetClass: ac === "alpha" ? "alpha" : "crypto" };
}

/**
 * @param {SymbolTier} tier
 */
export function backtestTierLabel(tier) {
  return tier === "major" ? "主流 BTC/ETH · 100x · 4h–8h" : "山寨 · 30x · 15m–3h";
}
