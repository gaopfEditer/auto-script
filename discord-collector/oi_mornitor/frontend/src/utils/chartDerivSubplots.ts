/**
 * 形态图「持仓量」副图：OI 折线、现货净买入、合约净买入。
 * 直连币安失败时走本机 /api/patterns/* 代拉；带简单限频退避。
 */
import type {
  HistogramData,
  LineData,
  UTCTimestamp,
  WhitespaceData,
} from "lightweight-charts";
import type { ChartTimeframe } from "./chartTimeframe";
import { binanceFapiBase, fetchBinanceOpenInterestHist } from "./binanceKlines";
import { toUsdtSymbol } from "./symbol";

const SPOT_BASE =
  (import.meta.env.VITE_BINANCE_SPOT_BASE as string | undefined)?.replace(/\/$/, "") ||
  "https://api.binance.com";

const POS_COLOR = "rgba(0, 230, 118, 0.85)";
const NEG_COLOR = "rgba(255, 82, 82, 0.85)";
const OI_LINE_COLOR = "rgba(100, 181, 246, 0.95)";

export type DerivTsPoint = { time: number; value: number };

export type ChartDerivSubplots = {
  /** 与主图 K 线一一对应（缺数用 whitespace 占位，保证拖动时 logical 同步） */
  oi: Array<LineData | WhitespaceData>;
  spotNet: Array<HistogramData | WhitespaceData>;
  futuresNet: Array<HistogramData | WhitespaceData>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 429/418 时读 Retry-After（秒）或指数退避，最多 attempts 次。 */
async function fetchWithBackoff(
  url: string,
  attempts = 3,
): Promise<Response> {
  let delay = 800;
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await fetch(url);
    if (last.status !== 429 && last.status !== 418) return last;
    const ra = last.headers.get("Retry-After");
    const waitMs =
      ra && /^\d+$/.test(ra.trim())
        ? Math.min(Number(ra.trim()) * 1000, 60_000)
        : delay;
    await sleep(waitMs);
    delay = Math.min(delay * 2, 15_000);
  }
  return last!;
}

function intervalSeconds(interval: ChartTimeframe): number {
  switch (interval) {
    case "5m":
      return 300;
    case "15m":
      return 900;
    case "30m":
      return 1800;
    case "1h":
      return 3600;
    case "4h":
      return 14400;
    case "1d":
      return 86400;
    default:
      return 900;
  }
}

export type AlignedDerivPoint = { time: number; value: number | null };

/**
 * 将稀疏点对齐到主图每一根 K 线 open time。
 * 缺数时 value=null（渲染为 whitespace），保证副图与主图 bar 数量/时间一一对应，
 * 否则 setVisibleLogicalRange 会因索引错位而拖动后不同步。
 */
export function alignPointsToCandleTimes(
  candleTimes: number[],
  points: DerivTsPoint[],
  interval: ChartTimeframe,
): AlignedDerivPoint[] {
  if (!candleTimes.length) return [];
  const sorted = [...points]
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value))
    .sort((a, b) => a.time - b.time);

  const maxSkew = Math.max(60, Math.floor(intervalSeconds(interval) / 2));
  const out: AlignedDerivPoint[] = [];
  let j = 0;
  for (const t of candleTimes) {
    if (!sorted.length) {
      out.push({ time: t, value: null });
      continue;
    }
    while (j + 1 < sorted.length && sorted[j + 1].time <= t) j += 1;
    const cand = sorted[j];
    let best = cand;
    let bestDist = Math.abs(cand.time - t);
    if (j + 1 < sorted.length) {
      const nxt = sorted[j + 1];
      const d = Math.abs(nxt.time - t);
      if (d < bestDist) {
        best = nxt;
        bestDist = d;
      }
    }
    out.push({
      time: t,
      value: bestDist <= maxSkew ? best.value : null,
    });
  }
  return out;
}

function toLineData(points: AlignedDerivPoint[]): Array<LineData | WhitespaceData> {
  return points.map((p) =>
    p.value == null
      ? { time: p.time as UTCTimestamp }
      : { time: p.time as UTCTimestamp, value: p.value },
  );
}

function toHistData(
  points: AlignedDerivPoint[],
): Array<HistogramData | WhitespaceData> {
  return points.map((p) =>
    p.value == null
      ? { time: p.time as UTCTimestamp }
      : {
          time: p.time as UTCTimestamp,
          value: p.value,
          color: p.value >= 0 ? POS_COLOR : NEG_COLOR,
        },
  );
}

async function fetchPointsViaBackend(
  path: string,
  symbol: string,
  interval: ChartTimeframe,
  limit: number,
): Promise<DerivTsPoint[]> {
  const params = new URLSearchParams({
    symbol: toUsdtSymbol(symbol) || symbol,
    interval,
    limit: String(limit),
  });
  const res = await fetchWithBackoff(`${path}?${params.toString()}`);
  if (!res.ok) return [];
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    points?: DerivTsPoint[];
  } | null;
  if (!body?.ok || !Array.isArray(body.points)) return [];
  return body.points
    .map((p) => ({ time: Number(p.time), value: Number(p.value) }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value));
}

async function fetchSpotNetDirect(
  symbol: string,
  interval: ChartTimeframe,
  limit: number,
): Promise<DerivTsPoint[]> {
  const sym = toUsdtSymbol(symbol) || symbol.trim().toUpperCase();
  const params = new URLSearchParams({
    symbol: sym,
    interval,
    limit: String(Math.min(Math.max(limit, 1), 1000)),
  });
  const url = `${SPOT_BASE}/api/v3/klines?${params.toString()}`;
  const res = await fetchWithBackoff(url);
  if (!res.ok) throw new Error(`spot klines ${res.status}`);
  const data = (await res.json()) as unknown[];
  if (!Array.isArray(data)) return [];
  const out: DerivTsPoint[] = [];
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 10) continue;
    const ts = Number(row[0]);
    const vol = Number(row[5]);
    const takerBuy = Number(row[9]);
    if (!Number.isFinite(ts) || !Number.isFinite(vol) || !Number.isFinite(takerBuy)) {
      continue;
    }
    out.push({
      time: Math.floor(ts / 1000),
      value: 2 * takerBuy - vol,
    });
  }
  return out;
}

async function fetchFuturesNetDirect(
  symbol: string,
  interval: ChartTimeframe,
  limit: number,
): Promise<DerivTsPoint[]> {
  const sym = toUsdtSymbol(symbol) || symbol.trim().toUpperCase();
  const params = new URLSearchParams({
    symbol: sym,
    period: interval,
    limit: String(Math.min(Math.max(limit, 1), 500)),
  });
  const url = `${binanceFapiBase()}/futures/data/takerlongshortRatio?${params.toString()}`;
  const res = await fetchWithBackoff(url);
  if (!res.ok) throw new Error(`takerlongshortRatio ${res.status}`);
  const data = (await res.json()) as Array<{
    buyVol?: string | number;
    sellVol?: string | number;
    timestamp?: number;
  }>;
  if (!Array.isArray(data)) return [];
  const out: DerivTsPoint[] = [];
  for (const row of data) {
    const ts = Number(row.timestamp);
    const buy = Number(row.buyVol);
    const sell = Number(row.sellVol);
    if (!Number.isFinite(ts) || !Number.isFinite(buy) || !Number.isFinite(sell)) {
      continue;
    }
    out.push({ time: Math.floor(ts / 1000), value: buy - sell });
  }
  return out;
}

async function fetchSpotNet(
  symbol: string,
  interval: ChartTimeframe,
  limit: number,
): Promise<DerivTsPoint[]> {
  try {
    const direct = await fetchSpotNetDirect(symbol, interval, limit);
    if (direct.length) return direct;
  } catch {
    /* fall through */
  }
  return fetchPointsViaBackend("/api/patterns/spot-net", symbol, interval, limit);
}

async function fetchFuturesNet(
  symbol: string,
  interval: ChartTimeframe,
  limit: number,
): Promise<DerivTsPoint[]> {
  try {
    const direct = await fetchFuturesNetDirect(symbol, interval, limit);
    if (direct.length) return direct;
  } catch {
    /* fall through */
  }
  return fetchPointsViaBackend("/api/patterns/futures-net", symbol, interval, limit);
}

/** 拉取并对齐到主图 candle open times。 */
export async function fetchChartDerivSubplots(
  symbol: string,
  interval: ChartTimeframe,
  candleTimes: number[],
): Promise<ChartDerivSubplots> {
  const times = [...candleTimes]
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
  if (!symbol || !times.length) {
    return { oi: [], spotNet: [], futuresNet: [] };
  }
  const limit = Math.min(500, Math.max(times.length + 8, 50));

  const [oiMap, spotRaw, futRaw] = await Promise.all([
    fetchBinanceOpenInterestHist(symbol, interval, { limit }),
    fetchSpotNet(symbol, interval, limit),
    fetchFuturesNet(symbol, interval, limit),
  ]);

  const oiPts: DerivTsPoint[] = [...oiMap.entries()].map(([time, value]) => ({
    time,
    value,
  }));

  return {
    oi: toLineData(alignPointsToCandleTimes(times, oiPts, interval)),
    spotNet: toHistData(alignPointsToCandleTimes(times, spotRaw, interval)),
    futuresNet: toHistData(alignPointsToCandleTimes(times, futRaw, interval)),
  };
}

export const DERIV_OI_LINE_COLOR = OI_LINE_COLOR;
