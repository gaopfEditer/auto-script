import type { CapitalConfig, TrainConfig, TrainPresetId } from "./types";

export const DEFAULT_CAPITAL: CapitalConfig = {
  initialBalance: 10_000,
  defaultOrderUsdt: 100,
  feeRate: 0.0004,
  allowChangePerTrade: true,
  maxRiskPct: 2,
  requireStopLoss: false,
  leverage: 20,
};

export const DEFAULT_TRAIN_CONFIG: TrainConfig = {
  symbols: ["BTCUSDT", "ETHUSDT"],
  timeframes: ["15m", "1h", "4h"],
  lookbackBars: 200,
  sessionBars: 200,
  extendThresholdBars: 50,
  randomizeSymbol: true,
  randomizeTimeframe: false,
  randomizeStart: true,
  hideSymbol: true,
  hideDate: true,
  preset: "full",
  indicators: {
    ma: [20, 60],
    volume: true,
    extraOff: true,
  },
  capital: { ...DEFAULT_CAPITAL },
};

export function indicatorsForPreset(preset: TrainPresetId): TrainConfig["indicators"] {
  if (preset === "naked") {
    return { ma: [], volume: true, extraOff: true };
  }
  if (preset === "full") {
    return { ma: [20, 60], volume: true, extraOff: false };
  }
  return { ma: [20, 60], volume: true, extraOff: true };
}

export function sessionTaggedWithHints(preset: TrainPresetId): boolean {
  return preset === "full";
}
