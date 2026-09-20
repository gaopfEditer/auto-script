/**
 * 形态图量能 / 持仓量 SMA 均线：叠加于同 scale，柱色随相对 MA 偏离加深。
 */
import type { HistogramData, LineData, UTCTimestamp, WhitespaceData } from "lightweight-charts";
import type { PatternCandle } from "../types";

export const VOLUME_MA_PERIOD = 20;
export const OI_MA_PERIOD = 20;
export const NET_BUY_MA_PERIOD = 20;

/** 量能柱超越 MA 时的最大透明度 */
export const VOLUME_ABOVE_MA_ALPHA = 0.5;

export const VOLUME_MA_COLOR = "rgba(255, 213, 79, 0.88)";
export const OI_MA_COLOR = "rgba(255, 183, 77, 0.88)";
export const NET_BUY_MA_COLOR = "rgba(255, 213, 79, 0.88)";

/** 与 pattern 信号口径一致的 SMA（含当前 bar） */
export function smaAt(values: number[], period: number, i: number): number | null {
  if (i + 1 < period) return null;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) sum += values[j];
  return sum / period;
}

/** 稀疏序列 SMA：窗口内跳过 null，凑满 period 个有效点才输出 */
export function smaAtSparse(values: (number | null)[], period: number, i: number): number | null {
  const window: number[] = [];
  for (let j = i; j >= 0 && window.length < period; j--) {
    const v = values[j];
    if (v != null && Number.isFinite(v)) window.unshift(v);
  }
  if (window.length < period) return null;
  return window.reduce((a, b) => a + b, 0) / period;
}

function volumeBarColor(vol: number, ma: number | null, isUp: boolean): string {
  if (ma == null || ma <= 0) {
    return isUp ? "rgba(0, 230, 118, 0.28)" : "rgba(255, 82, 82, 0.28)";
  }
  const ratio = vol / ma;
  if (ratio >= 1) {
    return isUp
      ? `rgba(0, 230, 118, ${VOLUME_ABOVE_MA_ALPHA})`
      : `rgba(255, 82, 82, ${VOLUME_ABOVE_MA_ALPHA})`;
  }
  const dim = Math.max(0.1, 0.28 * Math.max(0.35, ratio));
  return isUp ? `rgba(0, 230, 118, ${dim})` : `rgba(255, 82, 82, ${dim})`;
}

export function buildVolumeMaData(
  candles: PatternCandle[],
  period = VOLUME_MA_PERIOD,
): { bars: HistogramData[]; ma: LineData[] } {
  const vols = candles.map((c) => Math.max(0, c.volume ?? 0));
  const bars: HistogramData[] = [];
  const ma: LineData[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const t = c.time as UTCTimestamp;
    const vol = vols[i];
    const avg = smaAt(vols, period, i);
    bars.push({
      time: t,
      value: vol,
      color: volumeBarColor(vol, avg, c.close >= c.open),
    });
    if (avg != null) ma.push({ time: t, value: avg });
  }
  return { bars, ma };
}

/** 净买入柱（可正可负）的 SMA 均线 */
export function buildSignedHistMaLine(
  hist: Array<LineData | WhitespaceData | HistogramData>,
  period = NET_BUY_MA_PERIOD,
): LineData[] {
  const values: (number | null)[] = hist.map((row) => {
    if (row == null || !("value" in row) || row.value == null) return null;
    const v = Number(row.value);
    return Number.isFinite(v) ? v : null;
  });
  const out: LineData[] = [];
  for (let i = 0; i < hist.length; i++) {
    const avg = smaAtSparse(values, period, i);
    if (avg == null) continue;
    out.push({ time: hist[i].time as UTCTimestamp, value: avg });
  }
  return out;
}

export function buildOiMaLine(
  oi: Array<LineData | WhitespaceData>,
  period = OI_MA_PERIOD,
): LineData[] {
  const values: (number | null)[] = oi.map((row) =>
    row != null && "value" in row && row.value != null && Number.isFinite(Number(row.value))
      ? Number(row.value)
      : null,
  );
  const out: LineData[] = [];
  for (let i = 0; i < oi.length; i++) {
    const avg = smaAtSparse(values, period, i);
    if (avg == null) continue;
    out.push({ time: oi[i].time as UTCTimestamp, value: avg });
  }
  return out;
}

/** 实时更新最后一根量能柱 + MA 点 */
export function volumeLiveUpdate(
  candle: PatternCandle,
  candles: PatternCandle[],
  period = VOLUME_MA_PERIOD,
): { bar: HistogramData; ma: LineData | null } {
  const vol = Math.max(0, candle.volume ?? 0);
  const idx = candles.findIndex((c) => c.time === candle.time);
  const vols = candles.map((c) => Math.max(0, c.volume ?? 0));
  if (idx >= 0) vols[idx] = vol;
  else vols.push(vol);
  const i = idx >= 0 ? idx : vols.length - 1;
  const avg = smaAt(vols, period, i);
  return {
    bar: {
      time: candle.time as UTCTimestamp,
      value: vol,
      color: volumeBarColor(vol, avg, candle.close >= candle.open),
    },
    ma: avg != null ? { time: candle.time as UTCTimestamp, value: avg } : null,
  };
}
