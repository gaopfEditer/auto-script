/**
 * 币安等所常见「千倍/百万倍」合约命名：
 * 1000PEPEUSDT → 展示/跨所查找用 PEPE；币安本所仍用 1000PEPEUSDT。
 */

const QUOTE_RE = /(?:USDT|USDC|BUSD|USD)$/i;
/** 较长前缀优先 */
const MULTIPLIER_PREFIX_RE = /^(1000000|100000|10000|1000|1M)/i;

/** 主流币不做 1000/1M 前缀猜测（Bybit 等会对不存在合约返回 403） */
const NO_MULTIPLIER_BASES = new Set([
  "BTC",
  "ETH",
  "SOL",
  "BNB",
  "XRP",
  "DOGE",
  "ADA",
  "AVAX",
  "LINK",
  "DOT",
  "MATIC",
  "POL",
  "LTC",
  "BCH",
  "ETC",
  "TRX",
  "TON",
  "NEAR",
  "FIL",
  "APT",
  "ARB",
  "OP",
  "SUI",
  "SEI",
  "TIA",
  "INJ",
  "ATOM",
  "XLM",
  "UNI",
  "AAVE",
  "MKR",
  "WBTC",
  "USDC",
  "USDT",
]);

/** @param {string} symbol */
export function stripQuote(symbol) {
  return String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(QUOTE_RE, "");
}

/**
 * 去掉千倍前缀后的基础资产名：1000PEPE → PEPE，1MBABYDOGE → BABYDOGE
 * @param {string} symbol
 */
export function humanBaseAsset(symbol) {
  let base = stripQuote(symbol);
  if (!base) return "";
  const m = base.match(MULTIPLIER_PREFIX_RE);
  if (m && base.length > m[1].length) {
    base = base.slice(m[1].length);
  }
  return base;
}

/** @param {string} symbol @returns {string} 如 PEPEUSDT */
export function humanUsdtSymbol(symbol) {
  const base = humanBaseAsset(symbol);
  return base ? `${base}USDT` : "";
}

/** 主流 U 本位永续：不走 Binance Alpha 兜底 */
export function isMainstreamFuturesBase(symbol) {
  return NO_MULTIPLIER_BASES.has(humanBaseAsset(symbol));
}

/** @param {string} symbol @returns {string} 规范为 *USDT */
export function toUsdtSymbol(symbol) {
  const s = String(symbol ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return "";
  if (/USDT$|USDC$|BUSD$/.test(s)) return s.replace(/USDC$|BUSD$/, "USDT");
  return `${s}USDT`;
}

/**
 * 跨所 K 线/行情查找候选。
 * OKX/Bitget/Gate 常用人类名 PEPEUSDT；币安/Bybit 常用 1000PEPEUSDT。
 * 人类名会额外尝试 1000/1M 前缀（KORU → 1000KORUSDT）。
 * @param {string} symbol
 * @param {"binance"|"bybit"|"okx"|"bitget"|"gate"|string} [venue]
 * @param {{ conservative?: boolean }} [opts]
 */
export function symbolLookupCandidates(symbol, venue = "binance", opts = {}) {
  const raw = toUsdtSymbol(symbol);
  const human = humanUsdtSymbol(raw);
  const preferHuman = venue === "okx" || venue === "bitget" || venue === "gate";
  const conservative = Boolean(opts.conservative);
  /** @type {string[]} */
  const multis = [];
  const base = humanBaseAsset(raw);
  const alreadyMulti = MULTIPLIER_PREFIX_RE.test(stripQuote(raw));
  if (base && !alreadyMulti && !NO_MULTIPLIER_BASES.has(base)) {
    /** OKX/Bitget/Gate 用人类名；Binance/Bybit 不试 1M/1000000（大量 Invalid Symbol） */
    let prefixes = [];
    if (!preferHuman) {
      if (conservative || base.length <= 5) {
        prefixes = ["1000"];
      } else {
        prefixes = ["1000", "10000", "100000"];
      }
    }
    for (const p of prefixes) {
      multis.push(`${p}${base}USDT`);
    }
  }
  /** @type {string[]} */
  const ordered = preferHuman ? [human, raw, ...multis] : [raw, human, ...multis];
  /** @type {string[]} */
  const out = [];
  for (const s of ordered) {
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
