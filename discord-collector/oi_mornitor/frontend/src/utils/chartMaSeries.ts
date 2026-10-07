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
/** OI 副图持仓柱（与蓝线 OI、黄线 MA 同 scale） */
export const OI_BAR_COLOR = "rgba(0, 230, 118, 0.42)";

export type OiPanelAxis = {
  axisBottom: number;
  axisTop: number;
  flat: boolean;
  yMin: number;
  yMax: number;
};

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

/** 可见 logical 区间内 OI + MA 的 min/max（不用全历史） */
export function visibleOiDomain(
  logicalFrom: number,
  logicalTo: number,
  oi: Array<LineData | WhitespaceData>,
  ma: LineData[],
): { yMin: number; yMax: number } | null {
  if (!oi.length) return null;
  const i0 = Math.max(0, Math.floor(logicalFrom));
  const i1 = Math.min(oi.length - 1, Math.ceil(logicalTo));
  if (i0 > i1) return null;

  const maByTime = new Map<number, number>();
  for (const p of ma) {
    if (Number.isFinite(p.value)) maByTime.set(p.time as number, p.value);
  }

  let yMin = Infinity;
  let yMax = -Infinity;
  const ingest = (v: number) => {
    if (!Number.isFinite(v)) return;
    yMin = Math.min(yMin, v);
    yMax = Math.max(yMax, v);
  };

  for (let i = i0; i <= i1; i++) {
    const row = oi[i];
    if (row != null && "value" in row && row.value != null) {
      ingest(Number(row.value));
    }
    const t = row?.time as number | undefined;
    if (t != null && maByTime.has(t)) ingest(maByTime.get(t)!);
  }

  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
  return { yMin, yMax };
}

/**
 * yMin/yMax → 轴下沿/上沿；yMax==yMin 时不做比例除法，柱子在 rebuild 时画半高。
 */
export function computeOiPanelAxis(yMin: number, yMax: number): OiPanelAxis {
  const flat = yMin === yMax;
  if (flat) {
    const eps = Math.max(Math.abs(yMin) * 0.05, 1);
    const axisBottom = yMin - eps;
    const axisTop = yMax + eps;
    return { axisBottom, axisTop, flat: true, yMin, yMax };
  }
  const pad = (yMax - yMin) * 0.05;
  return {
    axisBottom: yMin - pad,
    axisTop: yMax + pad,
    flat: false,
    yMin,
    yMax,
  };
}

/** 柱从 axisBottom 起画；flat 时整窗半高，否则 value=原始 OI */
export function buildOiHistogramBars(
  oi: Array<LineData | WhitespaceData>,
  axis: OiPanelAxis,
): Array<HistogramData | WhitespaceData> {
  const span = axis.axisTop - axis.axisBottom;
  const halfVal = axis.axisBottom + 0.5 * span;
  return oi.map((row) => {
    const t = row.time as UTCTimestamp;
    if (!("value" in row) || row.value == null) {
      return { time: t };
    }
    const raw = Number(row.value);
    const value = axis.flat ? halfVal : raw;
    return {
      time: row.time as UTCTimestamp,
      value,
      color: OI_BAR_COLOR,
    };
  });
}

export function oiAutoscaleForVisibleRange(
  logicalFrom: number,
  logicalTo: number,
  oi: Array<LineData | WhitespaceData>,
  ma: LineData[],
): { priceRange: { minValue: number; maxValue: number } } | null {
  const domain = visibleOiDomain(logicalFrom, logicalTo, oi, ma);
  if (!domain) return null;
  const axis = computeOiPanelAxis(domain.yMin, domain.yMax);
  return {
    priceRange: { minValue: axis.axisBottom, maxValue: axis.axisTop },
  };
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
