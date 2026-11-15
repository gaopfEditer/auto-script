/**
 * 插针 + 放量 + 持仓量异动 — 形态图 markers（lightweight-charts）
 * - 影线长度 ≥ 实体 × WICK_BODY_MIN_RATIO（默认 0.3）
 * - 成交量 ≥ 量均线 × MA_MULT（默认 1.2）
 * - 持仓量 ≥ OI 均线 × MA_MULT（需副图 OI 序列）
 */
import type { PatternCandle, PatternChartMarker } from "../types";
import { OI_MA_PERIOD, smaAt, smaAtSparse, VOLUME_MA_PERIOD } from "./chartMaSeries";
import { closedThroughIndex } from "./confluenceChartMarkers";

export const WICK_BODY_MIN_RATIO = 0.3;
export const WICK_OI_VOL_MA_MULT = 1.2;

export const WICK_PIN_UPPER_COLOR = "#ff7043";
export const WICK_PIN_LOWER_COLOR = "#26c6da";

export const WICK_OI_VOL_MARKER_KINDS = new Set([
  "wick_pin_upper",
  "wick_pin_lower",
]);

function bodySize(o: number, c: number): number {
  return Math.abs(c - o);
}

function upperWick(h: number, o: number, c: number): number {
  return h - Math.max(o, c);
}

function lowerWick(l: number, o: number, c: number): number {
  return Math.min(o, c) - l;
}

export type WickPinSide = "upper" | "lower" | null;

/** 单根 K：是否满足插针 + 放量 + OI 条件 */
export function detectWickOiVolumePin(
  o: number,
  h: number,
  l: number,
  c: number,
  volume: number,
  oi: number | null | undefined,
  volMa: number | null,
  oiMa: number | null,
): WickPinSide {
  const body = bodySize(o, c);
  if (!(body > 0)) return null;
  if (volMa == null || !(volMa > 0) || !(volume >= WICK_OI_VOL_MA_MULT * volMa)) return null;
  if (oi == null || !(oi > 0) || oiMa == null || !(oiMa > 0) || !(oi >= WICK_OI_VOL_MA_MULT * oiMa)) {
    return null;
  }

  const uw = upperWick(h, o, c);
  const lw = lowerWick(l, o, c);
  const minWick = body * WICK_BODY_MIN_RATIO;

  const upperOk = uw >= minWick && uw >= lw;
  const lowerOk = lw >= minWick && lw > uw;
  if (upperOk) return "upper";
  if (lowerOk) return "lower";
  return null;
}

export function buildWickOiVolumePinMarkers(
  candles: PatternCandle[],
  oiByTime?: Map<number, number>,
  opts?: { barDurationMs?: number; nowMs?: number },
): PatternChartMarker[] {
  if (!candles.length || !oiByTime?.size) return [];

  const through = closedThroughIndex(candles, opts?.barDurationMs, opts?.nowMs);
  if (through < 0) return [];

  const volumes = candles.map((c) => Number(c.volume ?? 0));
  /** @type {(number | null)[]} */
  const oiSeries = [];
  let lastOi: number | null = null;
  for (const c of candles) {
    const raw = oiByTime.get(c.time);
    if (raw != null && Number.isFinite(raw) && raw > 0) lastOi = raw;
    oiSeries.push(lastOi);
  }

  const markers: PatternChartMarker[] = [];
  for (let i = 0; i <= through; i++) {
    const c = candles[i];
    const volMa = smaAt(volumes, VOLUME_MA_PERIOD, i);
    const oiMa = smaAtSparse(oiSeries, OI_MA_PERIOD, i);
    const side = detectWickOiVolumePin(
      c.open,
      c.high,
      c.low,
      c.close,
      volumes[i],
      oiSeries[i],
      volMa,
      oiMa,
    );
    if (!side) continue;
    if (side === "upper") {
      markers.push({
        time: c.time,
        position: "aboveBar",
        color: WICK_PIN_UPPER_COLOR,
        shape: "arrowDown",
        text: "上插针·放量OI",
        price: c.high,
        kind: "wick_pin_upper",
      });
    } else {
      markers.push({
        time: c.time,
        position: "belowBar",
        color: WICK_PIN_LOWER_COLOR,
        shape: "arrowUp",
        text: "下插针·放量OI",
        price: c.low,
        kind: "wick_pin_lower",
      });
    }
  }
  return markers;
}