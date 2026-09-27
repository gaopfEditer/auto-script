import { chartBarDurationMs } from "../utils/chartTimeframe";
import {
  clampKlineQueryTimes,
  fetchBinanceFuturesKlines,
  isInvalidSymbolError,
} from "../utils/binanceKlines";
import { sanitizeTrainCandleList } from "./candleSanitize";
import { toTrainCandle, TF_MAP } from "./historyFetch";
import type { Candle, TrainDisplayTf, TrainSession, TrainTimeframe } from "./types";

const MIN_EXTEND_BATCH_15M = 200;

export function mergeTrainCandles(a: Candle[], b: Candle[]): Candle[] {
  return sanitizeTrainCandleList([...a, ...b], "merge");
}

export function extendThresholdForSession(session: TrainSession): number {
  const v = session.config.extendThresholdBars;
  return v > 0 ? v : 50;
}

export function extendBatch15mForSession(session: TrainSession): number {
  return Math.max(MIN_EXTEND_BATCH_15M, session.config.sessionBars || MIN_EXTEND_BATCH_15M);
}

export function sessionNeedsExtend(session: TrainSession): boolean {
  if (session.status !== "running") return false;
  const left = session.candles.length - session.visibleCount;
  return left <= extendThresholdForSession(session);
}

async function fetchForwardCandles(
  symbol: string,
  timeframe: TrainTimeframe,
  afterTsSec: number,
  wantBars: number,
): Promise<Candle[]> {
  const iv = TF_MAP[timeframe];
  const barMs = chartBarDurationMs(iv);
  const barSec = barMs / 1000;
  const nowSec = Math.floor((Date.now() - barMs) / 1000);
  /** 单次续载只允许紧接上一根向后延伸，禁止一次跳到「现在」造成时间轴空洞 */
  const batchMaxSec = afterTsSec + Math.ceil(wantBars * barSec) + barSec * 2;
  const maxSec = Math.min(nowSec, batchMaxSec);
  if (afterTsSec >= maxSec) return [];

  let startTimeMs = afterTsSec * 1000 + barMs;
  const clamped = clampKlineQueryTimes(iv, { startTimeMs });
  startTimeMs = clamped.startTimeMs ?? startTimeMs;
  if (startTimeMs > Date.now()) return [];

  const out: Candle[] = [];
  const seen = new Set<number>();

  try {
    for (let page = 0; page < 4 && out.length < wantBars; page++) {
      const limit = Math.min(1500, wantBars - out.length + 10);
      const { candles } = await fetchBinanceFuturesKlines(symbol, iv, {
        limit,
        startTimeMs,
      });
      const batch = candles
        .map(toTrainCandle)
        .filter((c) => c.t > afterTsSec && c.t <= maxSec && !seen.has(c.t));
      if (!batch.length) break;
      for (const c of batch) {
        seen.add(c.t);
        out.push(c);
      }
      out.sort((a, b) => a.t - b.t);
      const last = out[out.length - 1];
      if (!last || last.t >= maxSec) break;
      startTimeMs = last.t * 1000 + barMs;
      if (startTimeMs > Date.now() - barMs) break;
      if (candles.length < limit) break;
    }
  } catch (e) {
    if (isInvalidSymbolError(e)) return [];
    throw e;
  }
  return sanitizeTrainCandleList(out.slice(0, wantBars), `forward-${symbol}-${timeframe}`);
}

/** 从最后一根 15m 往后接一段历史，并同步 1h / 4h */
export async function extendTrainSessionCandles(
  session: TrainSession,
  extra15mBars = extendBatch15mForSession(session),
): Promise<TrainSession> {
  const last15 = session.candles[session.candles.length - 1];
  if (!last15) return session;

  const forward15 = await fetchForwardCandles(
    session.symbol,
    "15m",
    last15.t,
    extra15mBars,
  );
  if (!forward15.length) return session;

  const candles = mergeTrainCandles(session.candles, forward15);
  const candlesByTf: Partial<Record<TrainDisplayTf, Candle[]>> = {
    ...session.candlesByTf,
    "15m": candles,
  };

  for (const tf of ["1h", "4h"] as const) {
    const existing = candlesByTf[tf] ?? candlesForTfLocal(session, tf);
    const lastTf = existing[existing.length - 1];
    if (!lastTf) continue;
    const approx =
      tf === "1h"
        ? Math.ceil(forward15.length / 4) + 8
        : Math.ceil(forward15.length / 16) + 4;
    const fwd = await fetchForwardCandles(session.symbol, tf, lastTf.t, approx);
    if (fwd.length) {
      candlesByTf[tf] = mergeTrainCandles(existing, fwd);
    }
  }

  return { ...session, candles, candlesByTf };
}

function candlesForTfLocal(session: TrainSession, tf: TrainDisplayTf): Candle[] {
  const byTf = session.candlesByTf;
  if (byTf?.[tf]?.length) return byTf[tf];
  if (tf === "15m") return session.candles;
  return [];
}
