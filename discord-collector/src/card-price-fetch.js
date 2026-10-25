/**
 * 永续 K 线 / 现价（清算、批量回溯、接近推送）。
 * 默认 binance → bybit → okx；451/418/403 等区域限制会自动换源（CARD_KLINE_SOURCES 可调顺序或跳过币安）。
 */
import "./load-env.js";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { config } from "./config.js";
import { isShortDirection } from "./card-direction.js";
import { createLogger } from "./logger.js";
import {
  fetchAlphaKlinesForQuery,
  fetchAlphaPrice,
  isAlphaContractAddress,
  isAlphaTradingSymbol,
} from "./card-alpha-market.js";
import {
  humanBaseAsset,
  isMainstreamFuturesBase,
  symbolLookupCandidates,
  toUsdtSymbol,
} from "./symbol-aliases.js";

const log = createLogger("card-price");

const DEFAULT_LEVERAGE = () => Number(config.cardVerifyLeverage) || 100;

const BYBIT_BASE = "https://api.bybit.com";
const OKX_BASE = "https://www.okx.com";
const GATE_BASE = "https://api.gateio.ws";

/** @type {Record<string, string>} */
const BITGET_GRAN = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
};

const MARKET_UA =
  "Mozilla/5.0 (compatible; discord-collector/1.0; +https://github.com/local/card-price)";

/** @type {Record<string, string>} */
const BYBIT_INTERVAL = {
  "1m": "1",
  "3m": "3",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "2h": "120",
  "4h": "240",
  "1d": "D",
};

/** @type {Record<string, number>} */
const INTERVAL_MS = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/** 币安 K 线 418/451 等后本轮进程内跳过后续币安 K 线请求 */
let binanceKlineBlocked = false;

/** 批量回溯开始前调用，避免上次 451 导致整次任务永久跳过币安 */
export function resetBinanceKlineBlockForBacktest() {
  binanceKlineBlocked = false;
}

/** @returns {Array<"binance"|"bybit"|"okx"|"bitget"|"gate">} */
function klineSourceOrder() {
  const list = config.cardKlineSources;
  if (Array.isArray(list) && list.length) {
    return /** @type {Array<"binance"|"bybit"|"okx"|"bitget"|"gate">} */ ([...list]);
  }
  return ["binance", "bybit", "bitget", "gate", "okx"];
}

/** 回溯 batch 回测优先 binance/bybit */
function backfillKlineSourceOrder() {
  const list = config.telegramBackfillKlineSources;
  const base =
    Array.isArray(list) && list.length
      ? /** @type {Array<"binance"|"bybit"|"okx"|"bitget"|"gate">} */ ([...list])
      : klineSourceOrder();
  if (!config.binanceProxy) return base;
  const prefer = ["binance", "bybit"];
  const head = prefer.filter((s) => base.includes(s));
  const tail = base.filter((s) => !prefer.includes(s));
  return [...head, ...tail];
}

/** @param {unknown} raw */
function normalizeKlineTs(raw) {
  const ts = Number(raw);
  if (!Number.isFinite(ts)) return NaN;
  if (ts > 0 && ts < 1e12) return Math.round(ts * 1000);
  return ts;
}

/** 回溯/批量评价并发拉 K 线时串行，避免打满各所限速 */
/** @type {Promise<unknown>} */
let klineFetchChain = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withKlineFetchMutex(fn) {
  const run = klineFetchChain.then(fn, fn);
  klineFetchChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** @param {number} ms */
async function klineFetchGap(ms) {
  const gap = Math.max(0, Number(config.cardKlineMinIntervalMs) || 0);
  if (gap <= 0) return;
  await new Promise((r) => setTimeout(r, gap));
}

let klineProxyLogged = false;
let klineWarnUntil = 0;
let klineWarnLeft = 8;

/** @param {string} msg */
function klineWarnThrottled(msg) {
  const now = Date.now();
  if (now > klineWarnUntil) {
    klineWarnUntil = now + 60_000;
    klineWarnLeft = 8;
  }
  if (klineWarnLeft <= 0) return;
  klineWarnLeft -= 1;
  log.warn(msg);
}

function logKlineProxyOnce() {
  if (klineProxyLogged) return;
  klineProxyLogged = true;
  log.info(`K线 HTTP 代理：${config.binanceProxy || "未配置（直连）"}`);
}

/** @param {string} msg */
function isVenueAccessBlock(msg) {
  return /418|429|403|451|restricted location|Eligibility|b\. Eligibility|Forbidden|CloudFront/i.test(
    msg,
  );
}

/** @param {string} msg */
function isBinanceKlineHardBlock(msg) {
  return isVenueAccessBlock(msg);
}

/** @param {string} msg */
function isInvalidFuturesSymbolError(msg) {
  return (
    /400|Invalid symbol|invalid symbol|-1121|symbol not found|not exist|Instrument ID|doesn't exist/i.test(
      msg,
    )
  );
}

/** @type {import("undici").Dispatcher | undefined} */
let marketDispatcher;

function getMarketDispatcher() {
  const proxy = config.binanceProxy;
  if (!proxy) return undefined;
  if (!marketDispatcher) marketDispatcher = new ProxyAgent(proxy);
  return marketDispatcher;
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function marketFetch(url, init = {}) {
  const maxAttempts = Math.max(1, Number(config.cardKlineFetchMaxAttempts) || 3);
  const headers = {
    "User-Agent": MARKET_UA,
    Accept: "application/json",
    ...(init.headers && typeof init.headers === "object" ? init.headers : {}),
  };
  const dispatcher = getMarketDispatcher();
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const signal = init.signal ?? AbortSignal.timeout(config.binanceRequestTimeoutMs);
    try {
      const res = dispatcher
        ? await undiciFetch(url, { ...init, signal, headers, dispatcher })
        : await fetch(url, { ...init, signal, headers });
      if (res.status === 429 && attempt + 1 < maxAttempts) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800 * (attempt + 1);
        log.warn(`行情 429，${waitMs}ms 后重试 (${attempt + 1}/${maxAttempts})`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      const msg = String(/** @type {Error} */ (e).message ?? e);
      if (/429|rate limit|too many/i.test(msg) && attempt + 1 < maxAttempts) {
        const waitMs = 800 * (attempt + 1);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "marketFetch failed"));
}

function bitgetBaseUrl() {
  return String(config.bitgetBaseUrl ?? "https://api.bitget.com").replace(/\/$/, "");
}

/** @param {string} symbol */
function normalizeUsdtSymbol(symbol) {
  return toUsdtSymbol(symbol);
}

/** @param {string} symbol 已是 USDT 永续名，如 EPICUSDT / 1000COTIUSDT */
function symbolToOkxSwap(symbol) {
  const sym = normalizeUsdtSymbol(symbol);
  const base = sym.replace(/USDT$/i, "");
  return base ? `${base}-USDT-SWAP` : "";
}

/** @param {string} interval */
function intervalSpanMs(interval) {
  return INTERVAL_MS[interval] ?? 300_000;
}

/** K 线 [ts, ts+span) 与 [startMs, endMs) 有交集（避免 start 带秒导致整段被滤空） */
function klineOpenInRange(ts, startMs, endMs, interval) {
  const span = intervalSpanMs(interval);
  const start = Math.floor(startMs);
  const end = Math.floor(endMs);
  return Number.isFinite(ts) && ts + span > start && ts < end;
}

/**
 * @param {string} symbol 如 BTC 或 BTCUSDT
 */
export async function fetchFuturesPrice(symbol) {
  const candidates = symbolLookupCandidates(symbol, "binance");
  let lastErr = null;
  let binanceBlocked = false;
  for (const sym of candidates) {
    try {
      const base = config.binanceFapiUrl.replace(/\/$/, "");
      const url = `${base}/fapi/v1/ticker/price?symbol=${encodeURIComponent(sym)}`;
      const res = await marketFetch(url);
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new Error(`Binance price HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 80)}` : ""}`);
      }
      const data = await res.json();
      return { symbol: sym, price: Number(data.price), source: "binance" };
    } catch (e) {
      lastErr = e;
      const msg = String(/** @type {Error} */ (e).message ?? e);
      if (isBinanceKlineHardBlock(msg)) binanceBlocked = true;
      else if (!isInvalidFuturesSymbolError(msg)) binanceBlocked = true;
    }
  }
  if (binanceBlocked || lastErr) {
    for (const source of klineSourceOrder().filter((s) => s !== "binance")) {
      const syms = symbolLookupCandidates(symbol, source);
      for (const sym of syms) {
        try {
          if (source === "bybit") {
            const url = `${BYBIT_BASE}/v5/market/tickers?category=linear&symbol=${encodeURIComponent(sym)}`;
            const res = await marketFetch(url);
            if (!res.ok) continue;
            const data = await res.json();
            const row = data?.result?.list?.[0];
            const px = Number(row?.lastPrice);
            if (Number.isFinite(px) && px > 0) return { symbol: sym, price: px, source: "bybit" };
          } else {
            const inst = symbolToOkxSwap(sym);
            const url = `${OKX_BASE}/api/v5/market/ticker?instId=${encodeURIComponent(inst)}`;
            const res = await marketFetch(url);
            if (!res.ok) continue;
            const data = await res.json();
            const row = data?.data?.[0];
            const px = Number(row?.last);
            if (Number.isFinite(px) && px > 0) return { symbol: sym, price: px, source: "okx" };
          }
        } catch {
          /* try next */
        }
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "price failed"));
}

/**
 * @param {string} symbol
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} interval
 */
async function fetchBinanceFuturesKlines(symbol, startMs, endMs, interval = "5m") {
  const sym = normalizeUsdtSymbol(symbol);
  const base = config.binanceFapiUrl.replace(/\/$/, "");
  /** @type {Array<{ open: number, high: number, low: number, close: number, ts: number }>} */
  const all = [];
  let cursor = Math.floor(startMs);
  const end = Math.floor(endMs);
  while (cursor < end) {
    const params = new URLSearchParams({
      symbol: sym,
      interval,
      startTime: String(cursor),
      endTime: String(end),
      limit: "500",
    });
    const url = `${base}/fapi/v1/klines?${params}`;
    const res = await marketFetch(url);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`Binance klines HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 160)}` : ""}`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      all.push({
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        ts: normalizeKlineTs(r[0]),
      });
    }
    const lastTs = normalizeKlineTs(rows[rows.length - 1][0]);
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;
    if (rows.length < 500) break;
  }
  return all;
}

/**
 * @param {string} symbol
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} interval
 */
async function fetchBybitFuturesKlines(symbol, startMs, endMs, interval = "5m") {
  const sym = normalizeUsdtSymbol(symbol);
  const iv = BYBIT_INTERVAL[interval];
  if (!iv) throw new Error(`Bybit 不支持 interval ${interval}`);
  /** @type {Array<{ open: number, high: number, low: number, close: number, ts: number }>} */
  const all = [];
  let cursor = Math.floor(startMs);
  const end = Math.floor(endMs);
  const span = intervalSpanMs(interval);
  while (cursor < end) {
    const params = new URLSearchParams({
      category: "linear",
      symbol: sym,
      interval: iv,
      start: String(cursor),
      end: String(end),
      limit: "1000",
    });
    const url = `${BYBIT_BASE}/v5/market/kline?${params}`;
    const res = await marketFetch(url);
    if (!res.ok) throw new Error(`Bybit klines HTTP ${res.status}`);
    const data = await res.json();
    if (Number(data?.retCode) !== 0) {
      throw new Error(`Bybit klines ${data?.retMsg ?? "error"}`);
    }
    const rows = data?.result?.list ?? [];
    if (!Array.isArray(rows) || !rows.length) break;
    let maxTs = cursor;
    for (const r of rows) {
      const ts = normalizeKlineTs(r[0]);
      if (!Number.isFinite(ts) || !klineOpenInRange(ts, startMs, endMs, interval)) continue;
      all.push({
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        ts,
      });
      if (ts > maxTs) maxTs = ts;
    }
    if (maxTs <= cursor) break;
    cursor = maxTs + span;
    if (rows.length < 1000) break;
  }
  return all;
}

/**
 * @param {string} symbol
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} interval
 */
async function fetchOkxFuturesKlines(symbol, startMs, endMs, interval = "5m") {
  const inst = symbolToOkxSwap(symbol);
  if (!inst) throw new Error("OKX invalid symbol");
  const span = intervalSpanMs(interval);
  const start = Math.floor(startMs);
  /** @type {Map<number, { open: number, high: number, low: number, close: number, ts: number }>} */
  const byTs = new Map();
  /** OKX before 单位为秒（毫秒会返回空数组） */
  let beforeSec = Math.floor(endMs / 1000);
  while (true) {
    const params = new URLSearchParams({
      instId: inst,
      bar: interval,
      limit: "300",
      before: String(beforeSec),
    });
    const url = `${OKX_BASE}/api/v5/market/candles?${params}`;
    const res = await marketFetch(url);
    if (!res.ok) throw new Error(`OKX klines HTTP ${res.status}`);
    const data = await res.json();
    if (String(data?.code) !== "0") {
      throw new Error(`OKX klines ${data?.msg ?? "error"}`);
    }
    const rows = data?.data ?? [];
    if (!Array.isArray(rows) || !rows.length) break;
    let minTsMs = Number.POSITIVE_INFINITY;
    for (const r of rows) {
      const ts = normalizeKlineTs(r[0]);
      if (!Number.isFinite(ts)) continue;
      if (ts < minTsMs) minTsMs = ts;
      if (!klineOpenInRange(ts, startMs, endMs, interval)) continue;
      byTs.set(ts, {
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        ts,
      });
    }
    if (!Number.isFinite(minTsMs)) break;
    if (minTsMs + span <= start || rows.length < 300) break;
    const nextBefore = Math.floor(minTsMs / 1000);
    if (nextBefore >= beforeSec) break;
    beforeSec = nextBefore;
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * @param {string} symbol
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} interval
 */
async function fetchBitgetFuturesKlines(symbol, startMs, endMs, interval = "5m") {
  const gran = BITGET_GRAN[interval];
  if (!gran) throw new Error(`Bitget 不支持 interval ${interval}`);
  const sym = toUsdtSymbol(symbol);
  /** @type {Array<{ open: number, high: number, low: number, close: number, ts: number }>} */
  const all = [];
  let endCursor = Math.floor(endMs);
  const start = Math.floor(startMs);
  while (endCursor > start) {
    const params = new URLSearchParams({
      productType: "USDT-FUTURES",
      symbol: sym,
      granularity: gran,
      limit: "200",
      endTime: String(endCursor),
    });
    const url = `${bitgetBaseUrl()}/api/v2/mix/market/candles?${params}`;
    const res = await marketFetch(url);
    if (!res.ok) throw new Error(`Bitget klines HTTP ${res.status}`);
    const data = await res.json();
    if (String(data?.code) !== "00000" && String(data?.code) !== "0") {
      throw new Error(`Bitget klines ${data?.msg ?? data?.code ?? "error"}`);
    }
    const rows = data?.data ?? [];
    if (!Array.isArray(rows) || !rows.length) break;
    let pageMin = Number.POSITIVE_INFINITY;
    for (const r of rows) {
      const ts = normalizeKlineTs(r[0]);
      if (!Number.isFinite(ts)) continue;
      if (ts < pageMin) pageMin = ts;
      if (!klineOpenInRange(ts, startMs, endMs, interval)) continue;
      all.push({
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        ts,
      });
    }
    if (!Number.isFinite(pageMin)) break;
    if (pageMin >= endCursor || rows.length < 200) break;
    endCursor = pageMin - 1;
  }
  return all;
}

/**
 * @param {string} symbol
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} interval
 */
async function fetchGateFuturesKlines(symbol, startMs, endMs, interval = "5m") {
  if (!INTERVAL_MS[interval]) throw new Error(`Gate 不支持 interval ${interval}`);
  const base = humanBaseAsset(symbol);
  const contract = `${base}_USDT`;
  /** @type {Array<{ open: number, high: number, low: number, close: number, ts: number }>} */
  const all = [];
  let toSec = Math.floor(endMs / 1000);
  const startSec = Math.floor(startMs / 1000);
  while (toSec > startSec) {
    const params = new URLSearchParams({
      contract,
      interval,
      limit: "1000",
      to: String(toSec),
    });
    const url = `${GATE_BASE}/api/v4/futures/usdt/candlesticks?${params}`;
    const res = await marketFetch(url);
    if (!res.ok) throw new Error(`Gate klines HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;
    let oldestSec = toSec;
    for (const r of rows) {
      const ts = normalizeKlineTs(r.t != null ? Number(r.t) * 1000 : r[0]);
      const tsSec = Math.floor(ts / 1000);
      if (!Number.isFinite(ts) || !klineOpenInRange(ts, startMs, endMs, interval)) continue;
      const o = Number(r.o ?? r[5]);
      const h = Number(r.h ?? r[3]);
      const l = Number(r.l ?? r[4]);
      const c = Number(r.c ?? r[2]);
      all.push({ open: o, high: h, low: l, close: c, ts });
      if (tsSec < oldestSec) oldestSec = tsSec;
    }
    if (oldestSec >= toSec || rows.length < 1000) break;
    toSec = oldestSec - 1;
  }
  return all;
}

/**
 * @param {"binance"|"bybit"|"okx"|"bitget"|"gate"} source
 * @param {{ conservative?: boolean }} [lookupOpts]
 */
async function fetchKlinesFromVenue(source, symbol, startMs, endMs, interval, lookupOpts = {}) {
  const venueKey =
    source === "binance" ? "binance" : source === "bitget" || source === "gate" ? source : source;
  const candidates = symbolLookupCandidates(symbol, venueKey, lookupOpts);
  for (const sym of candidates) {
    try {
      /** @type {Array<{ open: number, high: number, low: number, close: number, ts: number }>} */
      let rows;
      if (source === "binance") {
        if (binanceKlineBlocked) return null;
        rows = await fetchBinanceFuturesKlines(sym, startMs, endMs, interval);
      } else if (source === "bybit") {
        rows = await fetchBybitFuturesKlines(sym, startMs, endMs, interval);
      } else if (source === "okx") {
        rows = await fetchOkxFuturesKlines(sym, startMs, endMs, interval);
      } else if (source === "bitget") {
        rows = await fetchBitgetFuturesKlines(sym, startMs, endMs, interval);
      } else {
        rows = await fetchGateFuturesKlines(sym, startMs, endMs, interval);
      }
      if (rows.length) {
        Object.assign(rows, { klineSource: source });
        return rows;
      }
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      if (source === "binance") {
        if (isBinanceKlineHardBlock(msg)) {
          binanceKlineBlocked = true;
          log.warn(
            `币安 K 线不可用 ${msg.slice(0, 100)}（代理 ${config.binanceProxy || "未配置"}），尝试 ${klineSourceOrder().filter((s) => s !== "binance").join("/") || "其它交易所"}`
          );
          return null;
        }
        if (isInvalidFuturesSymbolError(msg)) continue;
        klineWarnThrottled(`币安 K 线失败 ${sym}: ${msg.slice(0, 100)}，换下一合约名候选`);
        continue;
      }
      if (isInvalidFuturesSymbolError(msg)) continue;
      if (isVenueAccessBlock(msg)) {
        log.warn(
          `K线 ${source} 访问受限 ${msg.slice(0, 100)}（COMMON_PROXY=${config.binanceProxy || "未配置"}），换下一交易所`
        );
        return null;
      }
      if (!isInvalidFuturesSymbolError(msg)) {
        klineWarnThrottled(`K线 ${source} 失败 ${sym}: ${msg.slice(0, 120)}`);
      }
    }
  }
  return null;
}

/** @typedef {{ sources: Array<"binance"|"bybit"|"okx"|"bitget"|"gate">, conservative?: boolean, pauseMs?: number, label?: string }} KlineFetchPlan */

/** @returns {KlineFetchPlan[]} */
function klineAdaptivePlans() {
  const primary = backfillKlineSourceOrder();
  /** @type {KlineFetchPlan[]} */
  const plans = [{ sources: primary, conservative: false, label: "回溯默认" }];
  const alt = ["binance", "bybit", "bitget", "gate", "okx"].filter((s) => !primary.includes(s));
  if (alt.length) {
    plans.push({
      sources: [...primary, ...alt],
      conservative: true,
      pauseMs: 600,
      label: "保守合约名",
    });
  }
  plans.push({
    sources: ["binance", "bybit", "bitget", "gate", "okx"],
    conservative: true,
    pauseMs: 2000,
    label: "全所限速重试",
  });
  return plans;
}

/**
 * @param {string} symbol
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} interval
 * @param {{ adaptive?: boolean, conservative?: boolean, sources?: KlineFetchPlan["sources"] }} [opts]
 */
async function fetchFuturesKlinesOnce(symbol, startMs, endMs, interval, opts = {}) {
  const sources = opts.sources?.length ? opts.sources : klineSourceOrder();
  const lookupOpts = { conservative: Boolean(opts.conservative) };
  for (const source of sources) {
    await klineFetchGap(0);
    const rows = await fetchKlinesFromVenue(source, symbol, startMs, endMs, interval, lookupOpts);
    if (rows?.length) {
      return rows;
    }
  }
  return null;
}

/**
 * @param {string} symbol
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} interval
 * @param {{ adaptive?: boolean }} [opts]
 */
export async function fetchFuturesKlines(symbol, startMs, endMs, interval = "5m", opts = {}) {
  return withKlineFetchMutex(async () => {
    logKlineProxyOnce();
    const sym = normalizeUsdtSymbol(symbol);
    const adaptive = Boolean(opts.adaptive ?? config.telegramBackfillKlineAdaptive);
    /** @type {KlineFetchPlan[]} */
    const plans = adaptive
      ? klineAdaptivePlans()
      : [{ sources: klineSourceOrder(), conservative: false, label: "默认" }];

    let lastSources = plans[0]?.sources ?? klineSourceOrder();
    for (let i = 0; i < plans.length; i += 1) {
      const plan = plans[i];
      lastSources = plan.sources;
      if (plan.pauseMs && i > 0) {
        await new Promise((r) => setTimeout(r, plan.pauseMs));
      }
      const rows = await fetchFuturesKlinesOnce(symbol, startMs, endMs, interval, {
        sources: plan.sources,
        conservative: plan.conservative,
      });
      if (rows?.length) {
        if (i > 0) {
          log.info(
            `K线自适应成功 ${sym} ${interval} n=${rows.length}（${plan.label ?? `轮次${i + 1}`} / ${rows.klineSource})`,
          );
        }
        return rows;
      }
      if (adaptive && i < plans.length - 1) {
        log.info(`K线 ${sym} ${plan.label ?? `轮次${i + 1}`} 无数据，进入下一策略…`);
      }
    }

    const tried = lastSources.join(" → ");
    const proxyHint = config.binanceProxy
      ? `已配置代理 ${config.binanceProxy}；若各所仍 403/451 请换出口节点或 CARD_KLINE_SOURCES=bitget,gate,bybit,binance`
      : "请配置 COMMON_PROXY（或 BINANCE_PROXY）；直连在国内常 451/403";
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`K线全部来源失败 ${sym}（已试 ${tried}${adaptive ? "，含自适应" : ""}）：${proxyHint}`)
    );
    err.code = "FUTURES_ALL_FAILED";
    throw err;
  });
}

/**
 * @param {unknown} symbol
 * @param {unknown} [assetClass]
 */
export function shouldPreferAlphaMarket(symbol, assetClass) {
  const ac = String(assetClass ?? "").toLowerCase();
  if (ac === "alpha") return true;
  return isAlphaContractAddress(symbol) || isAlphaTradingSymbol(symbol);
}

/**
 * @param {string} symbol
 * @param {'crypto' | 'stock' | 'alpha' | string} assetClass
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} interval
 */
/**
 * @param {string} symbol
 * @param {'crypto' | 'stock' | 'alpha' | string} assetClass
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} interval
 * @param {{ adaptiveKlines?: boolean }} [opts]
 */
export async function fetchKlinesForCard(symbol, assetClass, startMs, endMs, interval, opts = {}) {
  if (assetClass === "stock") {
    throw new Error("股票行情源未配置（请设置 assetClass=crypto 或接入股票 K 线 API）");
  }

  const preferAlpha = shouldPreferAlphaMarket(symbol, assetClass);

  if (preferAlpha) {
    const { token, klines } = await fetchAlphaKlinesForQuery(symbol, startMs, endMs, interval);
    log.info(
      `Alpha K线 ${token.tradingSymbol} (${token.symbol || token.contractAddress}) ${interval} n=${klines.length}`
    );
    Object.assign(klines, {
      market: "alpha",
      alpha: {
        alphaId: token.alphaId,
        tradingSymbol: token.tradingSymbol,
        contractAddress: token.contractAddress,
        chainId: token.chainId,
        ticker: token.symbol,
      },
    });
    return klines;
  }

  try {
    const rows = await fetchFuturesKlines(symbol, startMs, endMs, interval, {
      adaptive: Boolean(opts.adaptiveKlines ?? config.telegramBackfillKlineAdaptive),
    });
    Object.assign(rows, {
      market: "futures",
      klineSource: rows.klineSource ?? "binance",
    });
    return rows;
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message ?? e);
    const code = /** @type {{ code?: string }} */ (e).code;
    const tryAlpha =
      !isMainstreamFuturesBase(symbol) &&
      (code === "FUTURES_NOT_FOUND" ||
        code === "FUTURES_ALL_FAILED" ||
        /futures_symbol_not_found|Invalid symbol|invalid symbol|-1121|全部来源失败/i.test(msg));
    if (!tryAlpha) throw e;
    try {
      const { token, klines } = await fetchAlphaKlinesForQuery(symbol, startMs, endMs, interval);
      if (!klines.length) throw e;
      log.info(
        `K线合约不可用，改走 Alpha ${token.tradingSymbol} ← ${String(symbol)} n=${klines.length}`
      );
      Object.assign(klines, {
        market: "alpha",
        alpha: {
          alphaId: token.alphaId,
          tradingSymbol: token.tradingSymbol,
          contractAddress: token.contractAddress,
          chainId: token.chainId,
          ticker: token.symbol,
        },
      });
      return klines;
    } catch (alphaErr) {
      log.warn(
        `Alpha 兜底失败 ${String(symbol)}: ${String(/** @type {Error} */ (alphaErr).message ?? alphaErr)}`
      );
      throw e;
    }
  }
}

/**
 * 现价：合约优先；0x / Alpha 交易对直连 Alpha；合约失败再试 Alpha。
 * @param {string} symbol
 * @param {string} [assetClass]
 */
export async function fetchPriceForCard(symbol, assetClass) {
  if (shouldPreferAlphaMarket(symbol, assetClass)) {
    return fetchAlphaPrice(symbol);
  }
  try {
    const p = await fetchFuturesPrice(symbol);
    return { ...p, market: /** @type {const} */ ("futures") };
  } catch (e) {
    try {
      return await fetchAlphaPrice(symbol);
    } catch {
      throw e;
    }
  }
}

/** @param {unknown} v */
export function parsePrice(v) {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 入场价：区间取均价，如 60500-62200。
 * @param {unknown} v
 */
export function parseEntryPrice(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const range = s.match(/([\d.]+)\s*[-~–—]\s*([\d.]+)/);
  if (range) {
    const a = parsePrice(range[1]);
    const b = parsePrice(range[2]);
    if (a != null && b != null) return (a + b) / 2;
  }
  const direct = parsePrice(s);
  if (direct != null) return direct;
  const first = s.match(/([\d.]+)/);
  return first ? parsePrice(first[1]) : null;
}

/**
 * @param {number} price
 * @param {number} level
 */
export function distancePct(price, level) {
  if (!level || !price) return 999;
  return (Math.abs(price - level) / level) * 100;
}

/**
 * @param {number} entry
 * @param {number} exitPrice
 * @param {boolean} isShort
 * @param {number} [leverage]
 */
export function calcLeveragePnl(entry, exitPrice, isShort, leverage = DEFAULT_LEVERAGE()) {
  if (!entry || !exitPrice || !leverage) return null;
  const movePct = isShort ? (entry - exitPrice) / entry : (exitPrice - entry) / entry;
  const pnlPctOnMargin = movePct * leverage * 100;
  return {
    leverage,
    entry,
    exitPrice,
    movePct: movePct * 100,
    pnlPctOnMargin,
    pnlLabel: `${pnlPctOnMargin >= 0 ? "+" : ""}${pnlPctOnMargin.toFixed(2)}% (@${leverage}x)`,
  };
}

/**
 * 结算结果与盈亏符号对齐：止损不为正、止盈不为负。
 * @param {unknown} outcome
 * @param {number | null | undefined} pnlPct
 */
export function alignPnlWithOutcome(outcome, pnlPct) {
  if (pnlPct == null || !Number.isFinite(Number(pnlPct))) return pnlPct ?? null;
  const p = Number(pnlPct);
  const o = String(outcome ?? "").trim();
  if (o === "stop_loss" && p > 0) return -Math.abs(p);
  if (o === "take_profit" && p < 0) return Math.abs(p);
  return p;
}

/**
 * 按 K 线时间顺序：先触达止损或任一止盈即停止；入场区间取均价。
 * @param {{
 *   direction?: string,
 *   planned?: { entryPrice?: string, takeProfitPrices?: string[], stopLossPrice?: string },
 * }} execution
 * @param {Array<{ high: number, low: number, ts?: number }>} klines
 */
export function evaluatePricePath(execution, klines) {
  const dir = String(execution?.direction ?? "");
  const isShort = isShortDirection(dir);
  const entry = parseEntryPrice(execution?.planned?.entryPrice);
  const sl = parsePrice(execution?.planned?.stopLossPrice);
  const tps = (execution?.planned?.takeProfitPrices ?? [])
    .map((p) => parsePrice(p))
    .filter((x) => x != null);

  let highMax = 0;
  let lowMin = Infinity;
  for (const k of klines) {
    if (k.high > highMax) highMax = k.high;
    if (k.low < lowMin) lowMin = k.low;
  }
  if (!klines.length) lowMin = 0;

  let outcome = "pending";
  let hitLevel = "";
  let hitAt = "";
  let hitKind = "";

  const sorted = [...klines].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  outer: for (const k of sorted) {
    if (isShort) {
      if (sl != null && k.high >= sl) {
        outcome = "stop_loss";
        hitLevel = String(sl);
        hitKind = "stop_loss";
        hitAt = k.ts ? new Date(k.ts).toISOString() : "";
        break outer;
      }
      for (const tp of tps) {
        if (k.low <= tp) {
          outcome = "take_profit";
          hitLevel = String(tp);
          hitKind = "take_profit";
          hitAt = k.ts ? new Date(k.ts).toISOString() : "";
          break outer;
        }
      }
    } else {
      if (sl != null && k.low <= sl) {
        outcome = "stop_loss";
        hitLevel = String(sl);
        hitKind = "stop_loss";
        hitAt = k.ts ? new Date(k.ts).toISOString() : "";
        break outer;
      }
      for (const tp of tps) {
        if (k.high >= tp) {
          outcome = "take_profit";
          hitLevel = String(tp);
          hitKind = "take_profit";
          hitAt = k.ts ? new Date(k.ts).toISOString() : "";
          break outer;
        }
      }
    }
  }

  const exitPrice = hitLevel ? parsePrice(hitLevel) : null;
  const pnl100x =
    entry && exitPrice && outcome !== "pending"
      ? calcLeveragePnl(entry, exitPrice, isShort)
      : null;

  return {
    outcome,
    hitLevel,
    hitKind,
    hitAt,
    highMax,
    lowMin,
    entry,
    entryRaw: execution?.planned?.entryPrice ?? null,
    takeProfits: tps,
    stopLoss: sl,
    pnl100x,
    verifiedAt: new Date().toISOString(),
  };
}
