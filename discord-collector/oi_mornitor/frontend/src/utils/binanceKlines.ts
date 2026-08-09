/** 浏览器直连币安 U 本位 REST（分散服务端压力）。可用 VITE_BINANCE_FAPI_BASE 覆盖。 */
import type { ChartTimeframe } from "./chartTimeframe";
import type { PatternCandle } from "../types";

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

export async function fetchBinanceFuturesKlines(
  symbol: string,
  interval: ChartTimeframe,
  opts?: { limit?: number; endTimeMs?: number },
): Promise<{ candles: PatternCandle[]; rawCount: number }> {
  const sym = symbol.trim().toUpperCase();
  const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 1500);
  const params = new URLSearchParams({
    symbol: sym,
    interval,
    limit: String(limit),
  });
  if (opts?.endTimeMs != null && opts.endTimeMs > 0) {
    params.set("endTime", String(opts.endTimeMs));
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
  const candles = data
    .filter((row) => Array.isArray(row) && row.length >= 6)
    .map((row) => binanceKlineRowToCandle(row as unknown[]));
  return { candles, rawCount: data.length };
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

/** 币安 U 本位历史持仓量；time 为秒。直连失败则走本机 /api/patterns/oi-hist。 */
export async function fetchBinanceOpenInterestHist(
  symbol: string,
  interval: ChartTimeframe,
  opts?: { limit?: number },
): Promise<Map<number, number>> {
  const sym = symbol.trim().toUpperCase();
  const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 500);
  const params = new URLSearchParams({
    symbol: sym,
    period: interval,
    limit: String(limit),
  });
  const url = `${binanceFapiBase()}/futures/data/openInterestHist?${params.toString()}`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const data = (await res.json()) as Array<{
        sumOpenInterest?: string | number;
        timestamp?: number;
      }>;
      if (Array.isArray(data) && data.length) return oiPointsToMap(data);
    }
  } catch {
    /* fall through */
  }

  try {
    const proxyParams = new URLSearchParams({
      symbol: sym,
      interval,
      limit: String(limit),
    });
    const res = await fetch(`/api/patterns/oi-hist?${proxyParams.toString()}`);
    if (!res.ok) return new Map();
    const body = (await res.json()) as {
      ok?: boolean;
      points?: Array<{ time: number; value: number }>;
    };
    if (!body.ok || !Array.isArray(body.points)) return new Map();
    return oiPointsToMap(body.points);
  } catch {
    return new Map();
  }
}
