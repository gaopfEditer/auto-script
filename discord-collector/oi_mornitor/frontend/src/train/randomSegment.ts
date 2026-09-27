import { isInvalidSymbolError } from "../utils/binanceKlines";
import type { Candle, TrainConfig, TrainTimeframe } from "./types";
import { fetchDeepHistory } from "./historyFetch";
import { DEFAULT_TRAIN_CONFIG } from "./defaults";

/** 随机片段结束时间：至少距现在 RANDOM_END_MIN 天，最远 RANDOM_END_MAX 天 */
const RANDOM_END_MIN_DAYS = 45;
const RANDOM_END_MAX_DAYS = 540;

const TF_SEC: Record<TrainTimeframe, number> = {
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** 随机选一个「片段结束」时刻（秒），落在较久远区间，避免总在最近一个月 */
export function pickRandomHistoryEndSec(timeframe: TrainTimeframe, nowSec = Math.floor(Date.now() / 1000)): number {
  const barSec = TF_SEC[timeframe] ?? 900;
  const latestEnd = nowSec - RANDOM_END_MIN_DAYS * 86400 - barSec;
  const earliestEnd = nowSec - RANDOM_END_MAX_DAYS * 86400;
  if (earliestEnd >= latestEnd) return latestEnd;
  return earliestEnd + Math.floor(Math.random() * (latestEnd - earliestEnd + 1));
}

export function pickRandomStartIndex(
  total: number,
  lookbackBars: number,
  sessionBars: number,
): number {
  const minStart = lookbackBars;
  const maxOrigin = total - sessionBars - 1;
  if (maxOrigin <= minStart) {
    return Math.min(minStart, Math.max(0, total - sessionBars - 1));
  }
  return minStart + Math.floor(Math.random() * (maxOrigin - minStart + 1));
}

export function sliceSessionSegment(
  all: Candle[],
  originIndex: number,
  lookbackBars: number,
  sessionBars: number,
): Candle[] {
  const from = Math.max(0, originIndex - lookbackBars + 1);
  const to = Math.min(all.length, originIndex + sessionBars + 1);
  return all.slice(from, to);
}

export function resolveSessionParams(
  config: TrainConfig,
): { symbol: string; timeframe: TrainTimeframe } {
  const symbols = config.symbols.filter(Boolean);
  const tfs = config.timeframes.filter(Boolean);
  const symbol = config.randomizeSymbol
    ? symbols[Math.floor(Math.random() * symbols.length)] || "BTCUSDT"
    : symbols[0] || "BTCUSDT";
  const timeframe = config.randomizeTimeframe
    ? tfs[Math.floor(Math.random() * tfs.length)] || "15m"
    : tfs[0] || "15m";
  return { symbol, timeframe };
}

function symbolAttemptOrder(primary: string, config: TrainConfig): string[] {
  const pool = [
    primary,
    ...config.symbols,
    ...DEFAULT_TRAIN_CONFIG.symbols,
    "BTCUSDT",
    "ETHUSDT",
  ];
  return [...new Set(pool.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 12);
}

async function buildSessionCandlesForSymbol(
  config: TrainConfig,
  symbol: string,
  timeframe: TrainTimeframe,
): Promise<{ candles: Candle[]; startTs: number; resolvedSymbol: string }> {
  const need = config.lookbackBars + config.sessionBars + 200;
  const historyOpts =
    config.randomizeStart
      ? { endTimeMs: pickRandomHistoryEndSec(timeframe) * 1000 }
      : undefined;

  const { candles: history, resolvedSymbol } = await fetchDeepHistory(
    symbol,
    timeframe,
    need,
    historyOpts,
  );
  if (history.length < config.lookbackBars + config.sessionBars + 10) {
    throw new Error(`历史 K 线不足（${history.length} 根），换周期或换币`);
  }

  let originIndex: number;
  if (config.randomizeStart) {
    originIndex = pickRandomStartIndex(history.length, config.lookbackBars, config.sessionBars);
  } else {
    originIndex = config.lookbackBars + Math.floor(config.sessionBars / 2);
  }

  const segment = sliceSessionSegment(
    history,
    originIndex,
    config.lookbackBars,
    config.sessionBars,
  );
  const startTs = segment[config.lookbackBars - 1]?.t ?? segment[0]?.t ?? 0;
  return { candles: segment, startTs, resolvedSymbol };
}

export async function buildSessionCandles(
  config: TrainConfig,
  symbol: string,
  timeframe: TrainTimeframe,
): Promise<{ candles: Candle[]; startTs: number; resolvedSymbol: string }> {
  const order = config.randomizeSymbol
    ? shuffle(symbolAttemptOrder(symbol, config))
    : symbolAttemptOrder(symbol, config);

  let lastErr: unknown;
  for (const sym of order) {
    try {
      return await buildSessionCandlesForSymbol(config, sym, timeframe);
    } catch (e) {
      lastErr = e;
      if (isInvalidSymbolError(e)) continue;
      throw e;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "无法拉取 K 线，请换币或稍后重试"));
}

const MTF_PAD_BARS = 220;

export async function attachHigherTimeframes(
  symbol: string,
  segment15: Candle[],
): Promise<Partial<Record<"1h" | "4h", Candle[]>>> {
  if (!segment15.length) return {};
  const fromTs = segment15[0].t;
  const toTs = segment15[segment15.length - 1].t;
  const endTimeMs = toTs * 1000 + 900_000;
  const out: Partial<Record<"1h" | "4h", Candle[]>> = {};
  for (const tf of ["1h", "4h"] as const) {
    const sec = tf === "1h" ? 3600 : 3600 * 4;
    const padFrom = fromTs - MTF_PAD_BARS * sec;
    const { candles } = await fetchDeepHistory(symbol, tf, segment15.length + MTF_PAD_BARS, {
      endTimeMs,
    });
    out[tf] = candles.filter((c) => c.t >= padFrom && c.t <= toTs);
  }
  return out;
}
