/**
 * 币安 U 本位永续公开行情（价格校验 / 接近推送）。
 */
import { config } from "./config.js";

/**
 * @param {string} symbol 如 BTC 或 BTCUSDT
 */
export async function fetchFuturesPrice(symbol) {
  const sym = String(symbol ?? "").toUpperCase().endsWith("USDT")
    ? String(symbol).toUpperCase()
    : `${String(symbol).toUpperCase()}USDT`;
  const base = config.binanceFapiUrl.replace(/\/$/, "");
  const url = `${base}/fapi/v1/ticker/price?symbol=${encodeURIComponent(sym)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(config.binanceRequestTimeoutMs) });
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
  const params = new URLSearchParams({
    symbol: sym,
    interval,
    startTime: String(Math.floor(startMs)),
    endTime: String(Math.floor(endMs)),
    limit: "500",
  });
  const url = `${base}/fapi/v1/klines?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(config.binanceRequestTimeoutMs) });
  if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    ts: Number(r[0]),
  }));
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
 * @param {number} price
 * @param {number} level
 */
export function distancePct(price, level) {
  if (!level || !price) return 999;
  return Math.abs(price - level) / level * 100;
}

/**
 * @param {{
 *   direction?: string,
 *   planned?: { entryPrice?: string, takeProfitPrices?: string[], stopLossPrice?: string },
 * }} execution
 * @param {Array<{ high: number, low: number }>} klines
 */
export function evaluatePricePath(execution, klines) {
  const dir = String(execution?.direction ?? "");
  const isShort = /空|short|sell/i.test(dir);
  const entry = parsePrice(execution?.planned?.entryPrice);
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
  if (isShort) {
    if (sl && highMax >= sl) {
      outcome = "stop_loss";
      hitLevel = String(sl);
    } else if (tps.some((tp) => lowMin <= tp)) {
      outcome = "take_profit";
      hitLevel = String(tps.find((tp) => lowMin <= tp));
    }
  } else {
    if (sl && lowMin <= sl) {
      outcome = "stop_loss";
      hitLevel = String(sl);
    } else if (tps.some((tp) => highMax >= tp)) {
      outcome = "take_profit";
      hitLevel = String(tps.find((tp) => highMax >= tp));
    }
  }

  return {
    outcome,
    hitLevel,
    highMax,
    lowMin,
    entry,
    verifiedAt: new Date().toISOString(),
  };
}
