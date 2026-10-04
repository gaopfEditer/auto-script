/** 浏览器直连币安 U 本位 REST（分散服务端压力）。可用 VITE_BINANCE_FAPI_BASE 覆盖。 */
import type { ChartTimeframe } from "./chartTimeframe";
import type { PatternCandle } from "../types";
import { isStablecoinSymbol, symbolLookupCandidates, toUsdtSymbol } from "./symbol";

const DEFAULT_FAPI =
  (import.meta.env.VITE_BINANCE_FAPI_BASE as string | undefined)?.replace(/\/$/, "") ||
  "https://fapi.binance.com";

export function binanceFapiBase(): string {
  return DEFAULT_FAPI;
}

/** Binance kline row → 图表 candle（time 为秒）。 */
export function binanceKlineRowToCandle(row: unknown[]): PatternCandle {
  return {
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5] ?? 0),
  };
}

async function fetchBinanceFuturesKlinesOnce(
  sym: string,
  interval: ChartTimeframe,
  opts?: { limit?: number; endTimeMs?: number; startTimeMs?: number },
): Promise<{ candles: PatternCandle[]; rawCount: number }> {
  const q = clampKlineQueryTimes(interval, opts);
  const limit = Math.min(Math.max(q.limit ?? opts?.limit ?? 500, 1), 1500);
  const params = new URLSearchParams({
    symbol: sym,
    interval,
    limit: String(limit),
  });
  if (q.startTimeMs != null && q.startTimeMs > 0) {
    params.set("startTime", String(q.startTimeMs));
  }
  if (q.endTimeMs != null && q.endTimeMs > 0) {
    params.set("endTime", String(q.endTimeMs));
  }
  const url = `${binanceFapiBase()}/fapi/v1/klines?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`币安 K 线 ${res.status}: ${text.slice(0, 120)}`);
  }
  const data = (await res.json()) as unknown[];
  if (!Array.isArray(data)) {
    throw new Error("币安 K 线响应格式错误");
  }
  let candles = data
    .filter((row) => Array.isArray(row) && row.length >= 6)
    .map((row) => binanceKlineRowToCandle(row as unknown[]));
  candles = filterCandlesNotAfterNow(candles, interval);
  return { candles, rawCount: data.length };
}

export function isInvalidSymbolError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Invalid symbol|invalid symbol|-1121/i.test(msg);
}

/** 请求窗口不得越过「当前已收盘 K」 */
export function clampKlineQueryTimes(
  interval: ChartTimeframe,
  opts?: { limit?: number; endTimeMs?: number; startTimeMs?: number },
): { limit?: number; endTimeMs?: number; startTimeMs?: number } {
  const barMs =
    interval === "5m"
      ? 300_000
      : interval === "15m"
        ? 900_000
        : interval === "1h"
          ? 3_600_000
          : interval === "4h"
            ? 14_400_000
            : interval === "1d"
              ? 86_400_000
              : 900_000;
  const latestClosedEndMs = Date.now() - barMs;
  const out = { ...opts };
  if (out.endTimeMs != null && out.endTimeMs > latestClosedEndMs) {
    out.endTimeMs = latestClosedEndMs;
  }
  if (out.startTimeMs != null && out.startTimeMs > latestClosedEndMs) {
    out.startTimeMs = latestClosedEndMs - barMs;
  }
  if (
    out.startTimeMs != null &&
    out.endTimeMs != null &&
    out.startTimeMs > out.endTimeMs
  ) {
    out.startTimeMs = out.endTimeMs - barMs;
  }
  return out;
}

function filterCandlesNotAfterNow(candles: PatternCandle[], interval: ChartTimeframe): PatternCandle[] {
  const barMs =
    interval === "5m"
      ? 300
      : interval === "15m"
        ? 900
        : interval === "1h"
          ? 3600
          : interval === "4h"
            ? 14400
            : interval === "1d"
              ? 86400
              : 900;
  const maxSec = Math.floor(Date.now() / 1000) - barMs / 1000;
  return candles.filter((c) => c.time <= maxSec);
}

/** 服务端代拉（代理 + 跨所兜底），与 /api/patterns/oi-hist 同口径 */
async function fetchKlinesViaBackend(
  symbol: string,
  interval: ChartTimeframe,
  opts?: { limit?: number; endTimeMs?: number; startTimeMs?: number },
): Promise<{ candles: PatternCandle[]; rawCount: number; resolvedSymbol: string }> {
  if (isStablecoinSymbol(symbol)) {
    throw new Error(`稳定币已排除回溯 (${symbol})`);
  }
  const q = clampKlineQueryTimes(interval, opts);
  const limit = Math.min(Math.max(q.limit ?? opts?.limit ?? 500, 1), 1500);
  const params = new URLSearchParams({
    symbol: toUsdtSymbol(symbol) || symbol,
    interval,
    limit: String(limit),
  });
  if (q.endTimeMs != null && q.endTimeMs > 0) {
    params.set("endTime", String(q.endTimeMs));
  }
  if (q.startTimeMs != null && q.startTimeMs > 0) {
    params.set("startTime", String(q.startTimeMs));
  }
  const res = await fetch(`/api/patterns/klines?${params.toString()}`);
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    candles?: PatternCandle[];
    rawCount?: number;
    symbol?: string;
  } | null;
  if (!res.ok || !body?.ok || !Array.isArray(body.candles) || !body.candles.length) {
    throw new Error(body?.error || `服务端 K 线失败 HTTP ${res.status}`);
  }
  let candles = body.candles.filter(
    (c) =>
      c &&
      Number.isFinite(c.time) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close),
  );
  if (opts?.startTimeMs != null && opts.startTimeMs > 0) {
    const startSec = Math.floor(opts.startTimeMs / 1000);
    candles = candles.filter((c) => c.time >= startSec - 60);
  }
  candles = filterCandlesNotAfterNow(candles, interval);
  if (!candles.length) {
    throw new Error(`服务端 K 线为空 (${symbol})`);
  }
  return {
    candles,
    rawCount: body.rawCount ?? candles.length,
    resolvedSymbol: body.symbol || toUsdtSymbol(symbol) || symbol,
  };
}

async function fetchBinanceFuturesKlinesDirect(
  symbol: string,
  interval: ChartTimeframe,
  opts?: { limit?: number; endTimeMs?: number; startTimeMs?: number },
): Promise<{ candles: PatternCandle[]; rawCount: number; resolvedSymbol: string }> {
  const candidates = symbolLookupCandidates(toUsdtSymbol(symbol) || symbol, "binance");
  let lastErr: Error | null = null;
  for (const sym of candidates) {
    try {
      const got = await fetchBinanceFuturesKlinesOnce(sym, interval, opts);
      if (got.candles.length) return { ...got, resolvedSymbol: sym };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      // 仅「真·无效合约」试下一候选；网络/封禁立刻抛出走服务端兜底
      if (!isInvalidSymbolError(lastErr)) throw lastErr;
    }
  }
  const tried = candidates.join("/");
  throw lastErr
    ? new Error(`${lastErr.message}（已试 ${tried}）`)
    : new Error(`币安 K 线为空（已试 ${tried}）`);
}

export async function fetchBinanceFuturesKlines(
  symbol: string,
  interval: ChartTimeframe,
  opts?: { limit?: number; endTimeMs?: number; startTimeMs?: number },
): Promise<{ candles: PatternCandle[]; rawCount: number; resolvedSymbol: string }> {
  try {
    return await fetchBinanceFuturesKlinesDirect(symbol, interval, opts);
  } catch (directErr) {
    try {
      return await fetchKlinesViaBackend(symbol, interval, opts);
    } catch (backendErr) {
      const a = directErr instanceof Error ? directErr.message : String(directErr);
      const b = backendErr instanceof Error ? backendErr.message : String(backendErr);
      throw new Error(`${a}；服务端兜底：${b}`);
    }
  }
}

function oiPointsToMap(
  rows: Array<{ time?: number; value?: number; timestamp?: number; sumOpenInterest?: string | number }>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const row of rows) {
    if (row.time != null && row.value != null) {
      const t = Number(row.time);
      const v = Number(row.value);
      if (Number.isFinite(t) && Number.isFinite(v) && v > 0) out.set(t, v);
      continue;
    }
    const ts = Number(row.timestamp);
    const oi = Number(row.sumOpenInterest);
    if (!Number.isFinite(ts) || !Number.isFinite(oi) || oi <= 0) continue;
    out.set(Math.floor(ts / 1000), oi);
  }
  return out;
}

const DERIV_FETCH_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(url: string, timeoutMs = DERIV_FETCH_TIMEOUT_MS): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 币安 U 本位历史持仓量；time 为秒。优先本机 /api/patterns/oi-hist（代理），再短时直连。 */
export async function fetchBinanceOpenInterestHist(
  symbol: string,
  interval: ChartTimeframe,
  opts?: { limit?: number },
): Promise<Map<number, number>> {
  const sym = toUsdtSymbol(symbol) || symbol.trim().toUpperCase();
  const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 500);
  const proxyParams = new URLSearchParams({
    symbol: sym,
    interval,
    limit: String(limit),
  });
  try {
    const res = await fetchWithTimeout(
      `/api/patterns/oi-hist?${proxyParams.toString()}`,
      DERIV_FETCH_TIMEOUT_MS,
    );
    if (res.ok) {
      const body = (await res.json()) as {
        ok?: boolean;
        points?: Array<{ time: number; value: number }>;
      };
      if (body.ok && Array.isArray(body.points) && body.points.length) {
        return oiPointsToMap(body.points);
      }
    }
  } catch {
    /* fall through */
  }

  const params = new URLSearchParams({
    symbol: sym,
    period: interval,
    limit: String(limit),
  });
  const url = `${binanceFapiBase()}/futures/data/openInterestHist?${params.toString()}`;
  try {
    const res = await fetchWithTimeout(url, 8_000);
    if (res.ok) {
      const data = (await res.json()) as Array<{
        sumOpenInterest?: string | number;
        timestamp?: number;
      }>;
      if (Array.isArray(data) && data.length) return oiPointsToMap(data);
    }
  } catch {
    /* ignore */
  }
  return new Map();
}
