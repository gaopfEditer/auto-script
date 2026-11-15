/**
 * 量价特征（rolling 20）— 对齐后端 volume_price/features.py，无未来函数。
 */
import type { PatternCandle } from "../types";

export const VP_FEATURE_WINDOW = 20;

export type VpBarFeatures = {
  volMa: number | null;
  volZ: number | null;
  efficiency: number | null;
  rangeZ: number | null;
  bodySign: -1 | 0 | 1;
};

function rollingMeanStd(
  values: number[],
  i: number,
  window: number,
): { mean: number | null; std: number | null } {
  if (i + 1 < window) return { mean: null, std: null };
  let sum = 0;
  for (let j = i - window + 1; j <= i; j++) sum += values[j];
  const mean = sum / window;
  let sq = 0;
  for (let j = i - window + 1; j <= i; j++) {
    const d = values[j] - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / window);
  return { mean, std: std > 0 ? std : null };
}

/** 单根 K 的量价特征（下标 i 须 ≥ WINDOW-1 才有 vol_z）。 */
export function vpFeaturesAt(candles: PatternCandle[], i: number): VpBarFeatures {
  const c = candles[i];
  const range = Math.max(0, c.high - c.low);
  const body = c.close - c.open;
  const bodyAbs = Math.abs(body);
  const efficiency = range > 0 ? bodyAbs / range : null;
  const bodySign: -1 | 0 | 1 = body > 0 ? 1 : body < 0 ? -1 : 0;

  const volumes = candles.map((x) => Number(x.volume ?? 0));
  const ranges = candles.map((x) => Math.max(0, x.high - x.low));
  const { mean: volMa, std: volStd } = rollingMeanStd(volumes, i, VP_FEATURE_WINDOW);
  const { mean: rangeMa, std: rangeStd } = rollingMeanStd(ranges, i, VP_FEATURE_WINDOW);

  const vol = volumes[i];
  const volZ =
    volMa != null && volStd != null ? (vol - volMa) / volStd : volMa != null && volMa > 0 ? (vol - volMa) / volMa : null;
  const rangeZ = rangeMa != null && rangeStd != null ? (range - rangeMa) / rangeStd : null;

  return { volMa, volZ, efficiency, rangeZ, bodySign };
}

export function vpFeatureSeries(candles: PatternCandle[]): VpBarFeatures[] {
  return candles.map((_, i) => vpFeaturesAt(candles, i));
}