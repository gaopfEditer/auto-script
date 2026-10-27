import type { Candle, TrainDisplayTf, TrainSession } from "./types";

export const TRAIN_DISPLAY_TFS = ["15m", "1h", "4h"] as const satisfies readonly TrainDisplayTf[];

export function sessionCutTs(session: TrainSession): number {
  const idx = Math.min(session.visibleCount, session.candles.length) - 1;
  return session.candles[Math.max(0, idx)]?.t ?? 0;
}

export function visibleCountForCandles(candles: Candle[], cutTs: number, revealAll: boolean): number {
  if (revealAll) return candles.length;
  if (!cutTs) return Math.min(1, candles.length);
  let n = 0;
  for (const c of candles) {
    if (c.t <= cutTs) n++;
    else break;
  }
  return Math.max(1, Math.min(n, candles.length));
}

export function candlesForTf(session: TrainSession, tf: TrainDisplayTf): Candle[] {
  const byTf = session.candlesByTf;
  if (byTf?.[tf]?.length) return byTf[tf];
  if (tf === "15m" || session.timeframe === tf) return session.candles;
  return [];
}

export function visibleCount15mForCutTs(session: TrainSession, cutTs: number): number {
  let n = 0;
  for (const c of session.candles) {
    if (c.t <= cutTs) n++;
    else break;
  }
  return Math.max(1, Math.min(n, session.candles.length));
}

/** 在当前周期上再走 steps 根，换算成 15m visibleCount 目标 */
export function target15mVisibleAfterTfSteps(
  session: TrainSession,
  tf: TrainDisplayTf,
  steps: number,
): number | null {
  if (steps <= 0) return session.visibleCount;
  const candlesTf = candlesForTf(session, tf);
  if (!candlesTf.length) return null;

  const cutTs = sessionCutTs(session);
  const visTf = visibleCountForCandles(candlesTf, cutTs, false);
  const nextVisTf = Math.min(candlesTf.length, visTf + steps);
  if (nextVisTf <= visTf) return null;

  const newCutTs = candlesTf[nextVisTf - 1]?.t;
  if (newCutTs == null) return null;
  return visibleCount15mForCutTs(session, newCutTs);
}

export function canAdvanceTf(session: TrainSession, tf: TrainDisplayTf): boolean {
  if (session.visibleCount >= session.candles.length) return false;
  return target15mVisibleAfterTfSteps(session, tf, 1) != null;
}

export function tfVisibleBarIndex(session: TrainSession, tf: TrainDisplayTf): number {
  const candlesTf = candlesForTf(session, tf);
  if (!candlesTf.length) return 0;
  const cutTs = sessionCutTs(session);
  return visibleCountForCandles(candlesTf, cutTs, false) - 1;
}
