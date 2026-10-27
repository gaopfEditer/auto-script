/**
 * Binance Alpha 行情：代币列表解析 + K 线 / 现价。
 * 文档：https://developers.binance.com/docs/alpha
 * - Token List: /bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list
 * - Klines:     /bapi/defi/v1/public/alpha-trade/klines
 * - Ticker:     /bapi/defi/v1/public/alpha-trade/ticker
 */
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("card-alpha");

const DEFAULT_ALPHA_ORIGIN = "https://www.binance.com";

/** @type {import("undici").Dispatcher | undefined} */
let alphaDispatcher;

function getAlphaDispatcher() {
  const proxy = config.binanceProxy;
  if (!proxy) return undefined;
  if (!alphaDispatcher) alphaDispatcher = new ProxyAgent(proxy);
  return alphaDispatcher;
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function alphaFetch(url, init = {}) {
  const signal = init.signal ?? AbortSignal.timeout(config.binanceRequestTimeoutMs);
  const dispatcher = getAlphaDispatcher();
  if (dispatcher) {
    return undiciFetch(url, { ...init, signal, dispatcher });
  }
  return fetch(url, { ...init, signal });
}

function alphaOrigin() {
  return String(config.binanceAlphaBaseUrl || DEFAULT_ALPHA_ORIGIN).replace(/\/$/, "");
}

/**
 * 合约地址形态：0x + 至少 20 位 hex（兼容短写；标准 EVM 为 40）。
 * @param {unknown} v
 */
export function isAlphaContractAddress(v) {
  const s = String(v ?? "").trim();
  return /^0x[a-fA-F0-9]{20,}$/i.test(s);
}

/**
 * Alpha 交易对：ALPHA_1121 / ALPHA_1121USDT
 * @param {unknown} v
 */
export function isAlphaTradingSymbol(v) {
  return /^ALPHA_\d+(USDT|USDC)?$/i.test(String(v ?? "").trim());
}

/**
 * @param {string} alphaIdOrSymbol 如 ALPHA_1121 / ALPHA_1121USDT
 */
export function toAlphaUsdtSymbol(alphaIdOrSymbol) {
  const s = String(alphaIdOrSymbol ?? "").trim().toUpperCase();
  if (!s) return "";
  if (/USDT$|USDC$/.test(s)) return s.replace(/USDC$/, "USDT");
  if (/^ALPHA_\d+$/.test(s)) return `${s}USDT`;
  return s;
}

/**
 * @typedef {{
 *   alphaId: string,
 *   tradingSymbol: string,
 *   symbol: string,
 *   name: string,
 *   contractAddress: string,
 *   chainId: string,
 *   chainName: string,
 *   price: number | null,
 *   volume24h: number,
 *   offline: boolean,
 * }} AlphaTokenInfo
 */

/** @type {{ at: number, tokens: AlphaTokenInfo[], byContract: Map<string, AlphaTokenInfo>, byAlphaId: Map<string, AlphaTokenInfo>, byTicker: Map<string, AlphaTokenInfo[]> } | null} */
let tokenCache = null;

function tokenListTtlMs() {
  return Math.max(60_000, Number(config.binanceAlphaTokenListTtlMs) || 600_000);
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {AlphaTokenInfo | null}
 */
function normalizeToken(raw) {
  if (!raw || typeof raw !== "object") return null;
  const alphaId = String(raw.alphaId ?? "").trim().toUpperCase();
  const contractAddress = String(raw.contractAddress ?? "").trim();
  const symbol = String(raw.symbol ?? "").trim().toUpperCase();
  if (!alphaId && !contractAddress && !symbol) return null;
  const id = alphaId || (symbol ? `ALPHA_${symbol}` : "");
  const tradingSymbol = toAlphaUsdtSymbol(id.startsWith("ALPHA_") ? id : alphaId);
  const priceN = Number(raw.price);
  const volN = Number(raw.volume24h);
  return {
    alphaId: id,
    tradingSymbol: tradingSymbol || (symbol ? `${symbol}USDT` : ""),
    symbol,
    name: String(raw.name ?? ""),
    contractAddress,
    chainId: String(raw.chainId ?? ""),
    chainName: String(raw.chainName ?? ""),
    price: Number.isFinite(priceN) && priceN > 0 ? priceN : null,
    volume24h: Number.isFinite(volN) ? volN : 0,
    offline: Boolean(raw.offline || raw.fullyDelisted || raw.offsell),
  };
}

/**
 * @param {boolean} [force]
 */
export async function loadAlphaTokenList(force = false) {
  const now = Date.now();
  if (!force && tokenCache && now - tokenCache.at < tokenListTtlMs()) {
    return tokenCache;
  }
  const url = `${alphaOrigin()}/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list`;
  const res = await alphaFetch(url);
  if (!res.ok) throw new Error(`Alpha token list HTTP ${res.status}`);
  const body = await res.json();
  const rawList = Array.isArray(body?.data) ? body.data : [];
  /** @type {AlphaTokenInfo[]} */
  const tokens = [];
  /** @type {Map<string, AlphaTokenInfo>} */
  const byContract = new Map();
  /** @type {Map<string, AlphaTokenInfo>} */
  const byAlphaId = new Map();
  /** @type {Map<string, AlphaTokenInfo[]>} */
  const byTicker = new Map();

  for (const raw of rawList) {
    const t = normalizeToken(/** @type {Record<string, unknown>} */ (raw));
    if (!t) continue;
    tokens.push(t);
    if (t.alphaId) byAlphaId.set(t.alphaId, t);
    if (t.contractAddress) byContract.set(t.contractAddress.toLowerCase(), t);
    if (t.symbol) {
      const arr = byTicker.get(t.symbol) || [];
      arr.push(t);
      byTicker.set(t.symbol, arr);
    }
  }

  tokenCache = { at: now, tokens, byContract, byAlphaId, byTicker };
  log.info(`Alpha 代币列表已加载 n=${tokens.length}`);
  return tokenCache;
}

/**
 * 按合约地址 / ALPHA_id / 交易对 / ticker 解析 Alpha 代币。
 * @param {unknown} query
 * @returns {Promise<AlphaTokenInfo | null>}
 */
export async function resolveAlphaToken(query) {
  const raw = String(query ?? "").trim();
  if (!raw) return null;
  const cache = await loadAlphaTokenList();

  if (isAlphaContractAddress(raw)) {
    return cache.byContract.get(raw.toLowerCase()) || null;
  }

  const upper = raw.toUpperCase();
  if (isAlphaTradingSymbol(upper)) {
    const id = upper.replace(/USDT$|USDC$/, "");
    const hit = cache.byAlphaId.get(id);
    if (hit) return hit;
    return {
      alphaId: id,
      tradingSymbol: toAlphaUsdtSymbol(id),
      symbol: id,
      name: "",
      contractAddress: "",
      chainId: "",
      chainName: "",
      price: null,
      volume24h: 0,
      offline: false,
    };
  }

  const bare = upper.replace(/USDT$|USDC$|BUSD$/, "");
  const byId = cache.byAlphaId.get(bare) || cache.byAlphaId.get(upper);
  if (byId) return byId;

  const candidates = (cache.byTicker.get(bare) || []).filter((t) => !t.offline);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.volume24h - a.volume24h);
  return candidates[0];
}

/**
 * @param {string} tradingSymbol
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} [interval]
 */
export async function fetchAlphaKlines(tradingSymbol, startMs, endMs, interval = "5m") {
  const sym = toAlphaUsdtSymbol(tradingSymbol);
  if (!sym) throw new Error("missing Alpha trading symbol");
  const origin = alphaOrigin();
  /** @type {Array<{ open: number, high: number, low: number, close: number, ts: number }>} */
  const all = [];
  let cursor = Math.floor(startMs);
  const end = Math.floor(endMs);
  let guard = 0;
  while (cursor < end && guard < 40) {
    guard += 1;
    const params = new URLSearchParams({
      symbol: sym,
      interval,
      startTime: String(cursor),
      endTime: String(end),
      limit: "500",
    });
    const url = `${origin}/bapi/defi/v1/public/alpha-trade/klines?${params}`;
    const res = await alphaFetch(url);
    if (!res.ok) throw new Error(`Alpha klines HTTP ${res.status} ${sym}`);
    const body = await res.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    if (!rows.length) break;
    let lastTs = cursor;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const ts = Number(row[0]);
      const open = Number(row[1]);
      const high = Number(row[2]);
      const low = Number(row[3]);
      const close = Number(row[4]);
      if (!Number.isFinite(ts) || !Number.isFinite(high) || !Number.isFinite(low)) continue;
      all.push({ ts, open, high, low, close });
      lastTs = ts;
    }
    const next = lastTs + 1;
    if (next <= cursor) break;
    cursor = next;
    if (rows.length < 500) break;
  }
  return all.sort((a, b) => a.ts - b.ts);
}

/**
 * @param {unknown} query 合约地址 / ALPHA_id / ticker
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} [interval]
 */
export async function fetchAlphaKlinesForQuery(query, startMs, endMs, interval = "5m") {
  const token = await resolveAlphaToken(query);
  if (!token?.tradingSymbol) {
    throw new Error(`Alpha 未找到代币: ${String(query ?? "")}`);
  }
  const klines = await fetchAlphaKlines(token.tradingSymbol, startMs, endMs, interval);
  return { token, klines };
}

/**
 * @param {unknown} query
 */
export async function fetchAlphaPrice(query) {
  const token = await resolveAlphaToken(query);
  if (!token?.tradingSymbol) throw new Error(`Alpha 未找到代币: ${String(query ?? "")}`);
  const sym = token.tradingSymbol;
  const url = `${alphaOrigin()}/bapi/defi/v1/public/alpha-trade/ticker?symbol=${encodeURIComponent(sym)}`;
  const res = await alphaFetch(url);
  if (!res.ok) throw new Error(`Alpha ticker HTTP ${res.status}`);
  const body = await res.json();
  const data = body?.data && typeof body.data === "object" ? body.data : {};
  const price = Number(data.lastPrice ?? data.price ?? token.price);
  if (!Number.isFinite(price) || price <= 0) {
    if (token.price) return { symbol: sym, price: token.price, token, market: /** @type {const} */ ("alpha") };
    throw new Error(`Alpha 无有效价格 ${sym}`);
  }
  return { symbol: sym, price, token, market: /** @type {const} */ ("alpha") };
}
