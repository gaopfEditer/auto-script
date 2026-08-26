/**
 * 币安 U 本位永续公开行情（价格校验 / 接近推送）。
 * 币安 418 时自动兜底 Bybit / OKX（与 oi_mornitor/exchange_sources 一致）。
 */
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { config } from "./config.js";
import { isShortDirection } from "./card-direction.js";
import { createLogger } from "./logger.js";

const log = createLogger("card-price");

const DEFAULT_LEVERAGE = () => Number(config.cardVerifyLeverage) || 100;

const BYBIT_BASE = "https://api.bybit.com";
const OKX_BASE = "https://www.okx.com";

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

const KLINE_FALLBACK_ORDER = ["bybit", "okx"];

/** 币安 K 线 418 后本轮进程内跳过后续币安请求 */
let binanceKlineBlocked = false;

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
  const signal = init.signal ?? AbortSignal.timeout(config.binanceRequestTimeoutMs);
  const dispatcher = getMarketDispatcher();
  if (dispatcher) {
    return undiciFetch(url, { ...init, signal, dispatcher });
  }
  return fetch(url, { ...init, signal });
}

/** @param {string} symbol */
function normalizeUsdtSymbol(symbol) {
  const s = String(symbol ?? "").toUpperCase().trim();
  return s.endsWith("USDT") ? s : `${s}USDT`;
}

/** @param {string} symbol */
function symbolToOkxSwap(symbol) {
  const sym = normalizeUsdtSymbol(symbol);
  return `${sym.replace(/USDT$/, "")}-USDT-SWAP`;
}

/** @param {string} interval */
function intervalSpanMs(interval) {
  return INTERVAL_MS[interval] ?? 300_000;
}

/**
 * @param {string} symbol 如 BTC 或 BTCUSDT
 */
export async function fetchFuturesPrice(symbol) {
  const sym = normalizeUsdtSymbol(symbol);
  const base = config.binanceFapiUrl.replace(/\/$/, "");
  const url = `${base}/fapi/v1/ticker/price?symbol=${encodeURIComponent(sym)}`;
  const res = await marketFetch(url);
  if (!res.ok) throw new Error(`Binance price HTTP ${res.status}`);
  const data = await res.json();
  return { symbol: sym, price: Number(data.price) };
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
    if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      all.push({
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        ts: Number(r[0]),
      });
    }
    const lastTs = Number(rows[rows.length - 1][0]);
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
      const ts = Number(r[0]);
      if (!Number.isFinite(ts) || ts < cursor || ts >= end) continue;
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
  /** @type {Array<{ open: number, high: number, low: number, close: number, ts: number }>} */
  const all = [];
  const start = Math.floor(startMs);
  const end = Math.floor(endMs);
  let before = String(end);
  while (true) {
    const params = new URLSearchParams({
      instId: inst,
      bar: interval,
      limit: "300",
      before,
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
    let oldest = end;
    for (const r of rows) {
      const ts = Number(r[0]);
      if (!Number.isFinite(ts) || ts < start || ts >= end) continue;
      all.push({
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        ts,
      });
      if (ts < oldest) oldest = ts;
    }
    if (oldest <= start || rows.length < 300) break;
    before = String(oldest);
  }
  return all;
}

/**
 * @param {string} symbol
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} [interval]
 */
export async function fetchFuturesKlines(symbol, startMs, endMs, interval = "5m") {
  const sym = normalizeUsdtSymbol(symbol);

  if (!binanceKlineBlocked) {
    try {
      const rows = await fetchBinanceFuturesKlines(sym, startMs, endMs, interval);
      if (rows.length) return rows;
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      if (/418|429|403/.test(msg)) {
        binanceKlineBlocked = true;
        log.warn(
          `币安 K 线 ${msg.slice(0, 60)}（代理 ${config.binanceProxy || "未配置"}），改走 Bybit/OKX 兜底`
        );
      } else {
        throw e;
      }
    }
  }

  for (const source of KLINE_FALLBACK_ORDER) {
    try {
      const rows =
        source === "bybit"
          ? await fetchBybitFuturesKlines(sym, startMs, endMs, interval)
          : await fetchOkxFuturesKlines(sym, startMs, endMs, interval);
      if (rows.length) {
        log.info(`K线兜底 ${source} ${sym} ${interval} n=${rows.length}`);
        return rows;
      }
    } catch (e) {
      log.warn(`K线兜底 ${source} 失败 ${sym}: ${String(/** @type {Error} */ (e).message ?? e)}`);
    }
  }

  const proxyHint = config.binanceProxy
    ? `已配置代理 ${config.binanceProxy}，但币安仍 418（出口 IP 被封）`
    : "请配置 COMMON_PROXY 或 BINANCE_PROXY";
  throw new Error(
    `K线全部来源失败 ${sym}：${proxyHint}；Bybit/OKX 兜底亦未返回数据`
  );
}

/**
 * @param {string} symbol
 * @param {'crypto' | 'stock'} assetClass
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} interval
 */
export async function fetchKlinesForCard(symbol, assetClass, startMs, endMs, interval) {
  if (assetClass === "stock") {
    throw new Error("股票行情源未配置（请设置 assetClass=crypto 或接入股票 K 线 API）");
  }
  return fetchFuturesKlines(symbol, startMs, endMs, interval);
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
