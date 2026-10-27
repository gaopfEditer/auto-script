/**
 * 卡片价格校验策略：默认 3 小时（加密）；股票采用较长周期（默认 30 天）。
 */
import { config } from "./config.js";

/** @typedef {'1d' | '3h' | '30d'} VerifyMode */
/** @typedef {'crypto' | 'stock' | 'alpha'} AssetClass */

const CRYPTO_BASES = new Set([
  "BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX", "DOT", "MATIC",
  "LINK", "UNI", "LTC", "BCH", "ETC", "FIL", "APT", "ARB", "OP", "SUI",
  "SEI", "TIA", "INJ", "NEAR", "ATOM", "TRX", "SHIB", "PEPE", "WIF",
]);

/**
 * @param {unknown} symbol
 * @param {unknown} parsedJson
 * @param {unknown} execution
 * @param {unknown} [rawContent]
 * @returns {AssetClass}
 */
export function detectAssetClass(symbol, parsedJson, execution, rawContent = "") {
  const p = parsedJson && typeof parsedJson === "object" ? /** @type {Record<string, unknown>} */ (parsedJson) : {};
  const e = execution && typeof execution === "object" ? /** @type {Record<string, unknown>} */ (execution) : {};
  const explicit = String(p.assetClass ?? e.assetClass ?? p.market ?? p.assetType ?? "").toLowerCase();
  if (["stock", "equity", "股票", "a股", "美股", "港股"].includes(explicit)) return "stock";
  if (["alpha", "binance_alpha", "binance-alpha"].includes(explicit)) return "alpha";
  if (["crypto", "cryptocurrency", "合约", "永续"].includes(explicit)) return "crypto";

  const sym = String(symbol ?? "").trim();
  if (/^0x[a-fA-F0-9]{20,}$/i.test(sym) || /^ALPHA_\d+(USDT|USDC)?$/i.test(sym)) {
    return "alpha";
  }

  const upper = sym.toUpperCase();
  const bare = upper.replace(/USDT$|USDC$|BUSD$/, "");
  if (upper.endsWith("USDT") || upper.endsWith("USDC") || upper.endsWith("BUSD")) return "crypto";
  if (CRYPTO_BASES.has(bare)) return "crypto";

  const text = `${rawContent} ${p.note ?? ""} ${p.title ?? ""} ${e.direction ?? ""}`;
  if (/股票|A股|美股|港股|纳斯达克|道琼斯|沪深|上证|深证|恒生/i.test(String(text))) return "stock";
  if (/\balpha\b|币安\s*alpha|合约地址|contract\s*address/i.test(String(text))) return "alpha";

  if (/^[A-Z]{1,5}$/.test(bare) && !CRYPTO_BASES.has(bare)) return "stock";

  return "crypto";
}

/**
 * @param {AssetClass} assetClass
 * @param {unknown} [explicitMode]
 * @returns {VerifyMode}
 */
export function resolveVerifyMode(assetClass, explicitMode) {
  const m = String(explicitMode ?? "").trim().toLowerCase();
  if (m === "1d" || m === "3h" || m === "30d") return m;
  return assetClass === "stock" ? "30d" : "1d";
}

/**
 * @param {VerifyMode} mode
 */
export function getVerifyWindowSpec(mode) {
  if (mode === "30d") {
    const days = config.cardVerifyStockWindowDays;
    return {
      mode: /** @type {VerifyMode} */ ("30d"),
      label: `${days} 天`,
      labelShort: `${days}d`,
      durationMs: days * 24 * 60 * 60 * 1000,
      klineInterval: "1h",
      resultField: "verify1mJson",
      sqlInterval: `${days} DAY`,
    };
  }
  if (mode === "3h") {
    const hours = config.cardVerifyDefaultWindowHours;
    return {
      mode: /** @type {VerifyMode} */ ("3h"),
      label: `${hours} 小时`,
      labelShort: `${hours}h`,
      durationMs: hours * 60 * 60 * 1000,
      klineInterval: "5m",
      resultField: "verify3hJson",
      sqlInterval: `${hours} HOUR`,
    };
  }
  const days = config.cardVerifyCryptoWindowDays;
  return {
    mode: /** @type {VerifyMode} */ ("1d"),
    label: `${days} 天`,
    labelShort: `${days}d`,
    durationMs: days * 24 * 60 * 60 * 1000,
    klineInterval: "5m",
    resultField: "verify3hJson",
    sqlInterval: `${days} DAY`,
  };
}

/**
 * @param {Record<string, unknown>} card
 */
export function getCardVerifyPlan(card) {
  const rawClass = String(card.assetClass ?? card.asset_class ?? "").toLowerCase();
  const assetClass =
    rawClass === "stock" || rawClass === "crypto" || rawClass === "alpha"
      ? /** @type {AssetClass} */ (rawClass)
      : detectAssetClass(
          card.symbol,
          card.parsedJson ?? card.parsed_json,
          card.execution ?? card.execution_json,
          card.rawContent ?? card.raw_content
        );
  const verifyMode = resolveVerifyMode(
    assetClass,
    card.verifyMode ?? card.verify_mode ?? card.parsedJson?.verifyMode
  );
  const window = getVerifyWindowSpec(verifyMode);
  return { assetClass, verifyMode, window };
}

/**
 * @param {VerifyMode} mode
 */
export function verifyModeLabel(mode) {
  return getVerifyWindowSpec(mode).label;
}
