/**
 * 币安 U 本位永续公开行情（价格校验 / 接近推送）。
 */
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { config } from "./config.js";

const DEFAULT_LEVERAGE = () => Number(config.cardVerifyLeverage) || 100;

/** @type {import("undici").Dispatcher | undefined} */
let binanceDispatcher;

function getBinanceDispatcher() {
  const proxy = config.binanceProxy;
  if (!proxy) return undefined;
  if (!binanceDispatcher) binanceDispatcher = new ProxyAgent(proxy);
  return binanceDispatcher;
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function binanceFetch(url, init = {}) {
  const signal = init.signal ?? AbortSignal.timeout(config.binanceRequestTimeoutMs);
  const dispatcher = getBinanceDispatcher();
  if (dispatcher) {
    return undiciFetch(url, { ...init, signal, dispatcher });
  }
  return fetch(url, { ...init, signal });
}

/**
 * @param {string} symbol 如 BTC 或 BTCUSDT
 */
export async function fetchFuturesPrice(symbol) {
  const sym = String(symbol ?? "").toUpperCase().endsWith("USDT")
    ? String(symbol).toUpperCase()
    : `${String(symbol).toUpperCase()}USDT`;
  const base = config.binanceFapiUrl.replace(/\/$/, "");
  const url = `${base}/fapi/v1/ticker/price?symbol=${encodeURIComponent(sym)}`;
  const res = await binanceFetch(url);
  if (!res.ok) throw new Error(`Binance price HTTP ${res.status}`);
  const data = await res.json();
  return { symbol: sym, price: Number(data.price) };
}

/**
 * @param {string} symbol
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} [interval]
 */
export async function fetchFuturesKlines(symbol, startMs, endMs, interval = "5m") {
  const sym = String(symbol ?? "").toUpperCase().endsWith("USDT")
    ? String(symbol).toUpperCase()
    : `${String(symbol).toUpperCase()}USDT`;
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
    const res = await binanceFetch(url);
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
  return parsePrice(s);
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
  const isShort = /空|short|sell/i.test(dir);
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
