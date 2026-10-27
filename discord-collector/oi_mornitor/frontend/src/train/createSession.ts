import { DEFAULT_TRAIN_CONFIG, indicatorsForPreset, sessionTaggedWithHints } from "./defaults";
import { attachHigherTimeframes, buildSessionCandles, resolveSessionParams } from "./randomSegment";
import type { TrainConfig, TrainSession } from "./types";

export async function createTrainSession(
  config: TrainConfig,
  overrides?: { symbol?: string; timeframe?: TrainConfig["timeframes"][number] },
): Promise<TrainSession> {
  const merged: TrainConfig = {
    ...DEFAULT_TRAIN_CONFIG,
    ...config,
    indicators: { ...indicatorsForPreset(config.preset), ...config.indicators },
    capital: { ...config.capital },
  };
  const params = resolveSessionParams(merged);
  const symbol = overrides?.symbol || params.symbol;
  const timeframe = overrides?.timeframe || "15m";

  const { candles, startTs, resolvedSymbol } = await buildSessionCandles(
    merged,
    symbol,
    timeframe,
  );

  const higher = await attachHigherTimeframes(resolvedSymbol, candles);
  const candlesByTf = {
    "15m": candles,
    ...higher,
  };

  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `train-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    symbol: resolvedSymbol,
    timeframe,
    startTs,
    visibleCount: merged.lookbackBars,
    candles,
    candlesByTf,
    judgments: [],
    trades: [],
    status: "running",
    createdAt: Date.now(),
    config: merged,
    capital: { ...merged.capital },
    balance: merged.capital.initialBalance,
    skipJudgmentCount: 0,
    taggedWithHints: sessionTaggedWithHints(merged.preset),
  };
}
