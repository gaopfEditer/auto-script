/**
 * 视口（当前可见 logical 区间）内最高/最低：用于 Lightweight Charts 价线标注。
 * 含未收盘 K（若在视口内），由调用方在 live update 时刷新。
 */
import type { IPriceLine, ISeriesApi, LogicalRange } from "lightweight-charts";
import { LineStyle } from "lightweight-charts";

export const VIEWPORT_HL_HIGH_TITLE = "视口最高";
export const VIEWPORT_HL_LOW_TITLE = "视口最低";
export const VIEWPORT_HL_HIGH_COLOR = "rgba(255, 138, 101, 0.92)";
export const VIEWPORT_HL_LOW_COLOR = "rgba(105, 240, 174, 0.92)";

export type ViewportHlCandle = {
  high: number;
  low: number;
};

export type ViewportHlExtremes = {
  high: number;
  low: number;
  highIndex: number;
  lowIndex: number;
};

/** 与 visibleOiDomain 相同的 logical → 下标约定 */
export function logicalRangeToIndices(
  range: LogicalRange,
  len: number,
): { i0: number; i1: number } | null {
  if (len <= 0) return null;
  const i0 = Math.max(0, Math.floor(range.from));
  const i1 = Math.min(len - 1, Math.ceil(range.to));
  if (i0 > i1) return null;
  return { i0, i1 };
}

export function computeViewportHl(
  candles: ViewportHlCandle[],
  range: LogicalRange | null | undefined,
): ViewportHlExtremes | null {
  if (!range || !candles.length) return null;
  const idx = logicalRangeToIndices(range, candles.length);
  if (!idx) return null;

  let high = -Infinity;
  let low = Infinity;
  let highIndex = idx.i0;
  let lowIndex = idx.i0;

  for (let i = idx.i0; i <= idx.i1; i++) {
    const c = candles[i];
    if (!c) continue;
    const h = Number(c.high);
    const l = Number(c.low);
    if (Number.isFinite(h) && h > high) {
      high = h;
      highIndex = i;
    }
    if (Number.isFinite(l) && l < low) {
      low = l;
      lowIndex = i;
    }
  }

  if (!Number.isFinite(high) || !Number.isFinite(low) || high < low) return null;
  return { high, low, highIndex, lowIndex };
}

export type ViewportHlLinePair = {
  high: IPriceLine | null;
  low: IPriceLine | null;
};

/** 清除视口高低价线（与结构价线分离，避免 clearPriceLines 误伤） */
export function clearViewportHlLines(
  series: ISeriesApi<"Candlestick"> | null | undefined,
  lines: ViewportHlLinePair,
): void {
  if (!series) {
    lines.high = null;
    lines.low = null;
    return;
  }
  if (lines.high) {
    try {
      series.removePriceLine(lines.high);
    } catch {
      /* disposed */
    }
    lines.high = null;
  }
  if (lines.low) {
    try {
      series.removePriceLine(lines.low);
    } catch {
      /* disposed */
    }
    lines.low = null;
  }
}

/**
 * 按当前可见区间刷新「视口最高 / 视口最低」虚线。
 * enabled=false 或无数据时移除价线。
 */
export function syncViewportHlPriceLines(
  series: ISeriesApi<"Candlestick"> | null | undefined,
  lines: ViewportHlLinePair,
  candles: ViewportHlCandle[],
  range: LogicalRange | null | undefined,
  enabled: boolean,
): void {
  if (!series || !enabled) {
    clearViewportHlLines(series, lines);
    return;
  }
  const ext = computeViewportHl(candles, range);
  if (!ext) {
    clearViewportHlLines(series, lines);
    return;
  }

  if (lines.high) {
    try {
      lines.high.applyOptions({ price: ext.high, title: VIEWPORT_HL_HIGH_TITLE });
    } catch {
      lines.high = null;
    }
  }
  if (!lines.high) {
    lines.high = series.createPriceLine({
      price: ext.high,
      color: VIEWPORT_HL_HIGH_COLOR,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: VIEWPORT_HL_HIGH_TITLE,
    });
  }

  if (lines.low) {
    try {
      lines.low.applyOptions({ price: ext.low, title: VIEWPORT_HL_LOW_TITLE });
    } catch {
      lines.low = null;
    }
  }
  if (!lines.low) {
    lines.low = series.createPriceLine({
      price: ext.low,
      color: VIEWPORT_HL_LOW_COLOR,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: VIEWPORT_HL_LOW_TITLE,
    });
  }
}
