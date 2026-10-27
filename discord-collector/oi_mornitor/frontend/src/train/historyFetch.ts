import type { PatternCandle } from "../types";

import type { ChartTimeframe } from "../utils/chartTimeframe";

import { chartBarDurationMs } from "../utils/chartTimeframe";

import { clampKlineQueryTimes, fetchBinanceFuturesKlines } from "../utils/binanceKlines";

import { sanitizeTrainCandleList } from "./candleSanitize";
import type { Candle, TrainTimeframe } from "./types";



export function toTrainCandle(c: PatternCandle): Candle {

  return {

    t: c.time,

    o: c.open,

    h: c.high,

    l: c.low,

    c: c.close,

    v: c.volume ?? 0,

  };

}



export const TF_MAP: Record<TrainTimeframe, ChartTimeframe> = {

  "5m": "5m",

  "15m": "15m",

  "1h": "1h",

  "4h": "4h",

  "1d": "1d",

};



export type FetchDeepHistoryOpts = {

  /** 分页锚点：只取该时间点之前（含）的已收盘 K 线 */

  endTimeMs?: number;

};



/** 分页拉取足够长的历史（最多约 7500 根）。 */

export async function fetchDeepHistory(

  symbol: string,

  timeframe: TrainTimeframe,

  minBars: number,

  opts?: FetchDeepHistoryOpts,

): Promise<{ candles: Candle[]; resolvedSymbol: string }> {

  const iv = TF_MAP[timeframe];

  const target = Math.min(Math.max(minBars, 400), 7500);

  const barMs = chartBarDurationMs(iv);

  const clamped = clampKlineQueryTimes(iv, { endTimeMs: opts?.endTimeMs });

  let endTimeMs: number | undefined = clamped.endTimeMs;

  const merged: PatternCandle[] = [];

  let resolved = symbol;

  const maxSec = Math.floor((Date.now() - barMs) / 1000);



  for (let page = 0; page < 6 && merged.length < target; page++) {

    const { candles, resolvedSymbol } = await fetchBinanceFuturesKlines(symbol, iv, {

      limit: 1500,

      endTimeMs,

    });

    if (!candles.length) break;

    resolved = resolvedSymbol;

    const older = [...candles]

      .filter((c) => c.time <= maxSec)

      .sort((a, b) => a.time - b.time);

    if (!older.length) break;

    if (merged.length) {

      const firstNew = older[0]?.time ?? 0;

      const filtered = merged.filter((c) => c.time < firstNew);

      merged.length = 0;

      merged.push(...filtered);

    }

    merged.unshift(...older);

    endTimeMs = older[0].time * 1000 - 1;

    if (older.length < 1500) break;

  }



  const byTime = new Map<number, PatternCandle>();

  for (const c of merged) byTime.set(c.time, c);

  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);

  return {
    candles: sanitizeTrainCandleList(sorted.map(toTrainCandle), `fetch-${symbol}-${timeframe}`),
    resolvedSymbol: resolved,
  };
}

